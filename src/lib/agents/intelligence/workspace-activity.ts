import { AGENT_RUN_STATUSES, LIVE_AGENT_RUN_STATUSES } from "@/lib/agents/types";
import { toArtifactReference, toRunReference, toWorkItemReference } from "./references";
import {
  countWorkItems,
  deriveLastActivityAt,
  deriveWorkProgress,
  selectPrimaryWorkItem,
} from "./run-summary";
import {
  RECENT_ARTIFACT_LIMIT,
  RECENT_COMPLETED_WORK_ITEM_LIMIT,
} from "./types";
import type { AgentDomainIndex } from "./domain-index";
import type {
  AgentActivityCard,
  ArtifactReference,
  RunReference,
  WorkItemReference,
  WorkspaceAgentActivity,
} from "./types";
import type { AgentRun, AgentRunStatus, WorkArtifact } from "@/lib/agents/types";

/**
 * What is happening across one workspace.
 *
 * The view the brief calls "this is what is happening in my workspace right
 * now" - assembled entirely from runs, work items and artifacts the workspace
 * already holds.
 *
 * ## Scoping
 *
 * Everything starts from `index.runsByWorkspace`, so the workspace boundary is
 * crossed exactly once, at the top, under one lookup. Work items and artifact
 * links are then reached only *through* those runs. There is no path in this
 * file that reads a work item or a link by any key other than a run id already
 * proven to belong to the requested workspace - which is what makes the
 * isolation tests structural rather than a matter of remembering to filter.
 *
 * Artifacts are the one entity reachable independently (they carry their own
 * `workspaceId`), and the recent-files list still gathers them through run
 * links rather than by scanning `artifactsById`, so a stray artifact belonging
 * to no run in this workspace cannot appear.
 */

/** Whether a run status counts as live. Phase 11's definition, not a new one. */
function isLive(status: AgentRunStatus): boolean {
  return (LIVE_AGENT_RUN_STATUSES as readonly string[]).includes(status);
}

/** Every status bucket, present and empty rather than absent. */
function emptyByStatus(): Record<AgentRunStatus, RunReference[]> {
  const byStatus = {} as Record<AgentRunStatus, RunReference[]>;
  for (const status of AGENT_RUN_STATUSES) byStatus[status] = [];
  return byStatus;
}

/**
 * Builds the workspace activity view.
 *
 * An unknown or empty workspace returns a fully-formed value with empty
 * collections - never `undefined`. A workspace with no agent work is an
 * ordinary, expected state that a UI renders as an empty state, not an error
 * it has to guard against.
 *
 * `lastActivityAt` is absent for such a workspace, and that absence is
 * meaningful: there is no observed activity to date, as distinct from
 * activity dated zero.
 */
export function getWorkspaceAgentActivity(
  index: AgentDomainIndex,
  workspaceId: string
): WorkspaceAgentActivity {
  const byStatus = emptyByStatus();
  const activity: WorkspaceAgentActivity = {
    workspaceId,
    byStatus,
    activeRuns: [],
    activeWorkItems: [],
    blockedWorkItems: [],
    recentlyCompletedWorkItems: [],
    recentlyTouchedArtifacts: [],
  };

  if (!workspaceId) return activity;

  const runs = index.runsByWorkspace.get(workspaceId);
  if (!runs?.length) return activity;

  const activeWorkItems: WorkItemReference[] = [];
  const blockedWorkItems: WorkItemReference[] = [];
  const completedWorkItems: { reference: WorkItemReference; at: number }[] = [];
  const artifactsSeen = new Map<string, WorkArtifact>();

  let lastActivityAt: number | undefined;

  for (const run of runs) {
    const reference = toRunReference(run);
    byStatus[run.status].push(reference);
    if (isLive(run.status)) activity.activeRuns.push(reference);

    const runLastAt = deriveLastActivityAt(index, run.id);
    if (runLastAt !== undefined && (lastActivityAt === undefined || runLastAt > lastActivityAt)) {
      lastActivityAt = runLastAt;
    }

    for (const item of index.workItemsByRun.get(run.id) ?? []) {
      if (item.status === "active") activeWorkItems.push(toWorkItemReference(item));
      else if (item.status === "blocked") blockedWorkItems.push(toWorkItemReference(item));
      else if (item.status === "completed") {
        completedWorkItems.push({
          reference: toWorkItemReference(item),
          // `completedAt` is stamped on the transition; `updatedAt` stands in
          // for an item that arrived already finished, which Phase 15 records
          // without a start or completion time of its own.
          at: item.completedAt ?? item.updatedAt,
        });
      }
    }

    // Files are gathered through this run's links, so scoping is inherited
    // rather than re-derived from the artifact's own workspaceId.
    for (const link of index.artifactLinksByRun.get(run.id) ?? []) {
      const artifact = index.artifactsById.get(link.artifactId);
      if (artifact) artifactsSeen.set(artifact.id, artifact);
    }
  }

  // Most recently completed first, bounded. The tiebreak on id keeps the
  // order total, so the list does not reshuffle between renders when several
  // items finished in the same millisecond.
  completedWorkItems.sort(
    (a, b) => b.at - a.at || compareIds(a.reference.workItemId, b.reference.workItemId)
  );

  const recentlyTouchedArtifacts: ArtifactReference[] = [...artifactsSeen.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || compareIds(a.id, b.id))
    .slice(0, RECENT_ARTIFACT_LIMIT)
    .map(toArtifactReference);

  activity.activeWorkItems = activeWorkItems;
  activity.blockedWorkItems = blockedWorkItems;
  activity.recentlyCompletedWorkItems = completedWorkItems
    .slice(0, RECENT_COMPLETED_WORK_ITEM_LIMIT)
    .map((entry) => entry.reference);
  activity.recentlyTouchedArtifacts = recentlyTouchedArtifacts;
  if (lastActivityAt !== undefined) activity.lastActivityAt = lastActivityAt;

  return activity;
}

