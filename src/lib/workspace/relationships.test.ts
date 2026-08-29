import { describe, expect, it } from "vitest";
import { countRelationshipsByWorkspace } from "./relationships";
import type { Workspace } from "./types";
import type { TabDependency } from "@/lib/dependencies/types";

function makeWorkspace(id: string, tabIds: string[]): Workspace {
  return {
    id,
    name: id,
    tabs: tabIds.map((tabId) => ({
      id: tabId,
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      domain: "example.com",
    })),
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeDependency(parentTabId: string, childTabId: string): TabDependency {
  return { id: `dep-${parentTabId}::${childTabId}`, parentTabId, childTabId, createdAt: 0 };
}

describe("countRelationshipsByWorkspace", () => {
  it("counts dependencies within a single workspace once per side", () => {
    const workspaces = [makeWorkspace("w1", ["a", "b"])];
    const dependencies = [makeDependency("a", "b")];

    expect(countRelationshipsByWorkspace(workspaces, dependencies)).toEqual({ w1: 1 });
  });

  it("counts a cross-workspace dependency toward both workspaces", () => {
    const workspaces = [makeWorkspace("w1", ["a"]), makeWorkspace("w2", ["b"])];
    const dependencies = [makeDependency("a", "b")];

    expect(countRelationshipsByWorkspace(workspaces, dependencies)).toEqual({ w1: 1, w2: 1 });
  });

  it("returns zero for every workspace with no dependencies", () => {
    const workspaces = [makeWorkspace("w1", ["a"]), makeWorkspace("w2", [])];
    expect(countRelationshipsByWorkspace(workspaces, [])).toEqual({ w1: 0, w2: 0 });
  });

  it("ignores a dependency referencing a tab that doesn't exist in any workspace", () => {
    const workspaces = [makeWorkspace("w1", ["a"])];
    const dependencies = [makeDependency("a", "ghost")];

    expect(countRelationshipsByWorkspace(workspaces, dependencies)).toEqual({ w1: 1 });
  });
});
