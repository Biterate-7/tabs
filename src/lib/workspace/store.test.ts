import { describe, expect, it } from "vitest";
import {
  addWorkspaces,
  assignTabsToGroup,
  createGroup,
  createWorkspace,
  deleteWorkspace,
  getCurrentWorkspace,
  moveTabsBetweenWorkspaces,
  removeTabsFromGroup,
  renameGroup,
  renameWorkspace,
  switchWorkspace,
  updateWorkspaceTabs,
} from "./store";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "./types";

function makeTab(id: string): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com" };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("getCurrentWorkspace", () => {
  it("returns the workspace matching currentId", () => {
    const a = makeWorkspace({ id: "a" });
    const b = makeWorkspace({ id: "b" });
    expect(getCurrentWorkspace(makeStore([a, b], "b"))).toBe(b);
  });

  it("falls back to the first workspace if currentId is stale/corrupted", () => {
    const a = makeWorkspace({ id: "a" });
    expect(getCurrentWorkspace(makeStore([a], "missing"))).toBe(a);
  });
});

describe("createWorkspace", () => {
  it("adds a new empty workspace and switches to it", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const next = createWorkspace(store, "Research");

    expect(next.workspaces).toHaveLength(2);
    const created = next.workspaces[1];
    expect(created.name).toBe("Research");
    expect(created.tabs).toEqual([]);
    expect(next.currentId).toBe(created.id);
  });

  it("falls back to a default name when given blank input", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const next = createWorkspace(store, "   ");
    expect(next.workspaces[1].name).toBe("Untitled");
  });

  it("does not mutate the original store", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    createWorkspace(store, "Research");
    expect(store.workspaces).toHaveLength(1);
  });
});

describe("renameWorkspace", () => {
  it("renames the matching workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a", name: "Old" })], "a");
    const next = renameWorkspace(store, "a", "New");
    expect(next.workspaces[0].name).toBe("New");
  });

  it("ignores blank names", () => {
    const store = makeStore([makeWorkspace({ id: "a", name: "Old" })], "a");
    const next = renameWorkspace(store, "a", "   ");
    expect(next.workspaces[0].name).toBe("Old");
  });

  it("leaves other workspaces untouched", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", name: "A" }), makeWorkspace({ id: "b", name: "B" })],
      "a"
    );
    const next = renameWorkspace(store, "a", "A2");
    expect(next.workspaces[1].name).toBe("B");
  });
});

describe("switchWorkspace", () => {
  it("switches currentId to an existing workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");
    expect(switchWorkspace(store, "b").currentId).toBe("b");
  });

  it("ignores a switch to a nonexistent workspace id", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    expect(switchWorkspace(store, "ghost").currentId).toBe("a");
  });
});

describe("deleteWorkspace", () => {
  it("removes the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");
    const next = deleteWorkspace(store, "b");
    expect(next.workspaces.map((w) => w.id)).toEqual(["a"]);
  });

  it("switches currentId to another workspace when deleting the active one", () => {
    const store = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");
    const next = deleteWorkspace(store, "a");
    expect(next.currentId).toBe("b");
  });

  it("leaves currentId untouched when deleting an inactive workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");
    const next = deleteWorkspace(store, "b");
    expect(next.currentId).toBe("a");
  });

  it("replaces the last remaining workspace with a fresh empty default instead of leaving the store empty", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const next = deleteWorkspace(store, "a");

    expect(next.workspaces).toHaveLength(1);
    expect(next.workspaces[0].tabs).toEqual([]);
    expect(next.currentId).toBe(next.workspaces[0].id);
  });
});

describe("updateWorkspaceTabs", () => {
  it("replaces tabs and bumps updatedAt for the matching workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a", updatedAt: 0 })], "a");
    const tabs = [makeTab("1")];
    const next = updateWorkspaceTabs(store, "a", tabs);

    expect(next.workspaces[0].tabs).toEqual(tabs);
    expect(next.workspaces[0].updatedAt).toBeGreaterThan(0);
  });

  it("leaves other workspaces' tabs untouched", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a" }), makeWorkspace({ id: "b", tabs: [makeTab("x")] })],
      "a"
    );
    const next = updateWorkspaceTabs(store, "a", [makeTab("1")]);
    expect(next.workspaces[1].tabs).toEqual([makeTab("x")]);
  });
});

