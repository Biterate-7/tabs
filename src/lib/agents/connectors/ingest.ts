import { normalizeUrl } from "@/lib/tabs/normalize";
import { logConnectorEvent } from "./observability";
import type { AgentProviderId, ConnectorObservation } from "./types";

/**
 * Turning a connector's observations into agent domain state.
 *
 * Provider-neutral, and that is the requirement being met: the application
 * never learns what a Claude transcript record, a Codex log line or a Gemini
 * session file looks like. By the time anything reaches this module it is an
 * `AgentAdapterObservation` — the same shape from every provider — and what
 * happens next is identical regardless of which one sent it.
 *
 * Deliberately not a hook. These are plain functions over a store-shaped
 * interface, so the ingestion rules are testable without React and shared by
 * every provider binding rather than reimplemented per provider. The
 * provider-specific part of a binding is then only *policy*: which workspace
 * a session belongs to, and which tabs exist to link against.
 *
 * Every domain rule stays in the domain. Run identity, terminal-state
 * protection, event retention, sticky metadata, work-item folding and the
 * workspace boundary are all reached through `store.ingest` and
 * `store.addRunLink` — nothing here reimplements one.
 */

/**
 * The part of `useAgentStore` ingestion needs.
 *
 * A structural subset rather than the whole store, so a test can supply five
 * functions instead of a React hook, and so it is obvious by inspection that
 * ingestion cannot reach a mutation it has no business calling.
 */
export type IngestStore = {
  getState(): {
    agents: { id: string; provider: string }[];
    runs: { id: string; agentId: string; externalId?: string; workspaceId: string }[];
  };
  createAgent(input: { provider: string; name: string }): unknown;
  ingest(agentId: string, observation: ConnectorObservation): unknown;
  addRunLink(input: {
    runId: string;
    tabId: string;
    role: "context" | "produced";
    tabWorkspaceId: string;
  }): unknown;
};

/** Tabs of one workspace, by normalized URL — for exact-match context linking. */
export type WorkspaceTabIndex = {
  workspaceId: string;
  tabsByNormalizedUrl: Map<string, string>;
};

/**
 * Finds the single Agent identity for a provider, creating it only if absent.
 *
 * One Agent per provider, many runs beneath it — never one Agent per session,
 * which would make "how much has this agent done here" unanswerable and grow
 * the registry without bound.
 *
 * Reads through `getState` rather than a rendered array because an agent
 * created moments ago in this same batch is already in the live state but not
 * yet in the render, and attributing the rest of the batch to it is the whole
 * reason an id is resolved up front.
 */
export function resolveProviderAgentId(
  store: IngestStore,
  provider: AgentProviderId,
  displayName: string
): string | null {
  const existing = store.getState().agents.find((agent) => agent.provider === provider);
  if (existing) return existing.id;

  const failure = store.createAgent({ provider, name: displayName });
  if (failure) return null;

  return store.getState().agents.find((agent) => agent.provider === provider)?.id ?? null;
}

export type IngestBatchInput = {
  store: IngestStore;
  agentId: string;
  provider: AgentProviderId;
  observations: ConnectorObservation[];
  /**
   * Which workspace a session belongs to, given its `projectKey`.
   *
   * The one genuinely per-provider policy, injected rather than inferred.
   * Returning undefined is a normal outcome and the correct one when nothing
   * says where a session belongs: the domain then reports it as `unattached`
   * and creates nothing, preserving the discovery without inventing a home
   * for it.
   */
  resolveWorkspaceId?: (observation: ConnectorObservation) => string | undefined;
  /** Tab indexes per workspace. Omit to skip URL linking entirely. */
  tabIndexes?: WorkspaceTabIndex[];
};

/**
 * Folds a batch of observations into the domain.
 *
 * Per observation: attach a workspace if policy knows one, hand it to the
 * domain, then link an observed URL to an existing tab if one matches
 * exactly. Order matters — the run must exist before anything can link to it,
 * and it may have been created by an earlier observation in this same batch,
 * which is why the run lookup goes through live state.
 */
export function ingestObservationBatch(input: IngestBatchInput): void {
  const { store, agentId, provider, observations, resolveWorkspaceId, tabIndexes } = input;
  if (observations.length === 0) return;

  for (const raw of observations) {
    const workspaceId = raw.workspaceId ?? resolveWorkspaceId?.(raw);
    const observation: ConnectorObservation = workspaceId ? { ...raw, workspaceId } : raw;

    store.ingest(agentId, observation);

    if (!observation.url || !observation.workspaceId) continue;

    const run = store
      .getState()
      .runs.find(
        (candidate) =>
          candidate.agentId === agentId && candidate.externalId === observation.externalId
      );
    if (run) linkObservedUrl(store, run.id, run.workspaceId, observation.url, tabIndexes);
  }

  logConnectorEvent({ event: "connector.ingested", provider, count: observations.length });
}

/**
 * Links an observed URL to an existing tab, when one matches exactly.
 *
 * Exact normalized match only, within the run's own workspace, using
 * Hubble's existing `normalizeUrl` so an agent visiting a saved page links to
 * the same tab the user would have. No tab is ever created, and no fuzzy
 * matching is attempted: a near-miss link is worse than no link, because it
 * asserts a relationship that did not happen.
 */
export function linkObservedUrl(
  store: IngestStore,
  runId: string,
  workspaceId: string,
  rawUrl: string,
  tabIndexes?: WorkspaceTabIndex[]
): void {
  if (!tabIndexes) return;

  const index = tabIndexes.find((entry) => entry.workspaceId === workspaceId);
  if (!index) return;

  let normalized: string;
  try {
    normalized = normalizeUrl(new URL(rawUrl));
  } catch {
    return;
  }

  const tabId = index.tabsByNormalizedUrl.get(normalized);
  if (!tabId) return;

  // Through the domain, never around it: addRunLink is what enforces that the
  // tab and the run share a workspace.
  store.addRunLink({ runId, tabId, role: "context", tabWorkspaceId: workspaceId });
}
