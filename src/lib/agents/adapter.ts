import { recordArtifactWork } from "./artifacts";
import { appendRunEvent } from "./events";
import { createRun, findRunByExternalId, transitionRunStatus, updateRun } from "./runs";
import { agentFailure, isTerminalRunStatus, normalizeSummary } from "./types";
import { recordWorkItemEvidence } from "./work-item-evidence";
import {
  createWorkItem,
  findWorkItemByExternalId,
  transitionWorkItem,
  updateWorkItem,
} from "./work-items";
import type {
  AgentFailure,
  AgentRun,
  AgentRunArtifactRole,
  AgentRunStatus,
  AgentState,
  AgentWorkItemProgress,
  AgentWorkItemStatus,
} from "./types";

/**
 * The seam a provider integration plugs into.
 *
 * This interface is READ-ONLY on purpose, and the omissions are the design.
 * There is no `start`, `stop`, `kill`, `prompt`, `sendMessage`, `exec` or
 * `run` here, and none may be added: Hubble observes agents, it does not
 * drive them. An adapter that could control a coding agent would make this
 * app a remote-execution surface for anything that could reach its state,
 * which is a categorically different and much more dangerous product than
 * the one being built.
 *
 * Everything an adapter knows arrives as AgentAdapterObservation — a small,
 * already-sanitised record. The reduction from provider-specific data to that
 * record happens on the provider's side of this boundary, so the domain never
 * sees a transcript, a prompt, a tool result or a command.
 */

/**
 * One file an observation says a run worked on.
 *
 * `relativePath` is expected to already be project-relative; it is
 * nonetheless re-normalised during ingestion, because "the provider promised"
 * is not a boundary. A path that turns out to escape its project is dropped
 * rather than stored.
 */
export type AgentArtifactObservation = {
  /** The project root the path belongs to. */
  projectPath: string;
  /** Path within that project, forward-slashed. */
  relativePath: string;
  role: AgentRunArtifactRole;
  /** Provider-stable id of the record this came from, for event deduplication. */
  sourceId?: string;
  /**
   * The work item this file operation was explicitly observed to belong to.
   *
   * Present only when the provider can say *which task* a file was touched
   * for, from its own transcript structure. It carries the provider's
   * `ObservedWorkItem.externalId`, to be resolved during ingestion against
   * the items this run already has — a value matching nothing records no
   * evidence, which is the fail-closed behaviour.
   *
   * Absent is the overwhelmingly common case, and it means exactly one
   * thing: nothing observed which task this was for. It is never an
   * invitation to derive one from the run that the artifact and the work
   * item happen to share. See the note on the deliberately absent
   * `work-item -> artifact` relationship in intelligence/types.ts.
   */
  workItemExternalId?: string;
};

/**
 * One thing an adapter noticed about one provider session.
 *
 * Every field beyond `provider` and `externalId` is optional because
 * observation is incremental: a poll that learns only "still working" says
 * only that, and must not be read as "and the title is now empty". See
 * ingestObservation, which treats absent fields as no news.
 */
export type AgentAdapterObservation = {
  /** Opaque provider key, matching the Agent this adapter speaks for. */
  provider: string;
  /** The provider's stable session identity. The domain matches on it, never parses it. */
  externalId: string;
  /**
   * The workspace this session belongs to, if the caller has an explicit
   * mapping for it.
   *
   * Absent means "discovered but unattached" — the session is real, but
   * nothing says which workspace owns it. ingestObservation will not guess:
   * an unattached observation creates no run. Attaching it later is a matter
   * of supplying this field on a subsequent observation.
   */
  workspaceId?: string;
  status?: AgentRunStatus;
  title?: string;
  /** A short, already-safe activity line. Never a command, a prompt or a tool result. */
  activity?: string;
  /**
   * An opaque key identifying the session's project, for the caller's own
   * workspace mapping.
   *
   * Explicitly NOT a filesystem path. A provider that knows an absolute path
   * should hash or otherwise key it before putting it here, so that local
   * directory layout does not travel with the observation.
   */
  projectKey?: string;
  /** Branch name, when the provider already knows it. Never obtained by running git. */
  gitBranch?: string;
  /** Stable id of the source record, so re-observing it does not duplicate history. */
  sourceId?: string;
  /**
   * Files this observation says the run worked on.
   *
   * Optional and plural: one tool invocation may legitimately touch several
   * files, and most touch none. Paths arrive already reduced to
   * project-relative form by the provider — an adapter that cannot express a
   * path that way omits it rather than sending an absolute one.
   *
   * Still only metadata. There is no field here for contents, a diff or a
   * size, and there is nowhere downstream that would accept one.
   */
  artifacts?: AgentArtifactObservation[];
  /**
   * Units of work this observation says the run is doing.
   *
   * Optional, and absent far more often than present: most providers cannot
   * express work-item semantics at all, and most observations from one that
   * can carry none. An absent list means "no news about work items" — never
   * "this run has no work", and never an occasion to close the ones already
   * known. See applyWorkItems.
   */
  workItems?: ObservedWorkItem[];
  /**
   * A URL the session referenced.
   *
   * Left as a URL rather than a tab id because resolving one to an existing
   * tab needs the workspace's tabs, which this domain does not import. The
   * caller resolves it and calls addRunLink; an unmatched URL links nothing.
   */
  url?: string;
  /** When the observation happened, epoch ms. Falls back to the ingest clock if absent. */
  observedAt?: number;
};