describe("addWorkspaces", () => {
  it("appends new workspaces without touching existing ones", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const next = addWorkspaces(store, [makeWorkspace({ id: "b" })]);

    expect(next.workspaces.map((w) => w.id)).toEqual(["a", "b"]);
    expect(next.currentId).toBe("a");
  });

  it("is a no-op for an empty list", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    expect(addWorkspaces(store, [])).toBe(store);
  });
});

describe("moveTabsBetweenWorkspaces", () => {
  it("moves matching tabs from the source into the target workspace", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [makeTab("1"), makeTab("2")] }),
        makeWorkspace({ id: "b", tabs: [] }),
      ],
      "a"
    );
    const result = moveTabsBetweenWorkspaces(store, ["1"], "b", "a");

    expect(result.moved.map((t) => t.id)).toEqual(["1"]);
    expect(result.notFound).toEqual([]);
    expect(result.store.workspaces[0].tabs.map((t) => t.id)).toEqual(["2"]);
    expect(result.store.workspaces[1].tabs.map((t) => t.id)).toEqual(["1"]);
  });

  it("reports ids that don't exist in the given source workspace as notFound", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [makeTab("1")] }), makeWorkspace({ id: "b", tabs: [] })],
      "a"
    );
    const result = moveTabsBetweenWorkspaces(store, ["ghost"], "b", "a");

    expect(result.moved).toEqual([]);
    expect(result.notFound).toEqual(["ghost"]);
    expect(result.store).toBe(store);
  });

  it("does not find a tab that belongs to a different workspace than the given source", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [makeTab("1")] }),
        makeWorkspace({ id: "b", tabs: [] }),
        makeWorkspace({ id: "c", tabs: [] }),
      ],
      "a"
    );
    // "1" lives in workspace a, but the caller claims source workspace c.
    const result = moveTabsBetweenWorkspaces(store, ["1"], "b", "c");

    expect(result.moved).toEqual([]);
    expect(result.notFound).toEqual(["1"]);
  });

  it("searches every workspace when sourceWorkspaceId is omitted", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [makeTab("1")] }), makeWorkspace({ id: "b", tabs: [] })],
      "a"
    );
    const result = moveTabsBetweenWorkspaces(store, ["1"], "b");
    expect(result.moved.map((t) => t.id)).toEqual(["1"]);
    expect(result.store.workspaces[0].tabs).toEqual([]);
  });

  it("clears a moved tab's groupId — a group only ever belongs to the workspace it was created in", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [{ ...makeTab("1"), groupId: "g-in-a" }] }),
        makeWorkspace({ id: "b", tabs: [] }),
      ],
      "a"
    );
    const result = moveTabsBetweenWorkspaces(store, ["1"], "b", "a");
    expect(result.moved[0].groupId).toBeUndefined();
    expect(result.store.workspaces[1].tabs[0].groupId).toBeUndefined();
  });

  it("re-flags duplicates in the destination after the move", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [makeTab("1")] }),
        makeWorkspace({ id: "b", tabs: [{ ...makeTab("2"), normalizedUrl: "https://example.com/1" }] }),
      ],
      "a"
    );
    const result = moveTabsBetweenWorkspaces(store, ["1"], "b", "a");
    const destTabs = result.store.workspaces[1].tabs;
    expect(destTabs.find((t) => t.id === "1")?.isDuplicate || destTabs.find((t) => t.id === "2")?.isDuplicate).toBe(true);
  });
});

