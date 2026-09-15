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
