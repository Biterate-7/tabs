import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { RuntimeCorrelationView } from "./protocol";

/**
 * The correlation registry.
 *
 * ## The distinction this module exists to preserve
 *
 * TabDump learns about agent activity two ways, and they are not the same
 * thing:
 *
 *   **CONTROL** - TabDump asked an agent to do something. It knows the
 *   control session id, the control run id, and eventually the provider's own
 *   session id, because the provider told it on the wire it is holding open.
 *
 *   **OBSERVATION** - TabDump watched an agent do something. It knows the
 *   provider's session id (read off the transcript on disk), the observing
 *   agent's id, and the domain run that ingestion minted. It has no idea who
 *   started it.
 *
 *   **CORRELATION** - evidence that those two descriptions are of the same
 *   provider session. The evidence is the provider session id, and nothing
 *   else: it is the one identifier both planes independently arrive at.
 *
 * The temptation this module is written against is to label observed activity
 * as controlled because it is convenient. A session somebody started in a
 * terminal five minutes ago genuinely has no control run, and a registry that
 * invented one would make the command centre claim TabDump did something it
 * did not do. Every field below is therefore optional, and a record with only
 * the observation half is a *complete, valid* record rather than a partial
 * one waiting to be filled in.
 *
 * ## Why observation does not depend on this
 *
 * Nothing in `lib/agents/adapter.ts`, the ingestion path, or the observation
 * route imports this module, and the guard suite asserts it. Observation must
 * keep working with the control plane switched off entirely - which is the
 * state a hosted deployment is permanently in - so correlation is something a
 * reader *consults*, never something ingestion *needs*.
 *
 * ## Why it is bounded and local
 *
 * It lives in one process's memory, holds identifiers and timestamps only,
 * and is capped. A correlation is worth having while a session is live and
 * worth forgetting afterwards; a registry that grew forever would be a slow
 * leak in a long-running local server, and one that persisted would outlive
 * the sessions it describes.
 */

export type CorrelationOrigin = "control" | "observation";

/**
 * One correlation.
 *
 * Keyed internally by `id`, which is minted here rather than derived from any
 * of the identifiers it holds - because every one of them is optional, and a
 * key derived from a field that may be absent is a key that changes the
 * moment the field arrives.
 */
export type CorrelationRecord = {
  id: string;
  provider: AgentProviderId;
  controlSessionId?: string;
  controlRunId?: string;
  /** The provider's own session id. The only evidence that joins the two planes. */
  providerSessionId?: string;
  observationAgentId?: string;
  observationRunId?: string;
  origin: CorrelationOrigin;
  firstSeenAt: number;
  updatedAt: number;
};

/** What a caller may set. `provider` and `origin` are fixed at registration. */
export type CorrelationPatch = {
  controlSessionId?: string;
  controlRunId?: string;
  providerSessionId?: string;
  observationAgentId?: string;
  observationRunId?: string;
};

export type RegisterCorrelationInput = CorrelationPatch & {
  provider: AgentProviderId;
  origin: CorrelationOrigin;
};

/**
 * The cap.
 *
 * Generous relative to any plausible number of simultaneous sessions, and
 * finite, which is the only property that matters. Eviction is oldest-updated
 * first, so a long-lived session is never dropped in favour of a burst of
 * short ones.
 */
export const MAX_CORRELATIONS = 500;

export type CorrelationRegistry = {
  /**
   * Records a correlation, merging into an existing one when the evidence
   * matches.
   *
   * "Matches" means, in order: the same control session, or the same
   * provider session for the same provider. An input with neither cannot
   * match anything and mints a new record - which is right, because an
   * observation TabDump has no provider session id for is a thing it cannot
   * yet join to anything.
   */
  register(input: RegisterCorrelationInput, now: number): CorrelationRecord;

  /** Adds what is now known to an existing record. Returns undefined for an unknown id. */
  update(id: string, patch: CorrelationPatch, now: number): CorrelationRecord | undefined;

  byId(id: string): CorrelationRecord | undefined;

  /**
   * The control run for an observed provider session, if TabDump started it.
   *
   * The whole point of the registry, and the function the future command
   * centre calls when it renders an observed run. Returns `undefined` for a
   * session nobody controlled, which is the common case and not an error.
   */
  controlRunFor(provider: AgentProviderId, providerSessionId: string): string | undefined;

  byProviderSession(
    provider: AgentProviderId,
    providerSessionId: string
  ): CorrelationRecord | undefined;

  byControlSession(controlSessionId: string): CorrelationRecord[];

  byControlRun(controlRunId: string): CorrelationRecord | undefined;

  byObservationAgent(observationAgentId: string): CorrelationRecord[];

  /** Every record, most recently updated first. */
  list(): CorrelationRecord[];

  /**
   * Forgets every record for a control session.
   *
   * Called when a session is disposed. The observation half is forgotten with
   * it *only* when the record originated in control - an observed session
   * that a control run happened to join keeps its own record, because the
   * agent is still on disk and still worth recognising next poll.
   */
  removeControlSession(controlSessionId: string): number;

  clear(): void;
  size(): number;
};

