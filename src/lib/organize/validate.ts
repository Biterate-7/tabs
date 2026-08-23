import type { WorkspaceStore } from "@/lib/workspace/types";
import type { OrganizationPlan } from "./types";

export type OrganizationPlanValidation = { ok: true } | { ok: false; errors: string[] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Structural shape check for an OrganizationPlan arriving over the wire
 * (the client round-trips the plan it showed the user back for Apply — see
 * /api/ai/ask's "agent-organize-apply" mode). Distinct from
 * validateOrganizationPlan below: this only confirms the JSON has the right
 * shape to even attempt semantic validation against a store; a
 * shape-malformed plan (AGENTS.md section 16's "malformed AI plan" case)
 * fails here before ever reaching it.
 */
export function isValidOrganizationPlanInput(value: unknown): value is OrganizationPlan {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (typeof p.summary !== "string") return false;
  if (typeof p.totalTabsConsidered !== "number") return false;
  if (!Array.isArray(p.workspaces) || !Array.isArray(p.uncertainTabs) || !Array.isArray(p.duplicates)) return false;

  const workspacesValid = p.workspaces.every((w) => {
    if (!w || typeof w !== "object") return false;
    const rec = w as Record<string, unknown>;
    if (typeof rec.proposedName !== "string" || typeof rec.reason !== "string") return false;
    if (rec.existingWorkspaceId !== undefined && typeof rec.existingWorkspaceId !== "string") return false;
    if (!Array.isArray(rec.tabs)) return false;
    const tabsValid = rec.tabs.every(
      (t) => t && typeof t === "object" && typeof (t as Record<string, unknown>).tabId === "string" && typeof (t as Record<string, unknown>).confidence === "string"
    );
    if (!tabsValid) return false;
    if (rec.groups === undefined) return true;
    if (!Array.isArray(rec.groups)) return false;
    return rec.groups.every(
      (g) =>
        g &&
        typeof g === "object" &&
        typeof (g as Record<string, unknown>).proposedName === "string" &&
        isStringArray((g as Record<string, unknown>).tabIds)
    );
  });
  if (!workspacesValid) return false;

  const uncertainValid = p.uncertainTabs.every(
    (u) =>
      u &&
      typeof u === "object" &&
      typeof (u as Record<string, unknown>).tabId === "string" &&
      typeof (u as Record<string, unknown>).currentWorkspaceId === "string"
  );
  if (!uncertainValid) return false;

  return p.duplicates.every(
    (d) => d && typeof d === "object" && isStringArray((d as Record<string, unknown>).tabIds)
  );
}

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
  const seenTabIds = new Set<string>();

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
    for (const group of proposal.groups ?? []) {
      if (!group.proposedName || !group.proposedName.trim()) {
        errors.push(`A group under "${proposal.proposedName}" has an empty name.`);
      }
      for (const tabId of group.tabIds) {
        if (!knownTabIds.has(tabId)) {
          errors.push(`Unknown tab id "${tabId}" referenced in group "${group.proposedName}".`);
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
