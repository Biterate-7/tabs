import { describe, expect, it } from "vitest";
import {
  addWorkspaces,
  createWorkspace,
  deleteWorkspace,
  getCurrentWorkspace,
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
