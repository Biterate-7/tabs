import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultCollectionState,
  loadCollectionState,
  pruneCollectionState,
  saveCollectionState,
} from "./persistence";
import type { CollectionPersistedState } from "./types";

describe("collection persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadCollectionState()).toEqual(defaultCollectionState());
  });

  it("round-trips a saved state", () => {
    const state: CollectionPersistedState = {
      version: 1,
      collections: [
        { id: "c1", workspaceId: "ws-1", name: "Physics IA", tabIds: ["a", "b"], createdAt: 1, updatedAt: 2 },
      ],
    };
    saveCollectionState(state);
    expect(loadCollectionState()).toEqual(state);
  });

  it("degrades to defaults instead of throwing on corrupted JSON", () => {
    window.localStorage.setItem("tabdump:collections:v1", "{not json");
    expect(loadCollectionState()).toEqual(defaultCollectionState());
  });

  it("drops malformed entries (missing name, wrong shape) rather than failing the whole load", () => {
    window.localStorage.setItem(
      "tabdump:collections:v1",
      JSON.stringify({
        collections: [
          { id: "c1", workspaceId: "ws-1", name: "Physics", tabIds: ["a"] },
          { id: "c2", workspaceId: "ws-1", name: "   " },
          { id: "c3" },
          "not even an object",
        ],
      })
    );
    const loaded = loadCollectionState();
    expect(loaded.collections).toHaveLength(1);
    expect(loaded.collections[0].id).toBe("c1");
  });

  it("de-duplicates entries sharing the same id", () => {
    window.localStorage.setItem(
      "tabdump:collections:v1",
      JSON.stringify({
        collections: [
          { id: "dup", workspaceId: "ws-1", name: "First", tabIds: [] },
          { id: "dup", workspaceId: "ws-1", name: "Second", tabIds: [] },
        ],
      })
    );
    expect(loadCollectionState().collections).toHaveLength(1);
  });

  it("de-duplicates tab ids within a single collection", () => {
    window.localStorage.setItem(
      "tabdump:collections:v1",
      JSON.stringify({
        collections: [{ id: "c1", workspaceId: "ws-1", name: "Physics", tabIds: ["a", "a", "b"] }],
      })
    );
    expect(loadCollectionState().collections[0].tabIds).toEqual(["a", "b"]);
  });

  it("falls back to Date.now() for missing timestamps rather than failing the entry", () => {
    window.localStorage.setItem(
      "tabdump:collections:v1",
      JSON.stringify({ collections: [{ id: "c1", workspaceId: "ws-1", name: "Physics", tabIds: [] }] })
    );
    const loaded = loadCollectionState();
    expect(typeof loaded.collections[0].createdAt).toBe("number");
    expect(typeof loaded.collections[0].updatedAt).toBe("number");
  });
});

describe("pruneCollectionState", () => {
  const base: CollectionPersistedState = {
    version: 1,
    collections: [
      { id: "c1", workspaceId: "ws-1", name: "Physics", tabIds: ["a", "b", "ghost"], createdAt: 1, updatedAt: 1 },
      { id: "c2", workspaceId: "ws-deleted", name: "Old", tabIds: ["z"], createdAt: 1, updatedAt: 1 },
    ],
  };

  it("deletes collections belonging to a workspace that no longer exists", () => {
    const pruned = pruneCollectionState(base, new Set(["ws-1"]), new Map([["a", "ws-1"], ["b", "ws-1"]]));
    expect(pruned.collections.map((c) => c.id)).toEqual(["c1"]);
  });

  it("drops stale tab ids that no longer exist anywhere", () => {
    const pruned = pruneCollectionState(base, new Set(["ws-1"]), new Map([["a", "ws-1"], ["b", "ws-1"]]));
    expect(pruned.collections[0].tabIds).toEqual(["a", "b"]);
  });

  it("drops a tab that moved to a different workspace than the collection's own", () => {
    const pruned = pruneCollectionState(
      base,
      new Set(["ws-1"]),
      new Map([["a", "ws-1"], ["b", "ws-OTHER"]])
    );
    expect(pruned.collections[0].tabIds).toEqual(["a"]);
  });

  it("leaves an already-clean collection referentially unchanged", () => {
    const clean: CollectionPersistedState = {
      version: 1,
      collections: [{ id: "c1", workspaceId: "ws-1", name: "Physics", tabIds: ["a"], createdAt: 1, updatedAt: 1 }],
    };
    const pruned = pruneCollectionState(clean, new Set(["ws-1"]), new Map([["a", "ws-1"]]));
    expect(pruned.collections[0]).toBe(clean.collections[0]);
  });
});
