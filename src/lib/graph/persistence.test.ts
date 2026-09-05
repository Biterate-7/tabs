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

  it("defaults settings.filters.section to false when the field is absent (pre-sections backward compatibility)", () => {
    window.localStorage.setItem(
      "tabdump:graph:v1",
      JSON.stringify({
        settings: { filters: { domain: true, workspace: true, category: false, group: false, manual: true } },
      })
    );
    expect(loadGraphState().settings.filters.section).toBe(false);
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

  it("defaults settings.showClusterBoundaries to true when the field is absent (backward compatibility)", () => {
    window.localStorage.setItem(
      "tabdump:graph:v1",
      JSON.stringify({ settings: { filters: { domain: true } } })
    );
    expect(loadGraphState().settings.showClusterBoundaries).toBe(true);
  });

  it("round-trips settings.showClusterBoundaries when explicitly set to false", () => {
    const state = {
      ...defaultGraphState(),
      settings: { ...defaultGraphState().settings, showClusterBoundaries: false },
    };
    saveGraphState(state);
    expect(loadGraphState().settings.showClusterBoundaries).toBe(false);
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

  it("round-trips and prunes boundary offsets the same way as positions", () => {
    const state = {
      ...defaultGraphState(),
      boundaryOffsets: { a: { x: 40, y: -12 }, ghost: { x: 1, y: 1 } },
    };
    saveGraphState(state);
    expect(loadGraphState().boundaryOffsets).toEqual(state.boundaryOffsets);
    expect(pruneGraphState(state, new Set(["a"])).boundaryOffsets).toEqual({ a: { x: 40, y: -12 } });
  });

  it("reads a blob written before boundary offsets existed as 'nothing moved'", () => {
    window.localStorage.setItem(
      "tabdump:graph:v1",
      JSON.stringify({ version: 1, positions: { a: { x: 1, y: 2 } }, manualConnections: [] })
    );
    const loaded = loadGraphState();
    expect(loaded.boundaryOffsets).toEqual({});
    expect(loaded.positions).toEqual({ a: { x: 1, y: 2 } });
  });
});
