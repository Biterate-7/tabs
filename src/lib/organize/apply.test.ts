import { describe, expect, it } from "vitest";
import { applyOrganizationPlan } from "./apply";
import type { OrganizationPlan } from "./types";
import type { WorkspaceStore } from "@/lib/workspace/types";

function store(): WorkspaceStore {
  return {
    version: 1,
    currentId: "ws-1",
    workspaces: [
      {
        id: "ws-1",
        name: "Inbox",
        tabs: [
          { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", title: "Physics 1" },
          { id: "t2", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example", title: "Physics 2" },
          { id: "t3", url: "https://c.example", normalizedUrl: "https://c.example", domain: "c.example", title: "MUN 1" },
        ],
        createdAt: 0,
        updatedAt: 0,
      },
      { id: "ws-2", name: "Physics", tabs: [], createdAt: 0, updatedAt: 0 },
    ],
  };
}

describe("applyOrganizationPlan", () => {
  it("creates a new workspace and moves its tabs in one logical operation", () => {
    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [
        {
          proposedName: "MUN",
          reason: "r",
          tabs: [{ tabId: "t3", reason: "r", confidence: "high" }],
        },
      ],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 3,
    };

    const result = applyOrganizationPlan(plan, store());
    expect(result.storeChanged).toBe(true);
    const mun = result.store.workspaces.find((w) => w.name === "MUN");
    expect(mun).toBeTruthy();
    expect(mun!.tabs.map((t) => t.id)).toEqual(["t3"]);
    expect(result.text).toContain("Organized");
  });

  it("reuses an existing workspace via existingWorkspaceId rather than creating a new one", () => {
    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [
        {
          existingWorkspaceId: "ws-2",
          proposedName: "Physics",
          reason: "r",
          tabs: [
            { tabId: "t1", reason: "r", confidence: "high" },
            { tabId: "t2", reason: "r", confidence: "high" },
          ],
        },
      ],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 3,
    };

    const result = applyOrganizationPlan(plan, store());
    const workspaceCount = result.store.workspaces.length;
    expect(workspaceCount).toBe(2); // no new workspace created
    const physics = result.store.workspaces.find((w) => w.id === "ws-2")!;
    expect(physics.tabs.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("creates a group under the target workspace", () => {
    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [
        {
          existingWorkspaceId: "ws-2",
          proposedName: "Physics",
          reason: "r",
          tabs: [],
          groups: [{ proposedName: "IA", reason: "r", tabIds: [] }],
        },
      ],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 0,
    };

    const result = applyOrganizationPlan(plan, store());
    const physics = result.store.workspaces.find((w) => w.id === "ws-2")!;
    expect(physics.groups?.map((g) => g.name)).toEqual(["IA"]);
  });

  it("creates a group and actually assigns its tabs to it", () => {
    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [
        {
          existingWorkspaceId: "ws-2",
          proposedName: "Physics",
          reason: "r",
          tabs: [{ tabId: "t1", reason: "r", confidence: "high" }, { tabId: "t2", reason: "r", confidence: "high" }],
          groups: [{ proposedName: "IA", reason: "r", tabIds: ["t1", "t2"] }],
        },
      ],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 2,
    };

    const result = applyOrganizationPlan(plan, store());
    const physics = result.store.workspaces.find((w) => w.id === "ws-2")!;
    const iaGroup = physics.groups!.find((g) => g.name === "IA")!;
    expect(physics.tabs.every((t) => t.groupId === iaGroup.id)).toBe(true);
  });

  it("assigns tabs into an existing group via existingGroupId without creating a new one", () => {
    const s = store();
    s.workspaces[1].groups = [{ id: "existing-group", name: "IA", createdAt: 0, updatedAt: 0 }];

    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [
        {
          existingWorkspaceId: "ws-2",
          proposedName: "Physics",
          reason: "r",
          tabs: [{ tabId: "t1", reason: "r", confidence: "high" }],
          groups: [{ existingGroupId: "existing-group", proposedName: "IA", reason: "r", tabIds: ["t1"] }],
        },
      ],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 1,
    };

    const result = applyOrganizationPlan(plan, s);
    const physics = result.store.workspaces.find((w) => w.id === "ws-2")!;
    expect(physics.groups).toHaveLength(1); // no second group created
    expect(physics.groups![0].id).toBe("existing-group");
    expect(physics.tabs.find((t) => t.id === "t1")!.groupId).toBe("existing-group");
  });

  it("applies a full workspace-move + group-creation + tab-assignment plan as one operation", () => {
    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [
        {
          proposedName: "MUN",
          reason: "r",
          tabs: [{ tabId: "t3", reason: "r", confidence: "high" }],
          groups: [{ proposedName: "Research", reason: "r", tabIds: ["t3"] }],
        },
      ],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 1,
    };

    const result = applyOrganizationPlan(plan, store());
    const mun = result.store.workspaces.find((w) => w.name === "MUN")!;
    const researchGroup = mun.groups!.find((g) => g.name === "Research")!;
    expect(mun.tabs[0].id).toBe("t3");
    expect(mun.tabs[0].groupId).toBe(researchGroup.id);
  });

  it("applies a combined multi-workspace plan as one operation", () => {
    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [
        { existingWorkspaceId: "ws-2", proposedName: "Physics", reason: "r", tabs: [{ tabId: "t1", reason: "r", confidence: "high" }] },
        { proposedName: "MUN", reason: "r", tabs: [{ tabId: "t3", reason: "r", confidence: "high" }] },
      ],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 3,
    };

    const result = applyOrganizationPlan(plan, store());
    expect(result.store.workspaces.find((w) => w.id === "ws-2")!.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(result.store.workspaces.find((w) => w.name === "MUN")!.tabs.map((t) => t.id)).toEqual(["t3"]);
    expect(result.store.workspaces).toHaveLength(3);
  });

  it("refuses to apply an invalid plan and leaves the store untouched", () => {
    const plan: OrganizationPlan = {
      summary: "s",
      workspaces: [{ proposedName: "X", reason: "r", tabs: [{ tabId: "no-such-tab", reason: "r", confidence: "high" }] }],
      uncertainTabs: [],
      duplicates: [],
      totalTabsConsidered: 1,
    };

    const before = store();
    const result = applyOrganizationPlan(plan, before);
    expect(result.storeChanged).toBe(false);
    expect(result.store).toBe(before);
    expect(result.text).toContain("Couldn't apply");
  });
});
