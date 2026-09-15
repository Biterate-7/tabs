import { buildAgentDomainIndex } from "./domain-index";
import { getAgentRunImpact } from "./impact";
import { toRunReference, toWorkItemReference } from "./references";
import { getAgentRunSummary } from "./run-summary";
import type { AgentDomainIndex } from "./domain-index";
import type { AgentRunImpact, AgentRunSummary, RunReference, WorkItemReference } from "./types";
import { LIVE_AGENT_RUN_STATUSES } from "@/lib/agents/types";
import type { AgentState } from "@/lib/agents/types";

/**
 * The intelligence layer's public read surface.
 *
 * Plain functions of an index: no React, no hooks, no memoisation, no
 * mutation, no persistence - the same contract `lib/agents/selectors.ts`
 * holds, so the whole layer stays usable from tests and from any future
 * non-React caller.
 *
 * ## Why these take an index and not a state
 *
 * A UI asks several of these questions about the same state in one render.
 * Taking `AgentState` directly would mean re-grouping the domain inside each
 * call, which is the quadratic behaviour §31 forbids. Taking a prebuilt index
 * makes the grouping happen once and the sharing explicit.
 *
 * `fromState` below exists for callers that genuinely have a single question
 * to ask - mostly tests - and is deliberately not the path the UI takes.
 */

/** Builds an index. Re-exported so callers need only this module. */
export { buildAgentDomainIndex, emptyAgentDomainIndex } from "./domain-index";
export { getAgentRunSummary, selectPrimaryWorkItem } from "./run-summary";
export { getAgentRunImpact } from "./impact";
export { getAgentRelationshipsForRun, getHighlightedObjectIds } from "./relationships";
export {
  getAgentActivityCard,
  getWorkspaceActivityCards,
  getWorkspaceAgentActivity,
} from "./workspace-activity";

/**
 * Every run in a workspace, newest first.
 *
 * Returns references rather than domain runs, so a session id cannot reach a
 * caller through this path either.
 */
export function getRunsForWorkspace(
  index: AgentDomainIndex,
  workspaceId: string
): RunReference[] {
  if (!workspaceId) return [];
  return (index.runsByWorkspace.get(workspaceId) ?? []).map(toRunReference);
}

/**
 * The live runs in a workspace - `working` and `waiting`.
 *
 * "Live" is Phase 11's `LIVE_AGENT_RUN_STATUSES` and is read from that
 * constant rather than spelled out as a status comparison, so adding a live
 * status to the domain updates this selector with it. The same constant backs
 * `getWorkspaceAgentActivity().activeRuns`, which is what keeps the two from
 * drifting into different definitions of the same word.
 */
export function getActiveAgentRuns(
  index: AgentDomainIndex,
  workspaceId: string
): RunReference[] {
  if (!workspaceId) return [];
  const runs = index.runsByWorkspace.get(workspaceId);
  if (!runs?.length) return [];
  return runs
    .filter((run) => (LIVE_AGENT_RUN_STATUSES as readonly string[]).includes(run.status))
    .map(toRunReference);
}

/**
 * Every work item in a workspace, in plan order per run, runs newest first.
 *
 * Gathered through the workspace's runs rather than by filtering
 * `state.workItems` on `workspaceId`. Both would give the same answer for
 * well-formed state; going through the runs means a work item whose run is
 * missing, or whose workspace disagrees with its run's, contributes nothing -
 * the index has already dropped it.
 */
export function getWorkItemsForWorkspace(
  index: AgentDomainIndex,
  workspaceId: string
): WorkItemReference[] {
  if (!workspaceId) return [];
  const runs = index.runsByWorkspace.get(workspaceId);
  if (!runs?.length) return [];

  const items: WorkItemReference[] = [];
  for (const run of runs) {
    for (const item of index.workItemsByRun.get(run.id) ?? []) {
      items.push(toWorkItemReference(item));
    }
  }
  return items;
}

/**
 * A run's summary, scoped to a workspace.
 *
 * The workspace-checked variant of `getAgentRunSummary`. A caller that holds
 * a run id from another workspace gets `undefined` rather than a summary, so
 * a stale selection cannot read across the boundary.
 */
export function getWorkspaceRunSummary(
  index: AgentDomainIndex,
  workspaceId: string,
  runId: string
): AgentRunSummary | undefined {
  const run = index.runsById.get(runId);
  if (!run || run.workspaceId !== workspaceId) return undefined;
  return getAgentRunSummary(index, runId);
}

/** A run's impact, scoped to a workspace. Same boundary check as above. */
export function getWorkspaceRunImpact(
  index: AgentDomainIndex,
  workspaceId: string,
  runId: string
): AgentRunImpact | undefined {
  const run = index.runsById.get(runId);
  if (!run || run.workspaceId !== workspaceId) return undefined;
  return getAgentRunImpact(index, runId);
}

/**
 * Convenience for a caller holding a state rather than an index.
 *
 * Builds an index and throws it away. Fine for one question; wasteful for
 * several, which is why the UI memoises an index instead.
 */
export function intelligenceFromState(state: AgentState): AgentDomainIndex {
  return buildAgentDomainIndex(state);
}
