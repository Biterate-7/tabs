import { runAction } from "@/lib/actions/run";
import type { WorkspaceStore } from "@/lib/workspace/types";
import type { OrganizationPlan } from "./types";
import { validateOrganizationPlan } from "./validate";
import { describeOrganizationApplied } from "./summarize";

export type AppliedAction = { name: string; ok: boolean; message: string };

export type ApplyPlanResult = {
  text: string;
  actions: AppliedAction[];
  store: WorkspaceStore;
  storeChanged: boolean;
};

/**
 * Executes an approved OrganizationPlan for real, reusing the same
 * runAction() dispatch (validate + registered action.run()) for every
 * single mutation. The only thing bespoke here is the SEQUENCING: a
 * workspace proposal's target id isn't known until create_workspace
 * actually runs, so this resolves each proposal's real target id before
 * issuing its move_tabs/create_group calls, threading the working store
 * through as it goes.
 *
 * Revalidates the plan against the CURRENT store first (the store may have
 * changed since the plan was proposed). A failed validation applies
 * nothing.
 *
 * A group proposal creates the group (create_group) when it isn't reusing
 * an existing one (OrganizeGroupProposal.existingGroupId), then actually
 * assigns its tabIds via assign_tabs_to_group — same "resolve the real id
 * before the next call" sequencing as a brand-new workspace's id above,
 * since a freshly created group's id isn't known until create_group runs.
 */
export function applyOrganizationPlan(plan: OrganizationPlan, store: WorkspaceStore): ApplyPlanResult {
  const validation = validateOrganizationPlan(plan, store);
  if (!validation.ok) {
    return {
      text: `Couldn't apply that organization: ${validation.errors[0]}`,
      actions: [],
      store,
      storeChanged: false,
    };
  }

  let current = store;
  const actions: AppliedAction[] = [];

  for (const proposal of plan.workspaces) {
    let targetWorkspaceId = proposal.existingWorkspaceId;

    if (!targetWorkspaceId) {
      const outcome = runAction("create_workspace", { name: proposal.proposedName }, current);
      if (!outcome.ok) {
        actions.push({ name: "create_workspace", ok: false, message: outcome.message });
        continue;
      }
      current = outcome.store;
      targetWorkspaceId = (outcome.data as { workspace: { workspaceId: string } }).workspace.workspaceId;
      actions.push({ name: "create_workspace", ok: true, message: JSON.stringify(outcome.data) });
    }

    const tabIds = proposal.tabs.map((t) => t.tabId);
    if (tabIds.length > 0) {
      const outcome = runAction("move_tabs", { tabIds, targetWorkspaceId }, current);
      if (outcome.ok) {
        current = outcome.store;
        actions.push({ name: "move_tabs", ok: true, message: JSON.stringify(outcome.data) });
      } else {
        actions.push({ name: "move_tabs", ok: false, message: outcome.message });
      }
    }

    for (const group of proposal.groups ?? []) {
      let targetGroupId = group.existingGroupId;

      if (!targetGroupId) {
        const outcome = runAction("create_group", { workspaceId: targetWorkspaceId, name: group.proposedName }, current);
        if (!outcome.ok) {
          actions.push({ name: "create_group", ok: false, message: outcome.message });
          continue;
        }
        current = outcome.store;
        targetGroupId = (outcome.data as { group: { groupId: string } }).group.groupId;
        actions.push({ name: "create_group", ok: true, message: JSON.stringify(outcome.data) });
      }

      if (group.tabIds.length > 0) {
        const outcome = runAction("assign_tabs_to_group", { workspaceId: targetWorkspaceId, tabIds: group.tabIds, groupId: targetGroupId }, current);
        if (outcome.ok) {
          current = outcome.store;
          actions.push({ name: "assign_tabs_to_group", ok: true, message: JSON.stringify(outcome.data) });
        } else {
          actions.push({ name: "assign_tabs_to_group", ok: false, message: outcome.message });
        }
      }
    }
  }

  return {
    text: describeOrganizationApplied(plan),
    actions,
    store: current,
    storeChanged: current !== store,
  };
}
