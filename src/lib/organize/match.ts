import type { Group, Workspace } from "@/lib/workspace/types";
import type { ScopedTab } from "./types";
import { tabTokens, tokenize } from "./keywords";

/** Fraction of `needle`'s tokens that appear anywhere in `haystack` — containment, not Jaccard. A short workspace name like "Physics" should score high just for its one word showing up in the cluster, regardless of how many OTHER unrelated words the cluster also contains; a symmetric Jaccard score would get diluted away by exactly those other words. */
function containment(needle: string[], haystack: string[]): number {
  if (needle.length === 0) return 0;
  const haystackSet = new Set(haystack);
  const hits = needle.filter((t) => haystackSet.has(t)).length;
  return hits / needle.length;
}

/** How much reuse "evidence" a cluster needs before we prefer an existing workspace over proposing a new one — AGENTS.md section 12: "Prefer reusing existing workspaces when the semantic evidence is strong," but only when it's actually strong. */
const REUSE_THRESHOLD = 1.5;

export type WorkspaceMatch = { workspaceId: string; workspaceName: string; score: number };

/**
 * Scores how well a cluster fits an existing workspace, combining:
 *  - the fraction of the cluster already living in that workspace (a tab
 *    that's already there is strong evidence the topic belongs there);
 *  - token overlap between the workspace's name and the cluster's
 *    aggregate keyword signature;
 *  - token overlap between the cluster's tabs and the workspace's OTHER
 *    existing tabs (catches "these new tabs are about the same topic as
 *    what's already in Physics," per AGENTS.md section 12's example, even
 *    when none of the cluster's own tabs are in Physics yet).
 */
export function scoreWorkspaceMatch(clusterTabIds: string[], clusterTabsById: Map<string, ScopedTab>, workspace: Workspace): number {
  const clusterSet = new Set(clusterTabIds);
  const sourceWorkspaceIds = new Set(clusterTabIds.map((id) => clusterTabsById.get(id)?.workspaceId));

  // A cluster that currently lives ENTIRELY in one single workspace scores
  // 100% "membership" in that workspace no matter what it's named — that's
  // tautological, not evidence, and would otherwise make Auto-Organize
  // unable to ever split a single big workspace into topical ones (its
  // primary use case — AGENTS.md section 1). Membership only counts as
  // real reuse evidence when the cluster is scattered across more than one
  // source workspace and PARTLY concentrated in this one.
  const memberCount = clusterTabIds.filter((id) => clusterTabsById.get(id)?.workspaceId === workspace.id).length;
  const membershipFraction = sourceWorkspaceIds.size === 1 && sourceWorkspaceIds.has(workspace.id) ? 0 : memberCount / clusterTabIds.length;

  const clusterTokens = clusterTabIds.flatMap((id) => {
    const st = clusterTabsById.get(id);
    return st ? tabTokens(st.tab) : [];
  });

  const nameTokens = tokenize(workspace.name);
  const nameOverlap = containment(nameTokens, clusterTokens);

  const otherWorkspaceTabTokens = workspace.tabs
    .filter((t) => !clusterSet.has(t.id))
    .flatMap((t) => tabTokens(t));
  const contentOverlap = otherWorkspaceTabTokens.length > 0 ? containment(clusterTokens, otherWorkspaceTabTokens) : 0;

  return membershipFraction * 3 + nameOverlap * 2 + contentOverlap * 1.5;
}

/** Picks the best-fitting existing workspace for a cluster, or `null` if nothing clears REUSE_THRESHOLD. */
export function findBestWorkspaceMatch(
  clusterTabIds: string[],
  clusterTabsById: Map<string, ScopedTab>,
  candidates: Workspace[]
): WorkspaceMatch | null {
  let best: WorkspaceMatch | null = null;
  for (const workspace of candidates) {
    const score = scoreWorkspaceMatch(clusterTabIds, clusterTabsById, workspace);
    if (score >= REUSE_THRESHOLD && (!best || score > best.score)) {
      best = { workspaceId: workspace.id, workspaceName: workspace.name, score };
    }
  }
  return best;
}

/** How much reuse evidence a group-level sub-cluster needs before preferring an existing group over proposing a new one — the group-level counterpart to REUSE_THRESHOLD above, per AGENTS.md's "prefer Physics / General Relativity over Physics / General Relativity 2" example. */
const GROUP_REUSE_THRESHOLD = 1.2;

export type GroupMatch = { groupId: string; groupName: string; score: number };

/**
 * Scores how well a group-level sub-cluster fits an existing group within
 * `workspace`, mirroring scoreWorkspaceMatch's shape one level down: how
 * much of the sub-cluster is already IN that group, how well the group's
 * own name overlaps the sub-cluster's keywords, and how well the
 * sub-cluster overlaps the group's OTHER existing tabs. Unlike the
 * workspace version there's no "entirely-one-source" tautology guard needed
 * — a sub-cluster being carved out of one workspace's tabs and matched
 * against that SAME workspace's own groups is exactly the intended use.
 */
export function scoreGroupMatch(
  clusterTabIds: string[],
  clusterTabsById: Map<string, ScopedTab>,
  workspace: Workspace,
  group: Group
): number {
  const clusterSet = new Set(clusterTabIds);

  const memberCount = clusterTabIds.filter((id) => clusterTabsById.get(id)?.tab.groupId === group.id).length;
  const membershipFraction = memberCount / clusterTabIds.length;

  const clusterTokens = clusterTabIds.flatMap((id) => {
    const st = clusterTabsById.get(id);
    return st ? tabTokens(st.tab) : [];
  });

  const nameTokens = tokenize(group.name);
  const nameOverlap = containment(nameTokens, clusterTokens);

  const otherGroupTabTokens = workspace.tabs
    .filter((t) => t.groupId === group.id && !clusterSet.has(t.id))
    .flatMap((t) => tabTokens(t));
  const contentOverlap = otherGroupTabTokens.length > 0 ? containment(clusterTokens, otherGroupTabTokens) : 0;

  return membershipFraction * 3 + nameOverlap * 2 + contentOverlap * 1.5;
}

/** Picks the best-fitting existing group in `workspace` for a sub-cluster, or `null` if nothing clears GROUP_REUSE_THRESHOLD. */
export function findBestGroupMatch(
  clusterTabIds: string[],
  clusterTabsById: Map<string, ScopedTab>,
  workspace: Workspace
): GroupMatch | null {
  let best: GroupMatch | null = null;
  for (const group of workspace.groups ?? []) {
    const score = scoreGroupMatch(clusterTabIds, clusterTabsById, workspace, group);
    if (score >= GROUP_REUSE_THRESHOLD && (!best || score > best.score)) {
      best = { groupId: group.id, groupName: group.name, score };
    }
  }
  return best;
}
