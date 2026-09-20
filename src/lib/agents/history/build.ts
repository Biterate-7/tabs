import { getAgentRunSummary } from "@/lib/agents/intelligence/run-summary";
import type { AgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import type { AgentHistoryEntry, AgentHistoryFilter, AgentHistoryView } from "./types";

/**
 * Agent History: the durable enumeration.
 *
 * ## Why this does not go through the world
 *
 * The Agent World draws runs that are live or that finished inside
 * `RECENT_RUN_WINDOW_MS`. That rule is correct for a spatial surface - a
 * room showing last week's work is not showing a room - and this module does
 * not touch it, read it, or import it. History enumerates every retained run
 * the domain still holds, which is why a run can be absent from the canvas
 * and present here at the same time. That divergence is the feature.
 *
 * Nothing here takes a `now`. There is no window to be inside or outside of,
 * so there is no clock to consult, and a history list renders identically
 * whenever it is built.
 *
 * ## Cost
 *
 * One pass over the index's workspace buckets, and one `getAgentRunSummary`
 * per row - which is itself map lookups on the same index. No row rebuilds
 * evidence, and no row scans the domain: enumerating N runs costs O(N) plus
 * what those runs actually contain, not N x M.
 */

/** Matches everything. A filter with no field set selects the whole history. */
function matches(entry: AgentHistoryEntry, filter: AgentHistoryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.agentId && entry.agentId !== filter.agentId) return false;
  if (filter.workspaceId && entry.workspaceId !== filter.workspaceId) return false;
  if (filter.status && entry.status !== filter.status) return false;
  return true;
}

export type BuildAgentHistoryInput = {
  index: AgentDomainIndex;
  /**
   * Workspace names, by id.
   *
   * Passed in rather than looked up: this module does not import the
   * workspace store, for the same reason links.ts does not. A workspace the
   * caller does not name still produces a row - the run happened, and hiding
   * it because its workspace was renamed away would be the recency mistake
   * in another form.
   */
  workspaceNames?: ReadonlyMap<string, string>;
  filter?: AgentHistoryFilter;
};

export function buildAgentHistory(input: BuildAgentHistoryInput): AgentHistoryView {
  const { index, workspaceNames, filter } = input;

  const all: AgentHistoryEntry[] = [];

  for (const [workspaceId, runs] of index.runsByWorkspace) {
    for (const run of runs) {
      const summary = getAgentRunSummary(index, run.id);
      if (!summary) continue;

      const agent = index.agentsById.get(run.agentId);

      const entry: AgentHistoryEntry = {
        runId: run.id,
        agentId: run.agentId,
        // A run whose agent is gone keeps its row and says so. Substituting
        // another agent's name would be a false attribution, and dropping
        // the row would hide work that happened.
        agentName: agent?.name ?? null,
        provider: agent?.provider ?? null,
        workspaceId,
        workspaceName: workspaceNames?.get(workspaceId) ?? null,
        status: run.status,
        // Absent rather than invented. The UI supplies the honest fallback
        // line; a default composed here would read like a recorded title.
        title: run.title ?? null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        workItemCount: summary.workItems.total,
        artifactCount: summary.artifactCount,
        tabCount: summary.contextTabCount + summary.producedTabCount,
        eventCount: (index.eventsByRun.get(run.id) ?? []).length,
      };

      if (run.endedAt !== undefined) entry.endedAt = run.endedAt;
      if (summary.lastActivityAt !== undefined) entry.lastActivityAt = summary.lastActivityAt;

      all.push(entry);
    }
  }

  // Newest first across every workspace, id breaking ties. Runs discovered
  // in one pass share a millisecond, and without the tiebreak the list would
  // reshuffle between renders for no visible reason.
  all.sort(
    (a, b) =>
      (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt) ||
      b.createdAt - a.createdAt ||
      (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)
  );

  const entries = all.filter((entry) => matches(entry, filter));

  // Facets are computed from the unfiltered set on purpose: a filter row
  // that vanished once it was applied would leave the user with no way back.
  const agents = new Map<string, { agentId: string; name: string | null; runCount: number }>();
  const workspaces = new Map<string, { workspaceId: string; name: string | null; runCount: number }>();
  for (const entry of all) {
    const agentFacet = agents.get(entry.agentId);
    if (agentFacet) agentFacet.runCount += 1;
    else agents.set(entry.agentId, { agentId: entry.agentId, name: entry.agentName, runCount: 1 });

    const workspaceFacet = workspaces.get(entry.workspaceId);
    if (workspaceFacet) workspaceFacet.runCount += 1;
    else {
      workspaces.set(entry.workspaceId, {
        workspaceId: entry.workspaceId,
        name: entry.workspaceName,
        runCount: 1,
      });
    }
  }

  return {
    entries,
    totalCount: all.length,
    agents: [...agents.values()].sort(byNameThenId),
    workspaces: [...workspaces.values()].sort(byNameThenId),
  };
}

/** Named things first, alphabetically; unnamed after, by id. Deterministic. */
function byNameThenId(
  a: { name: string | null; agentId?: string; workspaceId?: string },
  b: { name: string | null; agentId?: string; workspaceId?: string }
): number {
  if (a.name !== null && b.name !== null) {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
  } else if (a.name !== b.name) {
    return a.name === null ? 1 : -1;
  }
  const aId = a.agentId ?? a.workspaceId ?? "";
  const bId = b.agentId ?? b.workspaceId ?? "";
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}