/**
 * One unit of work an observation says the run is doing.
 *
 * Provider-neutral, and small on purpose. What is NOT here is the design:
 * there is no field for a prompt, a command, an argument list, a tool input,
 * a plan's raw text or a model's reasoning, so a provider integration has
 * nowhere to put one even by accident.
 *
 * `title` is optional, and the rule around it is the important part: an
 * observation with no title can only ever *update* an item that already
 * exists — it can never create one. That is what lets a provider report
 * "task 3 is now complete" on a later poll than the one that named task 3,
 * without either inventing a placeholder name or losing the update. An entry
 * with neither a title nor a match is dropped, which is the fail-closed
 * behaviour: no evidence, no work item.
 */
export type ObservedWorkItem = {
  /**
   * The provider's own id for this item, scoped to the session.
   *
   * What makes repeated observation idempotent: the same task seen on three
   * polls updates one work item rather than minting three. A provider that
   * cannot supply a stable id omits it — and then each observation is treated
   * as a fresh item, which is why every provider that can, should.
   */
  externalId?: string;
  /** Absent means "no name in this observation" — see the note above. */
  title?: string;
  summary?: string;
  status?: AgentWorkItemStatus;
  /**
   * Explicit, counted progress — never a guess.
   *
   * A provider that does not literally count something leaves this undefined.
   * See normalizeWorkItemProgress: a ratio that fails validation is dropped
   * rather than clamped, so a provider bug cannot become a false claim that
   * work is finished.
   */
  progress?: AgentWorkItemProgress;
};

export type AgentObserver = (observations: AgentAdapterObservation[]) => void;

export type AgentAdapterUnsubscribe = () => void;

/**
 * A provider integration.
 *
 * Two members, and there is no room for a third that acts on the agent.
 * `subscribe` hands observations to an observer and returns the function that
 * stops the flow; an adapter must clean up everything it started when that is
 * called.
 */
export interface AgentAdapter {
  readonly provider: string;
  subscribe(observer: AgentObserver): AgentAdapterUnsubscribe;
}

export type IngestObservationInput = {
  /** The Agent identity this observation belongs to — resolved by the caller from `provider`. */
  agentId: string;
  observation: AgentAdapterObservation;
  now: number;
};

/**
 * What ingesting an observation did.
 *
 * `unattached` is a success, not a failure: the session was seen, and
 * declining to invent a workspace for it is the correct outcome.
 */
export type IngestOutcome = "created" | "updated" | "unattached";

export type IngestObservationResult =
  | { ok: true; state: AgentState; run?: AgentRun; outcome: IngestOutcome }
  | AgentFailure;

/**
 * Folds one observation into the domain.
 *
 * The provider-agnostic half of what a later phase's poller does, kept here
 * so that every adapter gets the same identity, stickiness and terminal-state
 * behaviour rather than each reimplementing it:
 *
 *   - identity is (agentId, externalId), so observing the same session
 *     repeatedly updates one run instead of minting a new one;
 *   - absent fields are no news and never erase what is already known;
 *   - a terminal run stops taking status changes, but still accepts events,
 *     because its history is still being written even though its life is not;
 *   - an observation with no workspace creates nothing.
 */
