import { describe, expect, it } from "vitest";
import { addDependency } from "./relations";
import { buildDependencyTree } from "./tree";
import type { TabDependency } from "./types";

describe("buildDependencyTree", () => {
  it("builds a nested tree from a chain of dependencies", () => {
    let deps: TabDependency[] = [];
    deps = addDependency(deps, "physics-ia", "research");
    deps = addDependency(deps, "research", "paper-a");
    deps = addDependency(deps, "research", "paper-b");

    const tree = buildDependencyTree("physics-ia", deps);
    expect(tree).toHaveLength(1);
    expect(tree[0].tabId).toBe("research");
    expect(tree[0].children.map((c) => c.tabId).sort()).toEqual(["paper-a", "paper-b"]);
  });

  it("returns an empty tree for a tab with no dependencies", () => {
    expect(buildDependencyTree("lonely", [])).toEqual([]);
  });

  it("marks a repeated tab on the current path as a cycle instead of recursing forever", () => {
    let deps: TabDependency[] = [];
    deps = addDependency(deps, "a", "b");
    deps = addDependency(deps, "b", "c");
    deps = addDependency(deps, "c", "a");

    const tree = buildDependencyTree("a", deps);
    // a -> b -> c -> a(cycle)
    const b = tree[0];
    const c = b.children[0];
    const cyclicA = c.children[0];
    expect(cyclicA.tabId).toBe("a");
    expect(cyclicA.isCycle).toBe(true);
    expect(cyclicA.children).toEqual([]);
  });

  it("marks a dependency pointing at a missing tab id as isMissing, as a safe leaf", () => {
    const deps = addDependency([], "a", "deleted-tab");
    const tree = buildDependencyTree("a", deps, new Set(["a"]));
    expect(tree[0]).toMatchObject({ tabId: "deleted-tab", isMissing: true, children: [] });
  });

  it("does not mark a missing tab id when no validTabIds set is given", () => {
    const deps = addDependency([], "a", "b");
    const tree = buildDependencyTree("a", deps);
    expect(tree[0].isMissing).toBe(false);
  });

  it("bounds runaway depth even without a repeated node", () => {
    let deps: TabDependency[] = [];
    for (let i = 0; i < 40; i++) {
      deps = addDependency(deps, `n${i}`, `n${i + 1}`);
    }
    // Should not throw / hang, and should stop well short of all 40 levels.
    const tree = buildDependencyTree("n0", deps, undefined, 5);
    let depth = 0;
    let node = tree[0];
    while (node && node.children.length > 0) {
      depth++;
      node = node.children[0];
    }
    expect(depth).toBeLessThan(10);
  });

  it("carries the dependency type onto each tree node", () => {
    const deps = addDependency([], "a", "b", "research");
    const tree = buildDependencyTree("a", deps);
    expect(tree[0].type).toBe("research");
  });
});
