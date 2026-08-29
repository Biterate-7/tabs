import { describe, expect, it } from "vitest";
import {
  addDependency,
  countsFor,
  dependenciesOf,
  dependencyId,
  findDependency,
  groupDependenciesByChild,
  groupDependenciesByParent,
  mergeDependencies,
  removeDependency,
  updateDependencyType,
  usedBy,
} from "./relations";
import type { TabDependency } from "./types";

describe("dependencyId", () => {
  it("is deterministic for the same parent/child pair", () => {
    expect(dependencyId("a", "b")).toBe(dependencyId("a", "b"));
  });

  it("is directional — a→b differs from b→a", () => {
    expect(dependencyId("a", "b")).not.toBe(dependencyId("b", "a"));
  });
});

describe("addDependency", () => {
  it("creates a new dependency with a stable id", () => {
    const deps = addDependency([], "parent", "child", "research");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ id: dependencyId("parent", "child"), parentTabId: "parent", childTabId: "child", type: "research" });
  });

  it("supports an untyped dependency", () => {
    const deps = addDependency([], "parent", "child");
    expect(deps[0].type).toBeUndefined();
  });

  it("prevents a self dependency, returning the same array reference", () => {
    const deps: TabDependency[] = [];
    expect(addDependency(deps, "a", "a")).toBe(deps);
  });

  it("prevents a duplicate dependency in the same direction, returning the same array reference", () => {
    const deps = addDependency([], "a", "b");
    expect(addDependency(deps, "a", "b")).toBe(deps);
  });

  it("allows the reverse direction as a distinct dependency", () => {
    const deps = addDependency(addDependency([], "a", "b"), "b", "a");
    expect(deps).toHaveLength(2);
  });
});

describe("removeDependency", () => {
  it("removes only the targeted dependency, leaving others untouched", () => {
    const deps = addDependency(addDependency([], "a", "b"), "a", "c");
    const next = removeDependency(deps, dependencyId("a", "b"));
    expect(next).toHaveLength(1);
    expect(next[0].childTabId).toBe("c");
  });
});

describe("updateDependencyType", () => {
  it("changes the type of the matching dependency", () => {
    const deps = addDependency([], "a", "b", "tool");
    const next = updateDependencyType(deps, dependencyId("a", "b"), "reference");
    expect(next[0].type).toBe("reference");
  });

  it("clears the type when given undefined", () => {
    const deps = addDependency([], "a", "b", "tool");
    const next = updateDependencyType(deps, dependencyId("a", "b"), undefined);
    expect(next[0].type).toBeUndefined();
  });
});

describe("dependenciesOf / usedBy", () => {
  const deps = [
    addDependency([], "physics-ia", "research-paper")[0],
    addDependency([], "physics-ia", "data-source")[0],
    addDependency([], "history-ee", "research-paper")[0],
  ];

  it("dependenciesOf returns what a tab depends on", () => {
    const result = dependenciesOf("physics-ia", deps);
    expect(result.map((d) => d.childTabId).sort()).toEqual(["data-source", "research-paper"]);
  });

  it("usedBy returns what depends on a tab (reverse lookup)", () => {
    const result = usedBy("research-paper", deps);
    expect(result.map((d) => d.parentTabId).sort()).toEqual(["history-ee", "physics-ia"]);
  });

  it("usedBy is empty for a tab nothing depends on", () => {
    expect(usedBy("data-source", deps.filter((d) => d.childTabId !== "data-source"))).toEqual([]);
  });
});

describe("countsFor", () => {
  it("counts outgoing dependencies and incoming used-by separately", () => {
    let deps: TabDependency[] = [];
    deps = addDependency(deps, "a", "b");
    deps = addDependency(deps, "a", "c");
    deps = addDependency(deps, "d", "a");
    expect(countsFor("a", deps)).toEqual({ dependencies: 2, usedBy: 1 });
  });
});

describe("findDependency", () => {
  it("finds an existing directional pair", () => {
    const deps = addDependency([], "a", "b");
    expect(findDependency(deps, "a", "b")).toBeDefined();
    expect(findDependency(deps, "b", "a")).toBeUndefined();
  });
});

describe("groupDependenciesByParent / groupDependenciesByChild", () => {
  let deps: TabDependency[] = [];
  deps = addDependency(deps, "physics-ia", "research-paper");
  deps = addDependency(deps, "physics-ia", "data-source");
  deps = addDependency(deps, "history-ee", "research-paper");

  it("groups by parent so a tab's outgoing dependencies can be looked up in O(1)", () => {
    const byParent = groupDependenciesByParent(deps);
    expect(byParent.get("physics-ia")?.map((d) => d.childTabId).sort()).toEqual(["data-source", "research-paper"]);
    expect(byParent.get("research-paper")).toBeUndefined();
  });

  it("groups by child so a tab's used-by relationships can be looked up in O(1)", () => {
    const byChild = groupDependenciesByChild(deps);
    expect(byChild.get("research-paper")?.map((d) => d.parentTabId).sort()).toEqual(["history-ee", "physics-ia"]);
    expect(byChild.get("data-source")?.map((d) => d.parentTabId)).toEqual(["physics-ia"]);
  });

  it("returns an empty map for an empty dependency list", () => {
    expect(groupDependenciesByParent([]).size).toBe(0);
    expect(groupDependenciesByChild([]).size).toBe(0);
  });
});

describe("mergeDependencies", () => {
  it("adds incoming dependencies not already present", () => {
    const existing = addDependency([], "a", "b");
    const merged = mergeDependencies(existing, [{ id: "x", parentTabId: "a", childTabId: "c", createdAt: 1 }]);
    expect(merged).toHaveLength(2);
  });

  it("skips duplicates already present in existing", () => {
    const existing = addDependency([], "a", "b");
    const merged = mergeDependencies(existing, [{ id: "x", parentTabId: "a", childTabId: "b", createdAt: 1 }]);
    expect(merged).toHaveLength(1);
  });

  it("skips duplicates within the incoming batch itself", () => {
    const merged = mergeDependencies([], [
      { id: "x", parentTabId: "a", childTabId: "b", createdAt: 1 },
      { id: "y", parentTabId: "a", childTabId: "b", createdAt: 2 },
    ]);
    expect(merged).toHaveLength(1);
  });

  it("skips self-dependencies in the incoming batch", () => {
    const merged = mergeDependencies([], [{ id: "x", parentTabId: "a", childTabId: "a", createdAt: 1 }]);
    expect(merged).toHaveLength(0);
  });
});
