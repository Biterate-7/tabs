import type { OrganizationPlan } from "./types";

/**
 * Applies one quick decision for an uncertain tab (AGENTS.md section 7's
 * [Keep] [Physics] [MUN] [Misc] buttons) to a client-only, in-memory copy
 * of an OrganizationPlan — used by AutoOrganizeReview before Apply is ever
 * clicked. Never touches a WorkspaceStore; the edited plan still goes
 * through the exact same validate → Apply path as any other plan (see
 * src/lib/organize/apply.ts), so this can't itself introduce an invalid
 * assignment (e.g. a duplicate) that skips validation.
 *
 * "Keep" removes the tab from `uncertainTabs` without adding it anywhere
 * else — leaving a tab exactly where it already is needs no action (see
 * OrganizationPlan's completeness invariant). Any other choice adds it to
 * the matching (or a freshly created) workspace proposal.
 */
export function resolveUncertainTab(
  plan: OrganizationPlan,
  tabId: string,
  choice: { workspaceId?: string; name: string }
): OrganizationPlan {
  const uncertain = plan.uncertainTabs.find((u) => u.tabId === tabId);
  if (!uncertain) return plan;

  const uncertainTabs = plan.uncertainTabs.filter((u) => u.tabId !== tabId);

  const isKeep = choice.workspaceId === uncertain.currentWorkspaceId && choice.name.startsWith("Keep in");
  if (isKeep) {
    return { ...plan, uncertainTabs };
  }

  const assignment = { tabId, reason: "Manually assigned by you.", confidence: "medium" as const };
  const existingIndex = plan.workspaces.findIndex(
    (w) =>
      (choice.workspaceId && w.existingWorkspaceId === choice.workspaceId) ||
      w.proposedName.toLowerCase() === choice.name.toLowerCase()
  );

  if (existingIndex >= 0) {
    const workspaces = plan.workspaces.map((w, i) => (i === existingIndex ? { ...w, tabs: [...w.tabs, assignment] } : w));
    return { ...plan, workspaces, uncertainTabs };
  }

  const workspaces = [
    ...plan.workspaces,
    {
      existingWorkspaceId: choice.workspaceId,
      proposedName: choice.name,
      reason: "Manually assigned by you.",
      tabs: [assignment],
    },
  ];
  return { ...plan, workspaces, uncertainTabs };
}