describe("createGroup / renameGroup", () => {
  it("adds a new group to the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const { store: next, group } = createGroup(store, "a", "Physics");
    expect(next.workspaces[0].groups).toEqual([group]);
    expect(group.name).toBe("Physics");
  });

  it("renames an existing group", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const { store: withGroup, group } = createGroup(store, "a", "Old name");
    const next = renameGroup(withGroup, "a", group.id, "New name");
    expect(next.workspaces[0].groups?.[0].name).toBe("New name");
  });
});

describe("assignTabsToGroup", () => {
  it("assigns one tab to a group", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const next = assignTabsToGroup(store, "a", ["1"], "g1");
    expect(next.workspaces[0].tabs[0].groupId).toBe("g1");
  });

  it("assigns multiple tabs to a group", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1"), makeTab("2"), makeTab("3")] })], "a");
    const next = assignTabsToGroup(store, "a", ["1", "2"], "g1");
    expect(next.workspaces[0].tabs.map((t) => t.groupId)).toEqual(["g1", "g1", undefined]);
  });

  it("reassigns an already-grouped tab to a different group (move between groups)", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [{ ...makeTab("1"), groupId: "g1" }] })], "a");
    const next = assignTabsToGroup(store, "a", ["1"], "g2");
    expect(next.workspaces[0].tabs[0].groupId).toBe("g2");
  });

  it("does not mutate the original store", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    assignTabsToGroup(store, "a", ["1"], "g1");
    expect(store.workspaces[0].tabs[0].groupId).toBeUndefined();
  });

  it("silently ignores tab ids that don't exist in the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const next = assignTabsToGroup(store, "a", ["ghost"], "g1");
    expect(next.workspaces[0].tabs[0].groupId).toBeUndefined();
  });

  it("leaves other workspaces and their tabs untouched", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [makeTab("1")] }), makeWorkspace({ id: "b", tabs: [makeTab("2")] })],
      "a"
    );
    const next = assignTabsToGroup(store, "a", ["1"], "g1");
    expect(next.workspaces[1]).toBe(store.workspaces[1]);
  });

  it("does not assign a tab into a group id belonging to a different workspace", () => {
    // assignTabsToGroup is scoped by workspaceId — a tab in workspace "b"
    // is simply not touched even if groupId "g1" happens to exist in "a".
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [] }), makeWorkspace({ id: "b", tabs: [makeTab("1")] })],
      "a"
    );
    const next = assignTabsToGroup(store, "a", ["1"], "g1");
    expect(next.workspaces[1].tabs[0].groupId).toBeUndefined();
  });

  it("is referentially stable when nothing actually changes", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [{ ...makeTab("1"), groupId: "g1" }] })], "a");
    const next = assignTabsToGroup(store, "a", ["1"], "g1");
    expect(next).toBe(store);
  });
});

describe("removeTabsFromGroup", () => {
  it("removes one tab from its group", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [{ ...makeTab("1"), groupId: "g1" }] })], "a");
    const next = removeTabsFromGroup(store, "a", ["1"]);
    expect(next.workspaces[0].tabs[0].groupId).toBeUndefined();
  });

  it("removes multiple tabs from their groups", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [{ ...makeTab("1"), groupId: "g1" }, { ...makeTab("2"), groupId: "g2" }] })],
      "a"
    );
    const next = removeTabsFromGroup(store, "a", ["1", "2"]);
    expect(next.workspaces[0].tabs.every((t) => t.groupId === undefined)).toBe(true);
  });

  it("leaves an already-ungrouped tab untouched (and referentially stable)", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const next = removeTabsFromGroup(store, "a", ["1"]);
    expect(next).toBe(store);
  });

  it("does not mutate the original store", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [{ ...makeTab("1"), groupId: "g1" }] })], "a");
    removeTabsFromGroup(store, "a", ["1"]);
    expect(store.workspaces[0].tabs[0].groupId).toBe("g1");
  });

  it("clearing a group leaves the tab valid and simply ungrouped", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [{ ...makeTab("1"), groupId: "g1" }] })], "a");
    const next = removeTabsFromGroup(store, "a", ["1"]);
    expect(next.workspaces[0].tabs[0]).toEqual(makeTab("1"));
  });
});