export function ingestObservation(
  state: AgentState,
  input: IngestObservationInput
): IngestObservationResult {
  const { agentId, observation, now } = input;
  const externalId = observation.externalId.trim();
  if (!externalId) return agentFailure("invalid-input");

  const observedAt = Number.isFinite(observation.observedAt) ? observation.observedAt! : now;
  const existing = findRunByExternalId(state, agentId, externalId);

  if (!existing) {
    const workspaceId = observation.workspaceId?.trim();
    // Discovered, but nothing says where it belongs. Guessing here — from the
    // active workspace, a name match, or the nearest anything — is exactly
    // the inference that would file a stranger's work under the user's.
    if (!workspaceId) return { ok: true, state, outcome: "unattached" };

    const created = createRun(
      state,
      {
        agentId,
        workspaceId,
        externalId,
        title: observation.title,
        status: observation.status ?? "working",
      },
      now
    );
    if (!created.ok) return created;

    let next = created.state;
    const started = appendRunEvent(next, {
      runId: created.run.id,
      kind: "started",
      summary: observation.title?.trim() || "Session started",
      timestamp: observedAt,
    });
    if (started.ok) next = started.state;

    next = applyActivity(next, created.run.id, observation, observedAt, now);
    // Work items before artifacts: an artifact carrying an attribution is
    // resolved against the items this run holds, so an observation that
    // introduces a task and evidences it in one go must create the task
    // first. Nothing in the other direction depends on this order.
    next = applyWorkItems(next, created.run.id, observation, now);
    next = applyArtifacts(next, created.run.id, observation, now);
    return { ok: true, state: next, run: findRun(next, created.run.id), outcome: "created" };
  }

  let next = state;

  // Metadata first: a run that is about to end should still record the title
  // and activity the same observation carried.
  const patched = updateRun(
    next,
    existing.id,
    { title: observation.title, currentActivity: observation.activity },
    now
  );
  if (patched.ok) next = patched.state;

  if (observation.status && observation.status !== existing.status) {
    const moved = transitionRunStatus(next, existing.id, observation.status, now);
    // A refused transition is not an ingest failure — a finished run being
    // re-reported as working is a stale observation, not a corrupt one, and
    // the rest of the observation is still worth keeping.
    if (moved.ok) {
      next = moved.state;
      const ended = isTerminalRunStatus(observation.status);
      const noted = appendRunEvent(next, {
        runId: existing.id,
        kind: ended ? "ended" : "status",
        summary: ended ? `Run ${observation.status}` : `Now ${observation.status}`,
        timestamp: observedAt,
      });
      if (noted.ok) next = noted.state;
    }
  }

  next = applyActivity(next, existing.id, observation, observedAt, now);
  // See the note on the create path: attribution needs the task to exist.
  next = applyWorkItems(next, existing.id, observation, now);
  next = applyArtifacts(next, existing.id, observation, now);
  return { ok: true, state: next, run: findRun(next, existing.id), outcome: "updated" };
}

/**
 * Folds an observation's work items into the domain.
 *
 * The rules that matter here are all about NOT inventing things:
 *
 *   - **Identity is (runId, externalId).** Re-observing the same task updates
 *     one item rather than minting another. An observation with no externalId
 *     can only ever create, which is why a provider that has stable ids
 *     should always send them.
 *   - **An absent field is no news.** A poll that reports a title and no
 *     status leaves the status alone; `updateWorkItem` already treats absent
 *     as "keep what you know".
 *   - **A refused transition is not an ingest failure.** A finished item
 *     re-reported as active is a stale observation, not a corrupt one. The
 *     existing state is preserved and the rest of the observation still
 *     applies — the same tolerance the run status path above shows.
 *   - **Nothing is ever closed by omission.** An item missing from this poll's
 *     list is simply an item this poll said nothing about. Completion is
 *     recorded only when a provider explicitly reports it, which is the
 *     Phase 12 rule restated at the work-item level: a session going quiet,
 *     a transcript ending or a task falling out of a list is not evidence
 *     that anything finished.
 */
function applyWorkItems(
  state: AgentState,
  runId: string,
  observation: AgentAdapterObservation,
  now: number
): AgentState {
  if (!observation.workItems?.length) return state;

  let next = state;
  const seen = new Set<string>();

  for (const entry of observation.workItems) {
    const title = entry.title?.trim();
    const externalId = entry.externalId?.trim();

    // One observation naming the same task twice costs one fold, not two.
    if (externalId) {
      if (seen.has(externalId)) continue;
      seen.add(externalId);
    }

    const existing = externalId ? findWorkItemByExternalId(next, runId, externalId) : undefined;

    if (!existing) {
      // Fail closed. An entry with no title and nothing to match is a status
      // for a task this domain has never heard of — most often because the
      // observation that named it fell outside the window a poll read. The
      // honest response is to record nothing, not to mint an item called
      // "Untitled" whose status is the only thing known about it.
      if (!title) continue;

      const created = createWorkItem(
        next,
        {
          runId,
          title,
          summary: entry.summary,
          status: entry.status,
          externalId,
          progress: entry.progress,
        },
        now
      );
      // A refused creation (a run that vanished, a per-run cap reached) costs
      // this item and not the observation.
      if (created.ok) next = created.state;
      continue;
    }

    const patched = updateWorkItem(
      next,
      existing.id,
      {
        title,
        summary: entry.summary,
        // Explicitly undefined rather than null: "this poll carried no
        // progress" must not erase a count an earlier poll established.
        progress: entry.progress,
      },
      now
    );
    if (patched.ok) next = patched.state;

    if (entry.status && entry.status !== existing.status) {
      const moved = transitionWorkItem(next, existing.id, entry.status, now);
      if (moved.ok) next = moved.state;
    }
  }

  return next;
}

