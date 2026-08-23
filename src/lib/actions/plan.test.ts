import { describe, expect, it } from "vitest";
import {
  applyPlan,
  describePlannedAction,
  isValidPlanInput,
  planRequiresConfirmation,
  summarizePlan,
} from "./plan";
import type { PlannedAction } from "./plan";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

function plannedAction(over: Partial<PlannedAction> & { name: string }): PlannedAction {
  return { args: {}, label: over.name, affected: 1, ...over };
}

describe("planRequiresConfirmation", () => {
  it("is false for an empty plan", () => {
    expect(planRequiresConfirmation([])).toBe(false);
  });

  it("is false for a single action affecting few resources", () => {
    expect(planRequiresConfirmation([plannedAction({ name: "move_tab", affected: 1 })])).toBe(false);
  });

  it("is true once total affected resources exceed the threshold, even for a single action", () => {
    expect(planRequiresConfirmation([plannedAction({ name: "move_tabs", affected: 4 })])).toBe(true);
  });

  it("is true for more than one write action, regardless of size", () => {
    const plan = [plannedAction({ name: "create_group", affected: 1 }), plannedAction({ name: "create_group", affected: 1 })];
    expect(planRequiresConfirmation(plan)).toBe(true);
  });

  it("is false for a single open_tabs action no matter how many tabs it opens", () => {
    expect(planRequiresConfirmation([plannedAction({ name: "open_tabs", affected: 12 })])).toBe(false);
  });

  it("is false for a single open_workspace_in_browser action opening many tabs", () => {
    expect(planRequiresConfirmation([plannedAction({ name: "open_workspace_in_browser", affected: 20 })])).toBe(false);
  });

  it("is false for a single close_tab (one specific tab)", () => {
    expect(planRequiresConfirmation([plannedAction({ name: "close_tab", affected: 1 })])).toBe(false);
  });

  it("is true for a bulk close_tabs even when under the generic affected threshold", () => {
    expect(planRequiresConfirmation([plannedAction({ name: "close_tabs", affected: 2 })])).toBe(true);
  });

  it("is true for a large bulk close_tabs", () => {
    expect(planRequiresConfirmation([plannedAction({ name: "close_tabs", affected: 27 })])).toBe(true);
  });

  it("still requires confirmation when an open action is combined with another write action", () => {
    const plan = [plannedAction({ name: "open_tabs", affected: 3 }), plannedAction({ name: "pin_tab", affected: 1 })];
    expect(planRequiresConfirmation(plan)).toBe(true);
  });
});

describe("describePlannedAction", () => {
  it("describes create_workspace", () => {
    expect(describePlannedAction("create_workspace", { workspace: { name: "MUN" } })).toEqual({
      label: 'Create workspace → "MUN"',
      affected: 1,
    });
  });

  it("describes move_tabs with the resolved target name and moved count", () => {
    expect(describePlannedAction("move_tabs", { targetWorkspaceName: "Physics IA", movedCount: 7 })).toEqual({
      label: 'Move 7 tabs → "Physics IA"',
      affected: 7,
    });
  });

  it("singularizes a one-tab move", () => {
    expect(describePlannedAction("move_tab", { targetWorkspaceName: "Research", movedCount: 1 })).toEqual({
      label: 'Move 1 tab → "Research"',
      affected: 1,
    });
  });

  it("describes open_tabs, close_tabs, pin_tab, and create_browser_window", () => {
    expect(describePlannedAction("open_tabs", { urlCount: 5 })).toEqual({ label: "Open 5 tabs", affected: 5 });
    expect(describePlannedAction("close_tabs", { count: 27 })).toEqual({ label: "Close 27 browser tabs", affected: 27 });
    expect(describePlannedAction("pin_tab", { tabId: 7 })).toEqual({ label: "Pin browser tab (id 7)", affected: 1 });
    expect(describePlannedAction("create_browser_window", { urls: ["https://a.com"] })).toEqual({
      label: "Create a new browser window with 1 tab",
      affected: 1,
    });
  });

  it("describes create_group and rename_group", () => {
    expect(describePlannedAction("create_group", { group: { name: "References" } })).toEqual({
      label: 'Create group → "References"',
      affected: 1,
    });
    expect(describePlannedAction("rename_group", { group: { name: "New name" } })).toEqual({
      label: 'Rename group → "New name"',
      affected: 1,
    });
  });

  it("describes assign_tabs_to_group and remove_tabs_from_group", () => {
    expect(describePlannedAction("assign_tabs_to_group", { assignedCount: 6, groupName: "General Relativity" })).toEqual({
      label: 'Assign 6 tabs → group "General Relativity"',
      affected: 6,
    });
    expect(describePlannedAction("remove_tabs_from_group", { removedCount: 1 })).toEqual({
      label: "Remove 1 tab from their group",
      affected: 1,
    });
  });
});

describe("summarizePlan", () => {
  it("summarizes a mix of group creation and tab moves", () => {
    const plan = [
      plannedAction({ name: "create_group", affected: 1 }),
      plannedAction({ name: "create_group", affected: 1 }),
      plannedAction({ name: "create_group", affected: 1 }),
      plannedAction({ name: "move_tabs", affected: 18 }),
    ];
    expect(summarizePlan(plan)).toBe("This will create 3 groups and move 18 tabs.");
  });

  it("uses singular phrasing for a single item", () => {
    expect(summarizePlan([plannedAction({ name: "create_workspace", affected: 1 })])).toBe("This will create 1 workspace.");
  });

  it("returns a no-op message for an empty plan", () => {
    expect(summarizePlan([])).toBe("This makes no changes.");
  });

  it("summarizes group assignment and removal", () => {
    const plan = [plannedAction({ name: "assign_tabs_to_group", affected: 6 }), plannedAction({ name: "remove_tabs_from_group", affected: 2 })];
    expect(summarizePlan(plan)).toBe("This will group 6 tabs and ungroup 2 tabs.");
  });
});