export function createCorrelationRegistry(options: { createId?: () => string } = {}): CorrelationRegistry {
  let counter = 0;
  const createId = options.createId ?? (() => `corr-${++counter}`);

  const records = new Map<string, CorrelationRecord>();

  /** Applies a patch, ignoring absent fields. Absent is no news; it never erases. */
  function apply(record: CorrelationRecord, patch: CorrelationPatch, now: number): CorrelationRecord {
    let changed = false;
    const next: CorrelationRecord = { ...record };

    for (const key of [
      "controlSessionId",
      "controlRunId",
      "providerSessionId",
      "observationAgentId",
      "observationRunId",
    ] as const) {
      const value = patch[key];
      if (value === undefined || value === "") continue;
      if (next[key] === value) continue;
      next[key] = value;
      changed = true;
    }

    if (!changed) return record;

    next.updatedAt = now;
    records.set(next.id, next);
    return next;
  }

  /** Drops the oldest-updated records until the cap holds. */
  function evict(): void {
    if (records.size <= MAX_CORRELATIONS) return;
    const ordered = [...records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of ordered) {
      if (records.size <= MAX_CORRELATIONS) break;
      records.delete(record.id);
    }
  }

  function findProviderSession(
    provider: AgentProviderId,
    providerSessionId: string
  ): CorrelationRecord | undefined {
    for (const record of records.values()) {
      if (record.provider === provider && record.providerSessionId === providerSessionId) {
        return record;
      }
    }
    return undefined;
  }

  return {
    register(input, now) {
      // Order matters. A control session id is TabDump's own and is exact; a
      // provider session id is the joining evidence and is checked second so
      // that a control record already in hand is extended rather than
      // duplicated when the provider finally reveals its id.
      const existing =
        (input.controlSessionId
          ? [...records.values()].find(
              (record) => record.controlSessionId === input.controlSessionId
            )
          : undefined) ??
        (input.providerSessionId
          ? findProviderSession(input.provider, input.providerSessionId)
          : undefined);

      if (existing) return apply(existing, input, now);

      const record: CorrelationRecord = {
        id: createId(),
        provider: input.provider,
        origin: input.origin,
        firstSeenAt: now,
        updatedAt: now,
      };

      for (const key of [
        "controlSessionId",
        "controlRunId",
        "providerSessionId",
        "observationAgentId",
        "observationRunId",
      ] as const) {
        const value = input[key];
        if (value) record[key] = value;
      }

      records.set(record.id, record);
      evict();
      return record;
    },

    update(id, patch, now) {
      const record = records.get(id);
      return record ? apply(record, patch, now) : undefined;
    },

    byId: (id) => records.get(id),

    controlRunFor(provider, providerSessionId) {
      return findProviderSession(provider, providerSessionId)?.controlRunId;
    },

    byProviderSession: findProviderSession,

    byControlSession(controlSessionId) {
      return [...records.values()].filter(
        (record) => record.controlSessionId === controlSessionId
      );
    },

    byControlRun(controlRunId) {
      for (const record of records.values()) {
        if (record.controlRunId === controlRunId) return record;
      }
      return undefined;
    },

    byObservationAgent(observationAgentId) {
      return [...records.values()].filter(
        (record) => record.observationAgentId === observationAgentId
      );
    },

    list: () => [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt),

    removeControlSession(controlSessionId) {
      let removed = 0;
      for (const record of [...records.values()]) {
        if (record.controlSessionId !== controlSessionId) continue;

        if (record.origin === "observation") {
          // Keep the observation half. The agent is still on disk and the
          // next poll will still recognise it; only the control link goes.
          const stripped: CorrelationRecord = { ...record, updatedAt: record.updatedAt };
          delete stripped.controlSessionId;
          delete stripped.controlRunId;
          records.set(record.id, stripped);
          continue;
        }

        records.delete(record.id);
        removed += 1;
      }
      return removed;
    },

    clear: () => records.clear(),

    size: () => records.size,
  };
}

/** Strips the internal key on the way to a client. The id is this process's bookkeeping, not theirs. */
export function toCorrelationView(record: CorrelationRecord): RuntimeCorrelationView {
  const view: RuntimeCorrelationView = {
    provider: record.provider,
    origin: record.origin,
    firstSeenAt: record.firstSeenAt,
    updatedAt: record.updatedAt,
  };

  if (record.controlSessionId) view.controlSessionId = record.controlSessionId;
  if (record.controlRunId) view.controlRunId = record.controlRunId;
  if (record.providerSessionId) view.providerSessionId = record.providerSessionId;
  if (record.observationAgentId) view.observationAgentId = record.observationAgentId;
  if (record.observationRunId) view.observationRunId = record.observationRunId;

  return view;
}

/**
 * Whether a correlation says TabDump actually drove this activity.
 *
 * A single function so that no consumer has to decide for itself what counts,
 * and so the answer cannot drift into "it has a control session id, close
 * enough". Driving means a run: a session that was created and then failed
 * before a run started did not drive anything.
 */
export function isControlled(record: RuntimeCorrelationView | CorrelationRecord): boolean {
  return typeof record.controlRunId === "string" && record.controlRunId.length > 0;
}

/**
 * The control run behind an observed provider session, from a plain list.
 *
 * The read-side twin of `CorrelationRegistry.controlRunFor`, for a consumer
 * that has views over the wire rather than the registry itself - which is
 * every consumer in the browser. Pure, so the future command centre can call
 * it while rendering without holding a runtime handle.
 */
export function resolveControlRun(
  correlations: readonly RuntimeCorrelationView[],
  provider: AgentProviderId,
  providerSessionId: string
): string | undefined {
  for (const record of correlations) {
    if (record.provider !== provider) continue;
    if (record.providerSessionId !== providerSessionId) continue;
    return record.controlRunId;
  }
  return undefined;
}
