import { runAction } from "@/lib/actions/run";
import type { ActionRunContext } from "@/lib/actions/types";
import type { AppliedAction, ApplyPlanResult } from "@/lib/actions/plan";
import type { WorkspaceStore } from "@/lib/workspace/types";
import type { OrganizationPlan } from "./types";
import { validateOrganizationPlan } from "./validate";
import { describeOrganizationApplied } from "./summarize";

/**
 * Executes an approved OrganizationPlan for real — the Auto-Organize
 * equivalent of src/lib/actions/plan.ts's applyPlan(), reusing the exact
 * same runAction() dispatch (validate + registered action.run()) for every
 * single mutation, per AGENTS.md section 2 ("do not bypass action
 * validation... Apply/Cancel... WorkspaceStore persistence"). The only
 * thing bespoke here is the SEQUENCING: a workspace proposal's target id
 * isn't known until create_workspace actually runs, so — unlike
 * applyPlan()'s flat replay of a fixed args list — this resolves each
 * proposal's real target id before issuing its move_tabs/create_group
 * calls, threading the working store through exactly like applyPlan() does.
 *
 * Revalidates the plan against the CURRENT store first (the store may have
 * changed since the plan was proposed — same "never trust a stale preview"
 * rule every other Apply path in this codebase follows). A failed
 * validation applies nothing.
 *
 * Group proposals only ever create the group itself (create_group) — there
 * is no tab→group assignment action anywhere in TabDump yet, so a group's
 * `tabIds` stay descriptive (surfaced to the user, not enacted) until that
 * capability exists. This is a deliberate, conservative scope choice, not
 * an oversight — see AGENTS.md section 13.
 */
export function applyOrganizationPlan(plan: OrganizationPlan, store: WorkspaceStore, ctx?: ActionRunContext): ApplyPlanResult {
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
      const outcome = runAction("create_workspace", { name: proposal.proposedName }, current, ctx);
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
      const outcome = runAction("move_tabs", { tabIds, targetWorkspaceId }, current, ctx);
      if (outcome.ok) {
        current = outcome.store;
        actions.push({ name: "move_tabs", ok: true, message: JSON.stringify(outcome.data) });
      } else {
        actions.push({ name: "move_tabs", ok: false, message: outcome.message });
      }
    }

    for (const group of proposal.groups ?? []) {
      const outcome = runAction("create_group", { workspaceId: targetWorkspaceId, name: group.proposedName }, current, ctx);
      if (outcome.ok) {
        current = outcome.store;
        actions.push({ name: "create_group", ok: true, message: JSON.stringify(outcome.data) });
      } else {
        actions.push({ name: "create_group", ok: false, message: outcome.message });
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
