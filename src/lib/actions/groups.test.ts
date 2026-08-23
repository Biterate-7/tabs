import { describe, expect, it } from "vitest";
import { createGroupAction, renameGroupAction, listGroupsAction, getGroupAction, listGroupTabsAction } from "./groups";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeTab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", ...over };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("create_group action", () => {
  it("creates a group within the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = createGroupAction.validate({ workspaceId: "a", name: "Midterms" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = createGroupAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.group.name).toBe("Midterms");
    expect(result.store?.workspaces[0].groups?.[0].name).toBe("Midterms");
  });

  it("fails for a nonexistent workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = createGroupAction.validate({ workspaceId: "ghost", name: "X" });
    if (!validated.ok) throw new Error("expected validation to pass");
    expect(createGroupAction.run(store, validated.args).ok).toBe(false);
  });
});

describe("rename_group action", () => {
  it("renames an existing group", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const created = createGroupAction.run(store, { workspaceId: "a", name: "Old" });
    if (!created.ok) throw new Error("expected create to pass");
    const groupId = (created.data as { group: { groupId: string } }).group.groupId;

    const validated = renameGroupAction.validate({ workspaceId: "a", groupId, name: "New" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = renameGroupAction.run(created.store!, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store?.workspaces[0].groups?.[0].name).toBe("New");
  });

  it("fails for a group id that doesn't exist in the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = renameGroupAction.validate({ workspaceId: "a", groupId: "ghost", name: "New" });
    if (!validated.ok) throw new Error("expected validation to pass");
    expect(renameGroupAction.run(store, validated.args).ok).toBe(false);
  });
});

describe("list_groups action", () => {
  it("lists a workspace's groups with tab counts", () => {
    const store = makeStore(
      [
        makeWorkspace({
          id: "a",
          groups: [{ id: "g1", name: "Physics", createdAt: 0, updatedAt: 0 }, { id: "g2", name: "MUN", createdAt: 0, updatedAt: 0 }],
          tabs: [makeTab("1", { groupId: "g1" }), makeTab("2", { groupId: "g1" }), makeTab("3")],
        }),
      ],
      "a"
    );
    const result = listGroupsAction.run(store, { workspaceId: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.groups).toEqual([
      { groupId: "g1", name: "Physics", tabCount: 2 },
      { groupId: "g2", name: "MUN", tabCount: 0 },
    ]);
  });

  it("returns an empty list for a workspace with no groups", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = listGroupsAction.run(store, { workspaceId: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.groups).toEqual([]);
  });

  it("fails for a nonexistent workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    expect(listGroupsAction.run(store, { workspaceId: "ghost" }).ok).toBe(false);
  });
});

describe("get_group action", () => {
  it("returns a group's details and sample tabs", () => {
    const store = makeStore(
      [
        makeWorkspace({
          id: "a",
          groups: [{ id: "g1", name: "General Relativity", createdAt: 0, updatedAt: 0 }],
          tabs: [makeTab("1", { groupId: "g1", title: "Schwarzschild metric" }), makeTab("2")],
        }),
      ],
      "a"
    );
    const result = getGroupAction.run(store, { workspaceId: "a", groupId: "g1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("General Relativity");
    expect(result.data.tabCount).toBe(1);
    expect(result.data.sampleTabs.map((t) => t.tabId)).toEqual(["1"]);
  });

  it("fails for a nonexistent group", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    expect(getGroupAction.run(store, { workspaceId: "a", groupId: "ghost" }).ok).toBe(false);
  });
});

describe("list_group_tabs action", () => {
  it("lists only the tabs in the given group", () => {
    const store = makeStore(
      [
        makeWorkspace({
          id: "a",
          groups: [{ id: "g1", name: "Physics", createdAt: 0, updatedAt: 0 }],
          tabs: [makeTab("1", { groupId: "g1" }), makeTab("2", { groupId: "g1" }), makeTab("3")],
        }),
      ],
      "a"
    );
    const result = listGroupTabsAction.run(store, { workspaceId: "a", groupId: "g1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(2);
    expect(result.data.tabs.map((t) => t.tabId).sort()).toEqual(["1", "2"]);
  });

  it("applies an optional keyword filter", () => {
    const store = makeStore(
      [
        makeWorkspace({
          id: "a",
          groups: [{ id: "g1", name: "Physics", createdAt: 0, updatedAt: 0 }],
          tabs: [makeTab("1", { groupId: "g1", title: "Schwarzschild metric" }), makeTab("2", { groupId: "g1", title: "Orbital data" })],
        }),
      ],
      "a"
    );
    const result = listGroupTabsAction.run(store, { workspaceId: "a", groupId: "g1", query: "schwarzschild" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tabs.map((t) => t.tabId)).toEqual(["1"]);
  });

  it("fails for a nonexistent group", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    expect(listGroupTabsAction.run(store, { workspaceId: "a", groupId: "ghost" }).ok).toBe(false);
  });
});
