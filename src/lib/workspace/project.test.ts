import { describe, expect, it } from "vitest";
import { readWorkspaceProjectLink, setWorkspaceProject, workspaceProjectBindings, workspaceProjectId } from "./project";
import type { WorkspaceStore } from "./types";

const store: WorkspaceStore = {
  version: 1,
  currentId: "w-dev",
  workspaces: [
    { id: "w-dev", name: "Development", tabs: [], createdAt: 1, updatedAt: 1 },
    { id: "w-research", name: "Research", tabs: [], createdAt: 1, updatedAt: 1 },
  ],
};

describe("a workspace's project (Hubble 1.6)", () => {
  it("attaches and detaches by id, and nothing else", () => {
    const attached = setWorkspaceProject(store, "w-dev", "p1", 10);
    expect(attached.workspaces[0]!.project).toEqual({ projectId: "p1", attachedAt: 10 });
    expect(attached.workspaces[1]).toBe(store.workspaces[1]);
    expect(workspaceProjectId(attached.workspaces[0])).toBe("p1");

    const detached = setWorkspaceProject(attached, "w-dev", null);
    expect(detached.workspaces[0]!.project).toBeUndefined();
    expect("project" in detached.workspaces[0]!).toBe(false);
  });

  it("returns the same store when nothing changes", () => {
    const attached = setWorkspaceProject(store, "w-dev", "p1", 10);
    expect(setWorkspaceProject(attached, "w-dev", "p1", 20)).toBe(attached);
    expect(setWorkspaceProject(store, "w-dev", null)).toBe(store);
    expect(setWorkspaceProject(store, "missing", "p1")).toBe(store);
  });

  it("reads a stored link strictly", () => {
    expect(readWorkspaceProjectLink({ projectId: "p1", attachedAt: 3, path: "C:/x" })).toEqual({ projectId: "p1", attachedAt: 3 });
    for (const bad of [null, "p1", [], { projectId: "", attachedAt: 1 }, { projectId: "p1" }, { projectId: "p\u0000", attachedAt: 1 }, { projectId: "p1", attachedAt: -1 }]) {
      expect(readWorkspaceProjectLink(bad)).toBeUndefined();
    }
    expect(setWorkspaceProject(store, "w-dev", "x".repeat(300))).toBe(store);
  });

  it("tells the runtime which workspaces each project belongs to", () => {
    const both = setWorkspaceProject(setWorkspaceProject(store, "w-dev", "p1", 1), "w-research", "p1", 1);
    expect(workspaceProjectBindings(both.workspaces)).toEqual(new Map([["p1", ["w-dev", "w-research"]]]));
    expect(workspaceProjectBindings(store.workspaces).size).toBe(0);
  });
});
