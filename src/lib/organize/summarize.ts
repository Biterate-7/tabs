import type { OrganizationPlan } from "./types";

/**
 * Deterministic, model-independent headline for a proposed OrganizationPlan
 * — same spirit as src/lib/actions/plan.ts's summarizePlan, so the text the
 * user sees never depends on Gemini's own phrasing (AGENTS.md's "I analyzed
 * 47 tabs and found 5 useful clusters" example).
 */
export function describeOrganizationPlan(plan: OrganizationPlan): string {
  if (plan.noopReason) return plan.noopReason;

  const clusterCount = plan.workspaces.length;

  if (clusterCount === 0) {
    return `I analyzed ${plan.totalTabsConsidered} tabs — I couldn't find any confident clusters, but flagged ${plan.uncertainTabs.length} tab${plan.uncertainTabs.length === 1 ? "" : "s"} that might need your input.`;
  }

  const clusterWord = clusterCount === 1 ? "cluster" : "clusters";
  const base = `I analyzed ${plan.totalTabsConsidered} tabs and found ${clusterCount} useful ${clusterWord}.`;
  if (plan.uncertainTabs.length === 0) return base;
  return `${base} ${plan.uncertainTabs.length} tab${plan.uncertainTabs.length === 1 ? "" : "s"} need${plan.uncertainTabs.length === 1 ? "s" : ""} your decision.`;
}

/** Deterministic "N workspaces/groups would be created or updated" / "N tabs would be reorganized" pair — see AGENTS.md's example proposal footer. */
export function describeOrganizationCounts(plan: OrganizationPlan): { workspaceCount: number; groupCount: number; tabCount: number } {
  const workspaceCount = plan.workspaces.length;
  const groupCount = plan.workspaces.reduce((sum, w) => sum + (w.groups?.length ?? 0), 0);
  const tabCount = plan.workspaces.reduce((sum, w) => sum + w.tabs.length, 0);
  return { workspaceCount, groupCount, tabCount };
}

/** Deterministic post-Apply confirmation line — "Organized 47 tabs into 5 workspaces." */
export function describeOrganizationApplied(plan: OrganizationPlan): string {
  const { workspaceCount, tabCount } = describeOrganizationCounts(plan);
  if (workspaceCount === 0) return "Nothing to organize.";
  return `Organized ${tabCount} tab${tabCount === 1 ? "" : "s"} into ${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}.`;
}
