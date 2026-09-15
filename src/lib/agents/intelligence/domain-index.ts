import type {
  Agent,
  AgentRun,
  AgentRunArtifactLink,
  AgentRunLink,
  AgentState,
  AgentWorkItem,
  WorkArtifact,
} from "@/lib/agents/types";

/**
 * A grouped, read-only view of `AgentState`, built once per state object.
 *
 * ## Why this exists
 *
 * The domain is stored as flat arrays, which is right for persistence and
 * wrong for the questions this layer asks. Answering "summarise every run in
 * this workspace" directly from those arrays means, for each run, a scan of
 * every work item, every artifact link, every tab link and every event - so a
 * workspace with 10 runs and 100 items does 1,000 comparisons for one number,
 * and does them again on every React render.
 *
 * Grouping once turns that into a lookup. The index is built in a handful of
 * linear passes, and every selector downstream costs only what it returns.
 *
 * ## Why it is not a cache
 *
 * There is no invalidation, no staleness and nothing to keep in sync: the
 * index is a pure function of one `AgentState` value, and `AgentState` is
 * replaced rather than mutated by every domain operation. A consumer memoises
 * it keyed on the state object (see `useAgentIntelligence`), so a new state
 * produces a new index and an unchanged state reuses the old one. That is the
 * whole lifecycle. Adding eviction or a TTL here would be inventing a
 * correctness problem that does not currently exist.
 *
 * ## Where isolation is enforced
 *
 * This is the layer's single choke point, so the boundary checks live here
 * rather than being repeated in six selectors:
 *
 * - a work item whose run is unknown is **dropped** - it has no workspace we
 *   can trust, and guessing one is how a leak starts;
 * - a work item whose `workspaceId` disagrees with its run's is **dropped**,
 *   the same rule persistence applies on load, re-applied because in-memory
 *   state is not a trust boundary either;
 * - an artifact link whose run or artifact is unknown is **dropped**;
 * - an artifact link whose artifact belongs to another workspace than its run
 *   is **dropped**.
 *
 * Every one of those is a fail-closed omission. Nothing is repaired, nothing
 * is re-parented, and nothing is fabricated to stand in for what was dropped.
 */
export type AgentDomainIndex = {
  agentsById: Map<string, Agent>;
  runsById: Map<string, AgentRun>;
  /** Runs grouped by workspace, newest first. The only workspace-keyed entry point. */
  runsByWorkspace: Map<string, AgentRun[]>;
  /** A run's work items, oldest first - plan order, as Phase 15 established. */
  workItemsByRun: Map<string, AgentWorkItem[]>;
  artifactLinksByRun: Map<string, AgentRunArtifactLink[]>;
  tabLinksByRun: Map<string, AgentRunLink[]>;
  artifactsById: Map<string, WorkArtifact>;
  /**
   * The newest event timestamp per run.
   *
   * Reduced to a number during the build rather than keeping the events
   * themselves: `lastActivityAt` is the only thing this layer asks of the
   * event log, and holding 200 events per run to read one timestamp would
   * make the index heavier than the state it indexes.
   */
  latestEventAtByRun: Map<string, number>;
};

/**
 * Builds the index. Linear in the size of the state, plus the group sorts.
 *
 * Pure: it reads `state` and allocates new containers. Nothing here mutates
 * the arrays it is given, so an index can be built from a state another
 * consumer is holding without surprising it.
 */
export function buildAgentDomainIndex(state: AgentState): AgentDomainIndex {
  const agentsById = new Map<string, Agent>();
  for (const agent of state.agents) agentsById.set(agent.id, agent);

  const runsById = new Map<string, AgentRun>();
  const runsByWorkspace = new Map<string, AgentRun[]>();
  for (const run of state.runs) {
    runsById.set(run.id, run);
    push(runsByWorkspace, run.workspaceId, run);
  }
  for (const runs of runsByWorkspace.values()) runs.sort(byNewestRun);

  const artifactsById = new Map<string, WorkArtifact>();
  for (const artifact of state.artifacts) artifactsById.set(artifact.id, artifact);

  // Work items: dropped unless their run is known AND agrees about the
  // workspace. See the isolation note above - both checks are load-bearing.
  const workItemsByRun = new Map<string, AgentWorkItem[]>();
  for (const item of state.workItems) {
    const run = runsById.get(item.runId);
    if (!run) continue;
    if (item.workspaceId !== run.workspaceId) continue;
    push(workItemsByRun, item.runId, item);
  }
  for (const items of workItemsByRun.values()) items.sort(byOldestWorkItem);

  // Artifact links: dropped unless both ends resolve and the file belongs to
  // the same workspace as the run that touched it.
  const artifactLinksByRun = new Map<string, AgentRunArtifactLink[]>();
  for (const link of state.artifactLinks) {
    const run = runsById.get(link.runId);
    if (!run) continue;
    const artifact = artifactsById.get(link.artifactId);
    if (!artifact) continue;
    if (artifact.workspaceId !== run.workspaceId) continue;
    push(artifactLinksByRun, link.runId, link);
  }

  // Tab links carry no workspace of their own; they are reachable only
  // through a run that already has one, so scoping is inherited. A link whose
  // run is gone is dropped for the same reason as above.
  const tabLinksByRun = new Map<string, AgentRunLink[]>();
  for (const link of state.links) {
    if (!runsById.has(link.runId)) continue;
    push(tabLinksByRun, link.runId, link);
  }

  const latestEventAtByRun = new Map<string, number>();
  for (const event of state.events) {
    if (!runsById.has(event.runId)) continue;
    const current = latestEventAtByRun.get(event.runId);
    if (current === undefined || event.timestamp > current) {
      latestEventAtByRun.set(event.runId, event.timestamp);
    }
  }

  return {
    agentsById,
    runsById,
    runsByWorkspace,
    workItemsByRun,
    artifactLinksByRun,
    tabLinksByRun,
    artifactsById,
    latestEventAtByRun,
  };
}

/** An index over nothing. Lets a caller render before any state has loaded. */
export function emptyAgentDomainIndex(): AgentDomainIndex {
  return {
    agentsById: new Map(),
    runsById: new Map(),
    runsByWorkspace: new Map(),
    workItemsByRun: new Map(),
    artifactLinksByRun: new Map(),
    tabLinksByRun: new Map(),
    artifactsById: new Map(),
    latestEventAtByRun: new Map(),
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * Newest first, id breaking ties.
 *
 * The same total order `selectors.ts` uses, and total for the same reason:
 * runs discovered in one pass share a millisecond, and without the tiebreak a
 * list of them would reshuffle between renders for no visible reason.
 */
function byNewestRun(a: AgentRun, b: AgentRun): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Oldest first, id breaking ties - a plan read in the order it was made. */
function byOldestWorkItem(a: AgentWorkItem, b: AgentWorkItem): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
