import { describe, expect, it } from "vitest";
import { isValidOrganizationPlanInput, validateOrganizationPlan } from "./validate";
import type { OrganizationPlan } from "./types";
import type { WorkspaceStore } from "@/lib/workspace/types";

function store(): WorkspaceStore {
  return {
    version: 1,
    currentId: "ws-1",
    workspaces: [
      { id: "ws-1", name: "Inbox", tabs: [{ id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" }], createdAt: 0, updatedAt: 0 },
      { id: "ws-2", name: "Physics", tabs: [{ id: "t2", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example" }], createdAt: 0, updatedAt: 0 },
    ],
  };
}

function basePlan(): OrganizationPlan {
  return {
    summary: "s",
    workspaces: [{ existingWorkspaceId: "ws-2", proposedName: "Physics", reason: "r", tabs: [{ tabId: "t1", reason: "r", confidence: "high" }] }],
    uncertainTabs: [],
    duplicates: [],
    totalTabsConsidered: 2,
  };
}

describe("validateOrganizationPlan", () => {
  it("accepts a well-formed plan", () => {
    expect(validateOrganizationPlan(basePlan(), store())).toEqual({ ok: true });
  });

  it("rejects an unknown tab id", () => {
    const plan = basePlan();
    plan.workspaces[0].tabs = [{ tabId: "no-such-tab", reason: "r", confidence: "high" }];
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
  });

  it("rejects a tab assigned twice", () => {
    const plan = basePlan();
    plan.workspaces.push({ existingWorkspaceId: "ws-2", proposedName: "Also Physics", reason: "r", tabs: [{ tabId: "t1", reason: "r", confidence: "low" }] });
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("more than once"))).toBe(true);
  });

  it("rejects an unknown existingWorkspaceId", () => {
    const plan = basePlan();
    plan.workspaces[0].existingWorkspaceId = "ws-nonexistent";
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
  });

  it("rejects an empty proposed workspace name", () => {
    const plan = basePlan();
    plan.workspaces[0].proposedName = "   ";
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
  });

  it("rejects an uncertain tab referencing an unknown current workspace id", () => {
    const plan = basePlan();
    plan.workspaces[0].tabs = [];
    plan.workspaces[0].groups = [{ proposedName: "sub", reason: "r", tabIds: [] }];
    plan.uncertainTabs = [{ tabId: "t2", reason: "r", currentWorkspaceId: "ws-missing", currentWorkspaceName: "?", suggestions: [] }];
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
  });

  it("accepts a group with a valid existingGroupId in the target workspace", () => {
    const s = store();
    s.workspaces[1].groups = [{ id: "g1", name: "IA", createdAt: 0, updatedAt: 0 }];
    const plan = basePlan();
    plan.workspaces[0].groups = [{ existingGroupId: "g1", proposedName: "IA", reason: "r", tabIds: ["t1"] }];
    expect(validateOrganizationPlan(plan, s)).toEqual({ ok: true });
  });

  it("rejects a group referencing an existingGroupId that doesn't exist in the target workspace", () => {
    const plan = basePlan();
    plan.workspaces[0].groups = [{ existingGroupId: "ghost", proposedName: "IA", reason: "r", tabIds: [] }];
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
  });

  it("rejects an existingGroupId on a proposal for a brand-new workspace", () => {
    const plan = basePlan();
    plan.workspaces[0].existingWorkspaceId = undefined;
    plan.workspaces[0].groups = [{ existingGroupId: "g1", proposedName: "IA", reason: "r", tabIds: [] }];
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
  });

  it("rejects the same tab appearing in two different groups", () => {
    const plan = basePlan();
    plan.workspaces[0].groups = [
      { proposedName: "IA", reason: "r", tabIds: ["t1"] },
      { proposedName: "References", reason: "r", tabIds: ["t1"] },
    ];
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("more than one group"))).toBe(true);
  });

  it("allows the same tab in both the workspace's tabs (being moved in) and one of its groups", () => {
    const s = store();
    const plan = basePlan();
    plan.workspaces[0].groups = [{ proposedName: "IA", reason: "r", tabIds: ["t1"] }];
    expect(validateOrganizationPlan(plan, s)).toEqual({ ok: true });
  });

  it("rejects a group tab that isn't actually part of its workspace proposal", () => {
    const plan = basePlan();
    // t2 lives in ws-2 already, but this proposal's target is ws-2 too — so
    // that alone would be fine. Use a genuinely-unrelated resident instead:
    // t2 is in ws-2, and this proposal's tabs only move t1 in, so a group
    // referencing t2 IS valid (already resident). To trigger the failure,
    // reference a tab that belongs to neither the mover list nor the target.
    plan.workspaces[0].tabs = [];
    plan.workspaces[0].groups = [{ proposedName: "IA", reason: "r", tabIds: ["t1"] }];
    // t1 lives in ws-1, not ws-2 (the proposal's existingWorkspaceId), and
    // isn't in `tabs` (empty) — so it will never actually be in ws-2.
    const result = validateOrganizationPlan(plan, store());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("isn't in workspace proposal"))).toBe(true);
  });

  it("allows a group tab that's already resident in the target workspace without being in the move list", () => {
    const plan = basePlan();
    plan.workspaces[0].tabs = []; // no moves — t2 is already in ws-2
    plan.workspaces[0].groups = [{ proposedName: "IA", reason: "r", tabIds: ["t2"] }];
    expect(validateOrganizationPlan(plan, store())).toEqual({ ok: true });
  });
});

describe("isValidOrganizationPlanInput", () => {
  it("accepts a well-formed plan shape", () => {
    expect(isValidOrganizationPlanInput(basePlan())).toBe(true);
  });

  it("rejects malformed input (missing required fields)", () => {
    expect(isValidOrganizationPlanInput({ summary: "s" })).toBe(false);
    expect(isValidOrganizationPlanInput(null)).toBe(false);
    expect(isValidOrganizationPlanInput("not a plan")).toBe(false);
    expect(isValidOrganizationPlanInput({ ...basePlan(), workspaces: [{ proposedName: "x" }] })).toBe(false);
  });
});
