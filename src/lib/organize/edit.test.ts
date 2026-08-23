import { describe, expect, it } from "vitest";
import { resolveUncertainTab } from "./edit";
import type { OrganizationPlan } from "./types";

function basePlan(): OrganizationPlan {
  return {
    summary: "s",
    workspaces: [{ existingWorkspaceId: "ws-physics", proposedName: "Physics", reason: "r", tabs: [] }],
    uncertainTabs: [
      { tabId: "g1", reason: "r", currentWorkspaceId: "ws-inbox", currentWorkspaceName: "Inbox", suggestions: [{ workspaceId: "ws-inbox", name: 'Keep in "Inbox"' }, { workspaceId: "ws-physics", name: "Physics" }] },
    ],
    duplicates: [],
    totalTabsConsidered: 1,
  };
}

describe("resolveUncertainTab", () => {
  it("removes the tab from uncertainTabs without adding it anywhere when the choice is Keep", () => {
    const plan = basePlan();
    const next = resolveUncertainTab(plan, "g1", { workspaceId: "ws-inbox", name: 'Keep in "Inbox"' });
    expect(next.uncertainTabs).toEqual([]);
    expect(next.workspaces[0].tabs).toEqual([]);
  });

  it("adds the tab to the matching existing workspace proposal", () => {
    const plan = basePlan();
    const next = resolveUncertainTab(plan, "g1", { workspaceId: "ws-physics", name: "Physics" });
    expect(next.uncertainTabs).toEqual([]);
    expect(next.workspaces[0].tabs.map((t) => t.tabId)).toEqual(["g1"]);
  });

  it("creates a new Miscellaneous proposal on the fly when none exists yet", () => {
    const plan = basePlan();
    const next = resolveUncertainTab(plan, "g1", { name: "Miscellaneous" });
    const misc = next.workspaces.find((w) => w.proposedName === "Miscellaneous");
    expect(misc?.tabs.map((t) => t.tabId)).toEqual(["g1"]);
  });

  it("is a no-op for an already-resolved tab id", () => {
    const plan = basePlan();
    plan.uncertainTabs = [];
    const next = resolveUncertainTab(plan, "g1", { name: "Physics" });
    expect(next).toEqual(plan);
  });
});