/**
 * One card per run in the workspace, newest run first.
 *
 * The composition step: a card is its run's summary plus the resolved agent
 * identity, and adds no fact of its own. Built for every run rather than only
 * live ones, because the caller filters - and a selector that decided which
 * runs deserve a card would be making a visibility decision that already has
 * exactly one home, in `runMatchesFilter`.
 */
export function getWorkspaceActivityCards(
  index: AgentDomainIndex,
  workspaceId: string
): AgentActivityCard[] {
  if (!workspaceId) return [];
  const runs = index.runsByWorkspace.get(workspaceId);
  if (!runs?.length) return [];

  return runs.map((run) => buildActivityCard(index, run));
}

/**
 * The card for one run.
 *
 * Returns `undefined` for a run the index does not hold, or one outside the
 * requested workspace. The second check is the one that matters: it means a
 * caller holding a run id from elsewhere cannot use this to read across the
 * boundary, even by accident.
 */
export function getAgentActivityCard(
  index: AgentDomainIndex,
  workspaceId: string,
  runId: string
): AgentActivityCard | undefined {
  const run = index.runsById.get(runId);
  if (!run) return undefined;
  if (run.workspaceId !== workspaceId) return undefined;
  return buildActivityCard(index, run);
}

function buildActivityCard(index: AgentDomainIndex, run: AgentRun): AgentActivityCard {
  const agent = index.agentsById.get(run.agentId);
  const items = index.workItemsByRun.get(run.id);

  const artifactIds = new Set<string>();
  for (const link of index.artifactLinksByRun.get(run.id) ?? []) {
    artifactIds.add(link.artifactId);
  }

  const contextTabIds = new Set<string>();
  const producedTabIds = new Set<string>();
  for (const link of index.tabLinksByRun.get(run.id) ?? []) {
    if (link.role === "context") contextTabIds.add(link.tabId);
    else producedTabIds.add(link.tabId);
  }

  const card: AgentActivityCard = {
    runId: run.id,
    agentId: run.agentId,
    // Honest fallbacks for a deleted agent, matching the inspector's: an
    // agent deleted out from under a run is a race, not a crash.
    agentName: agent?.name ?? "Agent",
    provider: agent?.provider ?? "",
    // A run without a title is still a run; naming it by its agent beats an
    // empty label - and never the session id, which must not be rendered.
    label: run.title ?? agent?.name ?? "Agent run",
    status: run.status,
    workItems: countWorkItems(items),
    artifactCount: artifactIds.size,
    contextTabCount: contextTabIds.size,
    producedTabCount: producedTabIds.size,
  };

  if (run.currentActivity !== undefined) card.activity = run.currentActivity;

  const primary = selectPrimaryWorkItem(items);
  if (primary) card.primaryWorkItem = toWorkItemReference(primary);

  const progress = deriveWorkProgress(items);
  if (progress) card.progress = progress;

  const lastActivityAt = deriveLastActivityAt(index, run.id);
  if (lastActivityAt !== undefined) card.lastActivityAt = lastActivityAt;

  return card;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
