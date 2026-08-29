import { beforeEach, describe, expect, it } from "vitest";
import { defaultGraphState, loadGraphState, pruneGraphState, saveGraphState } from "./persistence";

describe("graph persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadGraphState()).toEqual(defaultGraphState());
  });

  it("round-trips a saved state", () => {
    const state = {
      ...defaultGraphState(),
      positions: { a: { x: 1, y: 2 } },
      manualConnections: [{ a: "a", b: "b", createdAt: 123 }],
      settings: { ...defaultGraphState().settings, view: "local" as const, depth: 3 as const },
    };
    saveGraphState(state);
    expect(loadGraphState()).toEqual(state);
  });

  it("degrades to defaults instead of throwing on corrupted JSON", () => {
    window.localStorage.setItem("tabdump:graph:v1", "{not json");
    expect(loadGraphState()).toEqual(defaultGraphState());
  });

  it("defaults settings.filters.dependencies to true when the field is absent (pre-dependencies backward compatibility)", () => {
    window.localStorage.setItem(
      "tabdump:graph:v1",
      JSON.stringify({
        settings: { filters: { domain: true, workspace: true, category: false, group: false, manual: true } },
      })
    );
    expect(loadGraphState().settings.filters.dependencies).toBe(true);
  });

  it("round-trips settings.filters.dependencies when explicitly set to false", () => {
    const state = {
      ...defaultGraphState(),
      settings: {
        ...defaultGraphState().settings,
        filters: { ...defaultGraphState().settings.filters, dependencies: false },
      },
    };
    saveGraphState(state);
    expect(loadGraphState().settings.filters.dependencies).toBe(false);
  });

  it("sanitizes a malformed persisted blob field-by-field rather than discarding it wholesale", () => {
    window.localStorage.setItem(
      "tabdump:graph:v1",
      JSON.stringify({
        positions: { a: { x: 1, y: "bad" }, b: { x: 3, y: 4 } },
        manualConnections: [{ a: "x", b: "x" }, { a: "y", b: "z" }],
        settings: { view: "not-a-real-view", depth: 99 },
      })
    );
    const loaded = loadGraphState();
    expect(loaded.positions).toEqual({ b: { x: 3, y: 4 } });
    expect(loaded.manualConnections).toHaveLength(1);
    expect(loaded.manualConnections[0].a).toBe("y");
    expect(loaded.settings.view).toBe("global");
    expect(loaded.settings.depth).toBe(2);
  });

  it("prunes positions and manual connections referencing deleted tabs", () => {
    const state = {
      ...defaultGraphState(),
      positions: { a: { x: 1, y: 2 }, ghost: { x: 5, y: 6 } },
      manualConnections: [
        { a: "a", b: "b", createdAt: 1 },
        { a: "a", b: "ghost", createdAt: 2 },
      ],
      settings: { ...defaultGraphState().settings, selectedTabId: "ghost" },
    };
    const pruned = pruneGraphState(state, new Set(["a", "b"]));
    expect(pruned.positions).toEqual({ a: { x: 1, y: 2 } });
    expect(pruned.manualConnections).toEqual([{ a: "a", b: "b", createdAt: 1 }]);
    expect(pruned.settings.selectedTabId).toBeNull();
  });
});
