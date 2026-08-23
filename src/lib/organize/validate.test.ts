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
