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
