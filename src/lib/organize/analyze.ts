import type { Workspace } from "@/lib/workspace/types";
import type {
  OrganizationPlan,
  OrganizeDuplicateGroup,
  OrganizeTabAssignment,
  OrganizeUncertainTab,
  OrganizeWorkspaceProposal,
  ScopedTab,
  SemanticClusterHint,
} from "./types";
import { buildRawClusters } from "./cluster";
import type { JoinReason, RawCluster } from "./cluster";
import { deriveClusterName, tabTokens, tokenOverlap } from "./keywords";
import { findBestGroupMatch, findBestWorkspaceMatch } from "./match";
import { describeOrganizationPlan } from "./summarize";

/** A library this small essentially never benefits from being split into workspaces — AGENTS.md section 18. */
const TINY_LIBRARY_MAX = 4;
/** A cluster needs at least this many tabs to justify its own (new or reused) workspace proposal. */
const MIN_CLUSTER_SIZE = 3;
/** How well a leftover tab's tokens must overlap a proposal's aggregate tokens to be folded in instead of left uncertain. */
const FIT_THRESHOLD = 0.12;
/** Below this, a handful of leftover small-cluster tabs isn't worth a "Miscellaneous" bucket — they go to uncertainTabs individually instead. */
const MISC_MIN_SIZE = 2;
const MISCELLANEOUS_NAME = "Miscellaneous";
/** A workspace cluster needs to be at least this big before it's even considered for a group sub-split. */
const MIN_PARENT_SIZE_FOR_GROUPS = 6;
/** A sub-cluster needs at least this many tabs to justify its own (new or reused) group — same spirit as MIN_CLUSTER_SIZE at the workspace level, so a couple of stray shared-domain tabs don't become their own tiny group. */
const MIN_GROUP_SIZE = 3;
const MAX_GROUPS_PER_WORKSPACE = 3;
/** Keep, up to two ranked cluster suggestions, and a guaranteed Miscellaneous fallback — AGENTS.md's [Keep] [Physics] [MUN] [Misc] example. */
const MAX_SUGGESTIONS = 4;
const NO_USEFUL_ORGANIZATION = "I couldn't find a useful organization that would improve your current setup.";

function tinyLibraryMessage(count: number): string {
  return `You only have ${count} tab${count === 1 ? "" : "s"}, and ${count === 1 ? "it's" : "they're"} already reasonably organized. I don't think any changes are necessary.`;
}

function joinReasonToConfidence(reason: JoinReason): "high" | "medium" | "low" {
  if (reason === "semantic") return "high";
  if (reason === "domain") return "high";
  if (reason === "keyword") return "medium";
  return "low";
}

