import { selectLatestRunEvent, selectRunEvents } from "./events";
import { LIVE_AGENT_RUN_STATUSES, isTerminalRunStatus } from "./types";
import type {
  Agent,
  AgentEvent,
  AgentRun,
  AgentRunArtifactLink,
  AgentRunArtifactRole,
  AgentRunLink,
  AgentRunLinkRole,
  AgentState,
  AgentWorkItem,
  AgentWorkItemStatus,
  WorkArtifact,
} from "./types";

/**
 * Read-only views over the agent domain.
 *
 * Plain functions of state: no React, no hooks, no memoisation. Consumers
 * that need memoisation wrap these in their own useMemo, which keeps the
 * domain usable from tests and from any future non-React caller.
 */

export function getAgents(state: AgentState): Agent[] {
  return state.agents;
}

/** Every run for one agent, newest first. */
export function getAgentRuns(state: AgentState, agentId: string): AgentRun[] {
  return state.runs.filter((run) => run.agentId === agentId).sort(byNewestFirst);
}

/** Every run in one workspace, newest first. The workspace-scoped view a UI shows. */
export function getWorkspaceRuns(state: AgentState, workspaceId: string): AgentRun[] {
  return state.runs.filter((run) => run.workspaceId === workspaceId).sort(byNewestFirst);
}

/** Runs in a workspace that are still live (working or waiting), newest first. */
export function getActiveRuns(state: AgentState, workspaceId: string): AgentRun[] {
  return getWorkspaceRuns(state, workspaceId).filter((run) =>
    (LIVE_AGENT_RUN_STATUSES as readonly string[]).includes(run.status)
  );
}

/** Runs in a workspace that are over, most recently ended first. */
export function getFinishedRuns(state: AgentState, workspaceId: string): AgentRun[] {
  return getWorkspaceRuns(state, workspaceId).filter((run) => isTerminalRunStatus(run.status));
}

export function getRunLinks(state: AgentState, runId: string): AgentRunLink[] {
  return state.links.filter((link) => link.runId === runId);
}

/** A run's links narrowed to one role — "which tabs did this run produce?". */
export function getRunLinksByRole(
  state: AgentState,
  runId: string,
  role: AgentRunLinkRole
): AgentRunLink[] {
  return state.links.filter((link) => link.runId === runId && link.role === role);
}

/**
 * The runs that touched a given tab.
 *
 * The reverse lookup a tab-side UI needs ("what has an agent done with
 * this?"), which would otherwise mean a scan at every call site.
 */
export function getTabRuns(state: AgentState, tabId: string): AgentRun[] {
  const runIds = new Set(
    state.links.filter((link) => link.tabId === tabId).map((link) => link.runId)
  );
  return state.runs.filter((run) => runIds.has(run.id)).sort(byNewestFirst);
}

/** A run's events, oldest first, defensively capped. */
export function getRunEvents(state: AgentState, runId: string): AgentEvent[] {
  return selectRunEvents(state, runId);
}

/**
 * What a run is doing, as one line.
 *
 * Prefers the run's own `currentActivity` — which an observer keeps current
 * and deliberately does not clear when an update carries no news — and falls
 * back to the newest event's summary. Returns undefined rather than a
 * placeholder so the caller decides how "nothing yet" should read.
 */
export function getRunActivity(state: AgentState, runId: string): string | undefined {
  const run = state.runs.find((r) => r.id === runId);
  if (run?.currentActivity) return run.currentActivity;
  return selectLatestRunEvent(state, runId)?.summary;
}

/** Counts for a workspace, for a summary strip. Computed in one pass over runs. */
export function getWorkspaceRunCounts(
  state: AgentState,
  workspaceId: string
): { total: number; active: number; finished: number } {
  let total = 0;
  let active = 0;

  for (const run of state.runs) {
    if (run.workspaceId !== workspaceId) continue;
    total += 1;
    if (!isTerminalRunStatus(run.status)) active += 1;
  }

  return { total, active, finished: total - active };
}

/** Every file this run worked on, most recently worked on first. */
export function getArtifactsForRun(state: AgentState, runId: string): WorkArtifact[] {
  const artifactIds = new Set(
    state.artifactLinks.filter((link) => link.runId === runId).map((link) => link.artifactId)
  );
  return state.artifacts
    .filter((artifact) => artifactIds.has(artifact.id))
    .sort(byRecentlyWorked);
}

/** A run's artifact links, including their roles. */
export function getArtifactLinksForRun(state: AgentState, runId: string): AgentRunArtifactLink[] {
  return state.artifactLinks.filter((link) => link.runId === runId);
}

/** A run's links narrowed to one role — "which files did this run edit?". */
export function getArtifactLinksForRunByRole(
  state: AgentState,
  runId: string,
  role: AgentRunArtifactRole
): AgentRunArtifactLink[] {
  return state.artifactLinks.filter((link) => link.runId === runId && link.role === role);
}

/**
 * The runs that worked on a file, newest first.
 *
 * The reverse lookup a file-side view needs: "what has been done to this?".
 */
export function getRunsForArtifact(state: AgentState, artifactId: string): AgentRun[] {
  const runIds = new Set(
    state.artifactLinks.filter((link) => link.artifactId === artifactId).map((link) => link.runId)
  );
  return state.runs.filter((run) => runIds.has(run.id)).sort(byNewestFirst);
}