describe("isValidPlanInput", () => {
  it("accepts a well-formed plan array", () => {
    expect(isValidPlanInput([{ name: "move_tab", args: { tabId: "1", targetWorkspaceId: "a" } }])).toBe(true);
  });

  it("rejects an empty array", () => {
    expect(isValidPlanInput([])).toBe(false);
  });

  it("rejects entries missing a name or args", () => {
    expect(isValidPlanInput([{ args: {} }])).toBe(false);
    expect(isValidPlanInput([{ name: "move_tab" }])).toBe(false);
  });

  it("rejects a non-array payload", () => {
    expect(isValidPlanInput({ name: "move_tab", args: {} })).toBe(false);
    expect(isValidPlanInput(null)).toBe(false);
  });
});

describe("applyPlan", () => {
  it("executes every step in order against the given store and reports success", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const plan = [
      { name: "create_workspace", args: { name: "College Research" } },
      { name: "create_group", args: { workspaceId: "a", name: "Midterms" } },
    ];

    const result = applyPlan(plan, store);

    expect(result.storeChanged).toBe(true);
    expect(result.store.workspaces.map((w) => w.name)).toEqual(["Untitled", "College Research"]);
    expect(result.store.workspaces[0].groups?.[0].name).toBe("Midterms");
    expect(result.actions).toEqual([
      { name: "create_workspace", ok: true, message: expect.any(String) },
      { name: "create_group", ok: true, message: expect.any(String) },
    ]);
    expect(result.text).toMatch(/^Done —/);
  });

  it("revalidates every step from scratch — a stale/nonexistent resource fails cleanly, not silently", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const plan = [{ name: "move_tab", args: { tabId: "ghost", targetWorkspaceId: "a" } }];

    const result = applyPlan(plan, store);

    expect(result.storeChanged).toBe(false);
    expect(result.actions).toEqual([{ name: "move_tab", ok: false, message: expect.any(String) }]);
    expect(result.text).not.toMatch(/^Done —/);
    expect(result.text).toContain("Nothing was changed");
  });

  it("continues past a failed step and does not silently report full success for a partial failure", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com" }] })], "a");
    const plan = [
      { name: "move_tab", args: { tabId: "1", targetWorkspaceId: "a" } }, // succeeds (no-op move into itself is still a valid move)
      { name: "move_tab", args: { tabId: "ghost", targetWorkspaceId: "a" } }, // fails
    ];

    const result = applyPlan(plan, store);

    expect(result.actions.map((a) => a.ok)).toEqual([true, false]);
    expect(result.text).toContain("Done —");
    expect(result.text).toContain("failed");
  });

  it("attaches args/data to a browser action's applied result, but not to an ordinary TabDump action's", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const plan = [
      { name: "create_workspace", args: { name: "Research" } },
      { name: "open_tabs", args: { urls: ["https://a.com"] } },
    ];

    const result = applyPlan(plan, store, { browserContext: { tabs: [], windows: [], activeTabId: null } });

    expect(result.actions[0]).toEqual({ name: "create_workspace", ok: true, message: expect.any(String) });
    expect(result.actions[1]).toMatchObject({ name: "open_tabs", ok: true, args: { urls: ["https://a.com"] }, data: { urlCount: 1, urls: ["https://a.com"] } });
  });

  it("fails a browser write action when no browserContext is given (extension not connected at apply time)", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = applyPlan([{ name: "open_tabs", args: { urls: ["https://a.com"] } }], store);
    expect(result.actions).toEqual([{ name: "open_tabs", ok: false, message: expect.stringContaining("isn't connected") }]);
  });

  it("creates a group and assigns tabs to it across two plan steps", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com" }] })],
      "a"
    );
    const created = applyPlan([{ name: "create_group", args: { workspaceId: "a", name: "Physics" } }], store);
    const groupId = created.actions[0].message.includes("groupId")
      ? (JSON.parse(created.actions[0].message).group.groupId as string)
      : "";
    expect(groupId).toBeTruthy();

    const result = applyPlan([{ name: "assign_tabs_to_group", args: { workspaceId: "a", tabIds: ["1"], groupId } }], created.store);
    expect(result.storeChanged).toBe(true);
    expect(result.store.workspaces[0].tabs[0].groupId).toBe(groupId);
    expect(result.text).toMatch(/^Done —/);
  });

  it("rejects a plan action whose scope no longer matches (workspace it was validated against has since changed)", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [{ id: "1", url: "https://x.com", normalizedUrl: "https://x.com", domain: "x.com" }] }), makeWorkspace({ id: "b" })],
      "a"
    );
    // Claims the tab lives in "b", but it's actually in "a" — must not silently reach into "a".
    const plan = [{ name: "move_tab", args: { tabId: "1", targetWorkspaceId: "b", sourceWorkspaceId: "b" } }];

    const result = applyPlan(plan, store);

    expect(result.actions).toEqual([{ name: "move_tab", ok: false, message: expect.any(String) }]);
    expect(result.store.workspaces[0].tabs).toHaveLength(1);
  });
});