/** Domain-derived display name for a sub-cluster that's entirely one domain — kept distinct from deriveClusterName, whose token-frequency approach would otherwise be dominated by DEV_TOOL_DOMAINS's synthetic "development" boost token and name every dev-tool-domain group "Development." */
function normalizedGroupName(domain: string): string {
  const label = domain.replace(/^www\./, "").split(".")[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function reasonText(reason: JoinReason, name: string): string {
  switch (reason) {
    case "semantic":
      return `Semantically similar to other tabs in "${name}".`;
    case "domain":
      return `Shares a domain with other tabs in "${name}".`;
    case "keyword":
      return `Shares keywords with other tabs in "${name}".`;
    default:
      return `Loosely related to "${name}".`;
  }
}

/**
 * Deterministic group sub-split: re-clusters a workspace-level cluster's own
 * tabs by domain/keyword (deliberately WITHOUT semantic hints — those
 * already did their job merging this cluster together at the workspace
 * level; re-applying them here would just re-merge everything into one
 * cluster again and never find internal sub-structure) via the same
 * union-find buildRawClusters used at the workspace level, one level down.
 * Each sub-cluster that clears MIN_GROUP_SIZE either reuses a matching
 * existing group in `workspace` (AGENTS.md section 8: prefer "Physics /
 * General Relativity" over "Physics / General Relativity 2") or gets a
 * freshly derived name — bounded at MAX_GROUPS_PER_WORKSPACE so a large
 * workspace doesn't get fragmented into a group per minor topic (section 9).
 */
function proposeGroups(workspace: Workspace | null, clusterTabs: ScopedTab[]): NonNullable<OrganizeWorkspaceProposal["groups"]> {
  if (clusterTabs.length < MIN_PARENT_SIZE_FOR_GROUPS) return [];

  const tabsById = new Map(clusterTabs.map((st) => [st.tab.id, st]));
  const subClusters = buildRawClusters(clusterTabs, [])
    .filter((c) => c.tabIds.length >= MIN_GROUP_SIZE && c.tabIds.length < clusterTabs.length)
    .sort((a, b) => b.tabIds.length - a.tabIds.length);

  const groups: NonNullable<OrganizeWorkspaceProposal["groups"]> = [];
  const usedTabIds = new Set<string>();
  const proposedNames = new Set<string>();

  for (const cluster of subClusters) {
    if (groups.length >= MAX_GROUPS_PER_WORKSPACE) break;
    const availableIds = cluster.tabIds.filter((id) => !usedTabIds.has(id));
    if (availableIds.length < MIN_GROUP_SIZE) continue;

    const match = workspace ? findBestGroupMatch(availableIds, tabsById, workspace) : null;
    const availableTabs = availableIds.map((id) => tabsById.get(id)!.tab);
    const domains = new Set(availableTabs.map((t) => t.domain.toLowerCase()));
    const derivedName = domains.size === 1 ? normalizedGroupName([...domains][0]) : deriveClusterName(availableTabs);
    const exactNameGroup = !match
      ? workspace?.groups?.find((g) => g.name.trim().toLowerCase() === derivedName.trim().toLowerCase())
      : undefined;
    const existingGroupId = match?.groupId ?? exactNameGroup?.id;
    const name = match?.groupName ?? exactNameGroup?.name ?? derivedName;

    if (!existingGroupId && proposedNames.has(name.toLowerCase())) continue; // avoid "X" / "X 2" duplicate proposals in one run

    const tabIds = existingGroupId
      ? availableIds.filter((id) => tabsById.get(id)!.tab.groupId !== existingGroupId)
      : availableIds;
    if (tabIds.length === 0) continue; // whole sub-cluster already correctly grouped — nothing to propose

    groups.push({
      existingGroupId,
      proposedName: name,
      reason: existingGroupId
        ? `${tabIds.length} tabs closely match your existing "${name}" group.`
        : `${tabIds.length} tabs share a distinct sub-topic.`,
      tabIds,
    });
    proposedNames.add(name.toLowerCase());
    for (const id of availableIds) usedTabIds.add(id);
  }
  return groups;
}

function buildDuplicates(scopedTabs: ScopedTab[]): OrganizeDuplicateGroup[] {
  const byUrl = new Map<string, ScopedTab[]>();
  for (const st of scopedTabs) {
    const bucket = byUrl.get(st.tab.normalizedUrl);
    if (bucket) bucket.push(st);
    else byUrl.set(st.tab.normalizedUrl, [st]);
  }
  const duplicates: OrganizeDuplicateGroup[] = [];
  for (const group of byUrl.values()) {
    if (group.length < 2) continue;
    duplicates.push({
      tabIds: group.map((st) => st.tab.id),
      reason: `${group.length} copies of the same page (${group[0].tab.domain}).`,
    });
  }
  return duplicates;
}

/**
 * Analyzes `scopeWorkspaces` (either the current workspace or all of them —
 * the caller decides scope) and produces a read-only OrganizationPlan.
 * Never mutates `allWorkspaces`/`scopeWorkspaces` or anything else —
 * AGENTS.md section 3. `semanticHints` is optional client-precomputed
 * tab-to-tab similarity (see src/lib/ai/cluster.ts); without it, clustering
 * still works from domain/keyword signals alone, just with lower recall
 * for topically-related tabs that don't share words.
 */
export function analyzeForOrganization(
  scopeWorkspaces: Workspace[],
  allWorkspaces: Workspace[],
  semanticHints: SemanticClusterHint[] = []
): OrganizationPlan {
  const scopedTabs: ScopedTab[] = scopeWorkspaces.flatMap((w) =>
    w.tabs.map((tab) => ({ tab, workspaceId: w.id, workspaceName: w.name }))
  );
  const totalTabsConsidered = scopedTabs.length;

  if (totalTabsConsidered === 0) {
    return { summary: "You don't have any tabs to organize yet.", workspaces: [], uncertainTabs: [], duplicates: [], totalTabsConsidered: 0, noopReason: "You don't have any tabs to organize yet." };
  }

  if (totalTabsConsidered <= TINY_LIBRARY_MAX) {
    const message = tinyLibraryMessage(totalTabsConsidered);
    return { summary: message, workspaces: [], uncertainTabs: [], duplicates: [], totalTabsConsidered, noopReason: message };
  }

  const tabsById = new Map(scopedTabs.map((st) => [st.tab.id, st]));
  const duplicates = buildDuplicates(scopedTabs);

  const rawClusters = buildRawClusters(scopedTabs, semanticHints);
  const bigClusters = rawClusters.filter((c) => c.tabIds.length >= MIN_CLUSTER_SIZE);
  const leftoverClusters = rawClusters.filter((c) => c.tabIds.length > 1 && c.tabIds.length < MIN_CLUSTER_SIZE);
  const singletons = rawClusters.filter((c) => c.tabIds.length === 1);

  const proposals: OrganizeWorkspaceProposal[] = [];
  const proposalTokensById = new Map<number, string[]>();
  const assignedTabIds = new Set<string>();

  bigClusters.forEach((cluster: RawCluster, index: number) => {
    const clusterTabIds = cluster.tabIds;
    const clusterTabs = clusterTabIds.map((id) => tabsById.get(id)!);
    const clusterTokens = clusterTabs.flatMap((st) => tabTokens(st.tab));

    const match = findBestWorkspaceMatch(clusterTabIds, tabsById, allWorkspaces);
    const derivedName = deriveClusterName(clusterTabs.map((st) => st.tab));
    const exactNameMatch = !match
      ? allWorkspaces.find((w) => w.name.trim().toLowerCase() === derivedName.trim().toLowerCase())
      : undefined;

    const targetWorkspace = match
      ? allWorkspaces.find((w) => w.id === match.workspaceId)!
      : exactNameMatch;
    const existingWorkspaceId = targetWorkspace?.id;
    const proposedName = targetWorkspace?.name ?? derivedName;

    const tabs: OrganizeTabAssignment[] = [];
    for (const id of clusterTabIds) {
      const st = tabsById.get(id)!;
      if (existingWorkspaceId && st.workspaceId === existingWorkspaceId) continue; // already there — no-op
      tabs.push({ tabId: id, reason: reasonText(cluster.joinReasons.get(id) ?? "none", proposedName), confidence: joinReasonToConfidence(cluster.joinReasons.get(id) ?? "none") });
      assignedTabIds.add(id);
    }

    // A cluster whose tabs already all live in the matching workspace can
    // still be worth proposing if it splits cleanly into groups (AGENTS.md
    // section 7's "Physics: 14 tabs" → "General Relativity" / "IA" /
    // "References" example never moves a single tab BETWEEN workspaces) —
    // only skip entirely when there's neither a tab move nor a group to show.
    const groups = proposeGroups(targetWorkspace ?? null, clusterTabs);
    if (tabs.length === 0 && groups.length === 0) return;

    proposals.push({
      existingWorkspaceId,
      proposedName,
      reason: existingWorkspaceId
        ? `${clusterTabIds.length} tabs closely match your existing "${proposedName}" workspace.`
        : `${clusterTabIds.length} tabs share a clear common topic.`,
      tabs,
      groups,
    });
    proposalTokensById.set(index, clusterTokens);
  });

  // Fold small clusters/singletons into an existing proposal when they clearly fit it.
  const pool = [...leftoverClusters.flatMap((c) => c.tabIds), ...singletons.flatMap((c) => c.tabIds)].filter((id) => !assignedTabIds.has(id));
  const stillUnplaced: string[] = [];

  for (const tabId of pool) {
    const st = tabsById.get(tabId)!;
    const tokens = tabTokens(st.tab);
    let bestIndex = -1;
    let bestScore = 0;
    proposals.forEach((_, i) => {
      const clusterTokens = proposalTokensById.get(i);
      if (!clusterTokens) return;
      const score = tokenOverlap(tokens, clusterTokens);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });

    if (bestIndex >= 0 && bestScore >= FIT_THRESHOLD && proposals[bestIndex].existingWorkspaceId !== st.workspaceId) {
      proposals[bestIndex].tabs.push({
        tabId,
        reason: `Shares keywords with "${proposals[bestIndex].proposedName}".`,
        confidence: "low",
      });
      assignedTabIds.add(tabId);
    } else {
      stillUnplaced.push(tabId);
    }
  }

  // Leftover small clusters (real, if weak, pairwise signal) become Miscellaneous rather than staying individually uncertain — AGENTS.md section 4.
  const miscCandidateIds = stillUnplaced.filter((id) => {
    const owningCluster = leftoverClusters.find((c) => c.tabIds.includes(id));
    return Boolean(owningCluster);
  });
  const trueOrphans = stillUnplaced.filter((id) => !miscCandidateIds.includes(id));

  if (miscCandidateIds.length >= MISC_MIN_SIZE) {
    const existingMisc = allWorkspaces.find((w) => w.name.trim().toLowerCase() === MISCELLANEOUS_NAME.toLowerCase());
    const tabs: OrganizeTabAssignment[] = miscCandidateIds
      .filter((id) => tabsById.get(id)!.workspaceId !== existingMisc?.id)
      .map((id) => ({ tabId: id, reason: "Doesn't clearly fit an existing topic yet.", confidence: "low" as const }));
    if (tabs.length > 0) {
      proposals.push({
        existingWorkspaceId: existingMisc?.id,
        proposedName: existingMisc?.name ?? MISCELLANEOUS_NAME,
        reason: `${tabs.length} tabs didn't form a strong enough topic for their own workspace.`,
        tabs,
        groups: [],
      });
    }
  } else {
    trueOrphans.push(...miscCandidateIds);
  }

  const existingMiscWorkspace = allWorkspaces.find((w) => w.name.trim().toLowerCase() === MISCELLANEOUS_NAME.toLowerCase());

  const uncertainTabs: OrganizeUncertainTab[] = trueOrphans.map((id) => {
    const st = tabsById.get(id)!;
    const tokens = tabTokens(st.tab);
    const ranked = proposals
      .map((p, i) => ({ p, score: tokenOverlap(tokens, proposalTokensById.get(i) ?? []) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS - 2)
      .map(({ p }) => ({ workspaceId: p.existingWorkspaceId, name: p.proposedName }));

    const keepSuggestion = { workspaceId: st.workspaceId, name: `Keep in "${st.workspaceName}"` };
    const hasMiscAlready = ranked.some((r) => r.name.toLowerCase() === MISCELLANEOUS_NAME.toLowerCase());
    const miscSuggestion = { workspaceId: existingMiscWorkspace?.id, name: MISCELLANEOUS_NAME };

    const suggestions = [keepSuggestion, ...ranked, ...(hasMiscAlready ? [] : [miscSuggestion])].slice(0, MAX_SUGGESTIONS);
    return {
      tabId: id,
      reason: "Not similar enough to any confident cluster.",
      currentWorkspaceId: st.workspaceId,
      currentWorkspaceName: st.workspaceName,
      suggestions,
    };
  });

  if (proposals.length === 0 && uncertainTabs.length === 0) {
    return { summary: NO_USEFUL_ORGANIZATION, workspaces: [], uncertainTabs: [], duplicates, totalTabsConsidered, noopReason: NO_USEFUL_ORGANIZATION };
  }

  const plan: OrganizationPlan = { summary: "", workspaces: proposals, uncertainTabs, duplicates, totalTabsConsidered };
  plan.summary = describeOrganizationPlan(plan);
  return plan;
}
