import type { WorkspaceStore } from "@/lib/workspace/types";
import type { OrganizationPlan } from "./types";

export type OrganizationPlanValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * AGENTS.md section 16's safety gate — checked both right after a plan is
 * generated (before it's ever shown to the user) and again right before
 * Apply (the store may have changed in between — see apply.ts). Never
 * applies a plan that fails this.
 */
export function validateOrganizationPlan(plan: OrganizationPlan, store: WorkspaceStore): OrganizationPlanValidation {
  const errors: string[] = [];
  const knownTabIds = new Set(store.workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
  const knownWorkspaceIds = new Set(store.workspaces.map((w) => w.id));
  const currentWorkspaceIdByTab = new Map(store.workspaces.flatMap((w) => w.tabs.map((t): [string, string] => [t.id, w.id])));
  const seenTabIds = new Set<string>();
  // Separate from seenTabIds: a tab legitimately appears both in a
  // workspace proposal's `tabs` (being moved in) AND in one of its
  // `groups[].tabIds` (being grouped once there) — that's not a duplicate.
  // It's only ever a problem if the SAME tab shows up in two different
  // groups.
  const seenGroupTabIds = new Set<string>();

  function checkTabId(tabId: string, where: string) {
    if (!knownTabIds.has(tabId)) {
      errors.push(`Unknown tab id "${tabId}" referenced in ${where}.`);
      return;
    }
    if (seenTabIds.has(tabId)) {
      errors.push(`Tab id "${tabId}" is assigned more than once.`);
      return;
    }
    seenTabIds.add(tabId);
  }

  for (const [i, proposal] of plan.workspaces.entries()) {
    if (!proposal.proposedName || !proposal.proposedName.trim()) {
      errors.push(`Workspace proposal #${i + 1} has an empty name.`);
    }
    if (proposal.existingWorkspaceId && !knownWorkspaceIds.has(proposal.existingWorkspaceId)) {
      errors.push(`Workspace proposal #${i + 1} references unknown workspace id "${proposal.existingWorkspaceId}".`);
    }
    if (proposal.tabs.length === 0 && (proposal.groups ?? []).length === 0) {
      errors.push(`Workspace proposal #${i + 1} ("${proposal.proposedName}") has no tabs or groups.`);
    }
    for (const t of proposal.tabs) checkTabId(t.tabId, `workspace proposal "${proposal.proposedName}"`);

    const targetWorkspace = proposal.existingWorkspaceId ? store.workspaces.find((w) => w.id === proposal.existingWorkspaceId) : undefined;
    const knownExistingGroupIds = new Set((targetWorkspace?.groups ?? []).map((g) => g.id));
    const movedTabIds = new Set(proposal.tabs.map((t) => t.tabId));

    for (const group of proposal.groups ?? []) {
      if (!group.proposedName || !group.proposedName.trim()) {
        errors.push(`A group under "${proposal.proposedName}" has an empty name.`);
      }
      if (group.existingGroupId) {
        if (!proposal.existingWorkspaceId) {
          errors.push(`Group "${group.proposedName}" references an existing group id, but workspace proposal "${proposal.proposedName}" is for a brand-new workspace.`);
        } else if (!knownExistingGroupIds.has(group.existingGroupId)) {
          errors.push(`Unknown group id "${group.existingGroupId}" referenced by group "${group.proposedName}" in workspace proposal "${proposal.proposedName}".`);
        }
      }
      for (const tabId of group.tabIds) {
        if (!knownTabIds.has(tabId)) {
          errors.push(`Unknown tab id "${tabId}" referenced in group "${group.proposedName}".`);
          continue;
        }
        if (seenGroupTabIds.has(tabId)) {
          errors.push(`Tab id "${tabId}" is assigned to more than one group.`);
          continue;
        }
        seenGroupTabIds.add(tabId);

        // The tab must actually end up in this proposal's target workspace
        // — either it's already resident there, or it's one of the tabs
        // this same proposal is moving in. A brand-new workspace has no
        // residents yet, so its group tabs must all be among the ones
        // being moved in.
        const alreadyResident = proposal.existingWorkspaceId && currentWorkspaceIdByTab.get(tabId) === proposal.existingWorkspaceId;
        if (!alreadyResident && !movedTabIds.has(tabId)) {
          errors.push(`Tab id "${tabId}" in group "${group.proposedName}" isn't in workspace proposal "${proposal.proposedName}".`);
        }
      }
    }
  }

  for (const uncertain of plan.uncertainTabs) {
    checkTabId(uncertain.tabId, "uncertainTabs");
    if (!knownWorkspaceIds.has(uncertain.currentWorkspaceId)) {
      errors.push(`Uncertain tab "${uncertain.tabId}" references unknown current workspace id "${uncertain.currentWorkspaceId}".`);
    }
  }

  for (const dup of plan.duplicates) {
    for (const tabId of dup.tabIds) {
      if (!knownTabIds.has(tabId)) errors.push(`Unknown tab id "${tabId}" referenced in a duplicate group.`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