/** Every file worked on anywhere in a workspace, most recently worked on first. */
export function getArtifactsForWorkspace(state: AgentState, workspaceId: string): WorkArtifact[] {
  return state.artifacts
    .filter((artifact) => artifact.workspaceId === workspaceId)
    .sort(byRecentlyWorked);
}

/** The roles a run has on one artifact — a file can be both inspected and edited. */
export function getArtifactRoles(
  state: AgentState,
  runId: string,
  artifactId: string
): AgentRunArtifactRole[] {
  return state.artifactLinks
    .filter((link) => link.runId === runId && link.artifactId === artifactId)
    .map((link) => link.role);
}

/**
 * A run's work items, oldest first.
 *
 * Oldest first, unlike almost every other list here, because work items are a
 * *plan*: they were created in the order they were meant to be done, and
 * showing them newest-first would present that plan backwards.
 */
export function getWorkItemsForRun(state: AgentState, runId: string): AgentWorkItem[] {
  return state.workItems.filter((item) => item.runId === runId).sort(byOldestFirst);
}

/** Every work item in one workspace, oldest first. The workspace-scoped view a UI shows. */
export function getWorkspaceWorkItems(state: AgentState, workspaceId: string): AgentWorkItem[] {
  return state.workItems.filter((item) => item.workspaceId === workspaceId).sort(byOldestFirst);
}

/** A workspace's work items narrowed to one status. */
export function getWorkItemsByStatus(
  state: AgentState,
  workspaceId: string,
  status: AgentWorkItemStatus
): AgentWorkItem[] {
  return getWorkspaceWorkItems(state, workspaceId).filter((item) => item.status === status);
}

/**
 * The one work item that best represents what a run is doing.
 *
 * Derived rather than stored, so there is no `isPrimary` flag to keep in sync
 * with reality — a flag would have to be maintained on every transition, and
 * would go stale the moment an item finished. The rule is simply "the work
 * that most wants attention right now":
 *
 *   active > blocked > pending > completed > cancelled
 *
 * ties broken by creation order, so a run working through a plan surfaces the
 * task it is actually on. Returns undefined when the run has no items at all
 * — never a placeholder, so the caller decides how "no plan observed" reads.
 */
export function getPrimaryWorkItem(
  state: AgentState,
  runId: string
): AgentWorkItem | undefined {
  const rank: Record<AgentWorkItemStatus, number> = {
    active: 0,
    blocked: 1,
    pending: 2,
    completed: 3,
    cancelled: 4,
  };

  let best: AgentWorkItem | undefined;
  for (const item of state.workItems) {
    if (item.runId !== runId) continue;
    if (!best) {
      best = item;
      continue;
    }
    const delta = rank[item.status] - rank[best.status];
    if (delta < 0 || (delta === 0 && byOldestFirst(item, best) < 0)) best = item;
  }

  return best;
}

/**
 * How far a run has got through its work items.
 *
 * **This is the only progress Hubble ever computes, and it is evidence-based
 * by construction**: `total` is how many work items actually exist, and
 * `completed` is how many of them actually reached the `completed` status.
 * Neither number is inferred from event counts, elapsed time, transcript
 * position, or a session going quiet — the failure mode Phase 15 exists to
 * avoid is a confident "7 / 10" assembled from nothing.
 *
 * Returns undefined for a run with no work items, so the UI omits the
 * indicator rather than rendering an honest-looking 0 / 0.
 *
 * Cancelled items count toward neither: abandoned work is not progress, and
 * counting it as completed would let a run reach 100% having finished nothing.
 * They are excluded from `total` as well, so a plan whose last two items were
 * cancelled can still read as finished.
 */
export function getRunWorkProgress(
  state: AgentState,
  runId: string
): { completed: number; total: number } | undefined {
  let completed = 0;
  let total = 0;

  for (const item of state.workItems) {
    if (item.runId !== runId) continue;
    if (item.status === "cancelled") continue;
    total += 1;
    if (item.status === "completed") completed += 1;
  }

  return total === 0 ? undefined : { completed, total };
}

/** Counts for a workspace's work items, for a summary strip. One pass. */
export function getWorkspaceWorkItemCounts(
  state: AgentState,
  workspaceId: string
): { total: number; active: number; blocked: number; completed: number } {
  let total = 0;
  let active = 0;
  let blocked = 0;
  let completed = 0;

  for (const item of state.workItems) {
    if (item.workspaceId !== workspaceId) continue;
    total += 1;
    if (item.status === "active") active += 1;
    else if (item.status === "blocked") blocked += 1;
    else if (item.status === "completed") completed += 1;
  }

  return { total, active, blocked, completed };
}

/**
 * Oldest first, with id breaking ties.
 *
 * The mirror of byNewestFirst, and total for the same reason: a plan's items
 * are frequently created in one batch and share a millisecond.
 */
function byOldestFirst(a: AgentWorkItem, b: AgentWorkItem): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Most recently worked on first, with id breaking ties.
 *
 * Same total-order reasoning as byNewestFirst: several files touched in one
 * poll share a timestamp, and without the tiebreak a list of them would
 * reshuffle between renders for no visible reason.
 */
function byRecentlyWorked(a: WorkArtifact, b: WorkArtifact): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Newest first by creation, with id breaking ties.
 *
 * The tiebreak keeps the order total and therefore stable: several runs
 * created in the same millisecond (an adapter discovering a backlog of
 * sessions in one pass) would otherwise sort differently between calls and
 * make a list reshuffle for no visible reason.
 */
function byNewestFirst(a: AgentRun, b: AgentRun): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