/**
 * Records the files an observation says the run worked on.
 *
 * Each entry is resolved into the run's own workspace and linked, through
 * `recordArtifactWork` — so the workspace boundary and the path check are
 * enforced by the domain rather than restated here.
 *
 * A rejected entry is skipped silently and individually. A path that escapes
 * its project, or names another root, is not an error worth failing an
 * otherwise good observation over: agents read files outside their projects
 * all the time, and those simply are not project work.
 */
function applyArtifacts(
  state: AgentState,
  runId: string,
  observation: AgentAdapterObservation,
  now: number
): AgentState {
  if (!observation.artifacts?.length) return state;

  let next = state;
  const seen = new Set<string>();

  for (const entry of observation.artifacts) {
    const projectPath = entry.projectPath?.trim();
    const relativePath = entry.relativePath?.trim();
    if (!projectPath || !relativePath) continue;

    // One tool call naming the same file twice costs one resolution, not two.
    // The attribution is part of the key because this loop now writes two
    // things: collapsing on (path, role) alone would silently drop the
    // second of two rows that differ only by which task they belong to.
    const key = `${projectPath}::${relativePath}::${entry.role}::${entry.workItemExternalId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const recorded = recordArtifactWork(
      next,
      { runId, projectPath, path: relativePath, role: entry.role },
      now
    );
    if (!recorded.ok) continue;
    next = recorded.state;

    next = applyArtifactEvidence(next, runId, entry, recorded.artifact.id, now);
  }

  return next;
}

/**
 * Records that a *work item* — not just its run — touched this file.
 *
 * Written here rather than in the provider because `targetId` is a domain
 * id: the artifact is resolved during ingestion, and an adapter never sees
 * one. What the adapter can say is which of its own tasks the operation
 * belonged to, which arrives as `workItemExternalId` and is resolved against
 * the items this run already has.
 *
 * ## Every branch that declines
 *
 * No attribution, or an id matching no item of this run, records nothing —
 * and nothing else is tried. There is no fallback to the run's other work
 * items, to the most recent one, to the only one, or to anything derived
 * from ordering, titles, timestamps or shared run membership. That is the
 * whole point: an evidence row exists because something observed it, and a
 * work item with no rows is a task nothing was recorded for, which every
 * surface renders as "No recorded evidence for this task."
 *
 * `findWorkItemByExternalId` matches on `(runId, externalId)`, so an id that
 * belongs to another run's task cannot resolve here. `recordWorkItemEvidence`
 * then re-checks containment against stored state — the run must already
 * hold this artifact — so this function is the outer of two independent
 * gates rather than the only one.
 */
function applyArtifactEvidence(
  state: AgentState,
  runId: string,
  entry: AgentArtifactObservation,
  artifactId: string,
  now: number
): AgentState {
  const externalId = entry.workItemExternalId?.trim();
  if (!externalId) return state;

  const item = findWorkItemByExternalId(state, runId, externalId);
  if (!item) return state;

  const evidenced = recordWorkItemEvidence(
    state,
    { workItemId: item.id, kind: "artifact", targetId: artifactId },
    now
  );
  // A refused row costs this association and not the observation — the same
  // tolerance every other fold here shows. Re-observing an association the
  // domain already holds returns the existing row unchanged, so repeated
  // polling of the same transcript bytes stays idempotent.
  return evidenced.ok ? evidenced.state : state;
}

/**
 * Records an activity line as an event, if the observation carried one.
 *
 * Separate from the status handling above because it runs on both the create
 * and update paths. `sourceId` is passed straight through, which is what
 * makes re-observing the same source record idempotent.
 */
function applyActivity(
  state: AgentState,
  runId: string,
  observation: AgentAdapterObservation,
  observedAt: number,
  now: number
): AgentState {
  const activity = observation.activity ? normalizeSummary(observation.activity) : "";
  if (!activity) return state;

  let next = state;
  const appended = appendRunEvent(next, {
    runId,
    kind: "activity",
    summary: activity,
    sourceId: observation.sourceId,
    timestamp: observedAt,
  });
  if (appended.ok) next = appended.state;

  const patched = updateRun(next, runId, { currentActivity: activity }, now);
  if (patched.ok) next = patched.state;

  return next;
}

/** Local re-lookup, so the result carries the run as it stands after every fold above. */
function findRun(state: AgentState, runId: string): AgentRun | undefined {
  return state.runs.find((run) => run.id === runId);
}
