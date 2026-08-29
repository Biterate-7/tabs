import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultDependencyState,
  loadDependencyState,
  pruneDependencyState,
  saveDependencyState,
} from "./persistence";

describe("dependency persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadDependencyState()).toEqual(defaultDependencyState());
  });

  it("round-trips a saved state", () => {
    const state = {
      version: 1 as const,
      dependencies: [{ id: "dep-a::b", parentTabId: "a", childTabId: "b", type: "research" as const, createdAt: 123 }],
    };
    saveDependencyState(state);
    expect(loadDependencyState()).toEqual(state);
  });

  it("degrades to defaults instead of throwing on corrupted JSON", () => {
    window.localStorage.setItem("tabdump:dependencies:v1", "{not json");
    expect(loadDependencyState()).toEqual(defaultDependencyState());
  });

  it("drops entries with an invalid type instead of failing the whole load", () => {
    window.localStorage.setItem(
      "tabdump:dependencies:v1",
      JSON.stringify({
        dependencies: [
          { id: "d1", parentTabId: "a", childTabId: "b", type: "not-a-real-type" },
          { id: "d2", parentTabId: "a", childTabId: "c", type: "tool" },
        ],
      })
    );
    const loaded = loadDependencyState();
    expect(loaded.dependencies).toHaveLength(2);
    expect(loaded.dependencies[0].type).toBeUndefined();
    expect(loaded.dependencies[1].type).toBe("tool");
  });

  it("drops a self-dependency and malformed entries rather than failing the whole load", () => {
    window.localStorage.setItem(
      "tabdump:dependencies:v1",
      JSON.stringify({
        dependencies: [
          { id: "d1", parentTabId: "a", childTabId: "a" },
          { id: "d2", parentTabId: "a" },
          "not even an object",
          { id: "d3", parentTabId: "a", childTabId: "b" },
        ],
      })
    );
    const loaded = loadDependencyState();
    expect(loaded.dependencies).toHaveLength(1);
    expect(loaded.dependencies[0].id).toBe("d3");
  });

  it("de-duplicates entries sharing the same id", () => {
    window.localStorage.setItem(
      "tabdump:dependencies:v1",
      JSON.stringify({
        dependencies: [
          { id: "dup", parentTabId: "a", childTabId: "b" },
          { id: "dup", parentTabId: "x", childTabId: "y" },
        ],
      })
    );
    expect(loadDependencyState().dependencies).toHaveLength(1);
  });

  it("prunes dependencies referencing deleted tabs", () => {
    const state = {
      version: 1 as const,
      dependencies: [
        { id: "d1", parentTabId: "a", childTabId: "b", createdAt: 1 },
        { id: "d2", parentTabId: "a", childTabId: "ghost", createdAt: 2 },
      ],
    };
    const pruned = pruneDependencyState(state, new Set(["a", "b"]));
    expect(pruned.dependencies).toEqual([{ id: "d1", parentTabId: "a", childTabId: "b", createdAt: 1 }]);
  });
});
