import { describe, expect, it, vi, afterEach } from "vitest";
import {
  addTabToCollection,
  addTabsToCollection,
  createCollection,
  removeTabFromCollection,
  removeTabsFromCollection,
  renameCollection,
} from "@/lib/collections/relations";
import { addDependency, updateDependencyType } from "@/lib/dependencies/relations";
import { assignTabsToSection, renameWorkspace, updateWorkspaceTabs } from "@/lib/workspace/store";
import { stampChangedTabs } from "@/lib/tabs/touch";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * Reducers are the layer a future sync pass will replay, so their inputs must
 * survive a call untouched and their outputs must not depend on anything the
 * caller can't see.
 *
 * The clock is the interesting case. A reducer that reads it internally is
 * still deterministic from the caller's point of view only if the caller can
 * supply the reading — otherwise two identical calls produce two different
 * results, and it matters *when* React happened to evaluate it. These tests
 * pin the injection points rather than demanding byte equality from reducers
 * that legitimately mint ids.
 */

const T0 = 1_700_000_000_000;

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://example.com/${over.id}`,
    normalizedUrl: `https://example.com/${over.id}`,
    domain: "example.com",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function makeStore(): WorkspaceStore {
  return {
    version: 1,
    currentId: "w1",
    workspaces: [
      {
        id: "w1",
        name: "General",
        createdAt: T0,
        updatedAt: T0,
        sections: [{ id: "s1", parentId: null, name: "Projects", source: "ai", createdAt: T0, updatedAt: T0 }],
        tabs: [makeTab({ id: "t1" }), makeTab({ id: "t2" })],
      },
    ],
  };
}

function makeCollections(): Collection[] {
  return [{ id: "c1", workspaceId: "w1", name: "Reading", tabIds: ["t1"], createdAt: T0, updatedAt: T0 }];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reducers do not touch the outside world", () => {
  it("never reaches localStorage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    const store = makeStore();
    updateWorkspaceTabs(store, "w1", [makeTab({ id: "t1", notes: "hi" }), makeTab({ id: "t2" })]);
    renameWorkspace(store, "w1", "Renamed");
    assignTabsToSection(store, "w1", ["t1"], "s1");
    renameCollection(makeCollections(), "c1", "Later", T0 + 1);
    addDependency([], "t1", "t2", undefined, T0, T0);

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("never reads the clock when the caller supplies one", () => {
    const now = vi.spyOn(Date, "now");

    renameCollection(makeCollections(), "c1", "Later", T0 + 1);
    addTabToCollection(makeCollections(), "c1", "t9", T0 + 1);
    addTabsToCollection(makeCollections(), "c1", ["t9", "t10"], T0 + 1);
    removeTabFromCollection(makeCollections(), "c1", "t1", T0 + 1);
    removeTabsFromCollection(makeCollections(), "c1", ["t1"], T0 + 1);
    createCollection(makeCollections(), "w1", "New", ["t2"], T0 + 1);
    addDependency([], "t1", "t2", undefined, T0, T0);
    updateDependencyType([{ id: "d1", parentTabId: "t1", childTabId: "t2", createdAt: T0 }], "d1", "reference", T0 + 1);
    stampChangedTabs([makeTab({ id: "t1" })], [makeTab({ id: "t1", notes: "x" })], T0 + 1);

    // Every reducer the React hooks call inside a state updater must be
    // satisfiable without the clock, or the updater becomes the thing that
    // decides what time it is.
    expect(now).not.toHaveBeenCalled();
  });
});

describe("reducers leave their inputs alone", () => {
  it("does not mutate the store it is given", () => {
    const store = makeStore();
    const before = JSON.stringify(store);

    updateWorkspaceTabs(store, "w1", [makeTab({ id: "t1", notes: "changed" }), makeTab({ id: "t2" })]);
    renameWorkspace(store, "w1", "Renamed");
    assignTabsToSection(store, "w1", ["t1", "t2"], "s1");

    expect(JSON.stringify(store)).toBe(before);
  });

  it("does not mutate the collections or dependencies it is given", () => {
    const collections = makeCollections();
    const collectionsBefore = JSON.stringify(collections);
    const dependencies: TabDependency[] = [
      { id: "d1", parentTabId: "t1", childTabId: "t2", createdAt: T0, updatedAt: T0 },
    ];
    const dependenciesBefore = JSON.stringify(dependencies);

    renameCollection(collections, "c1", "Later", T0 + 1);
    addTabToCollection(collections, "c1", "t2", T0 + 1);
    removeTabsFromCollection(collections, "c1", ["t1"], T0 + 1);
    updateDependencyType(dependencies, "d1", "reference", T0 + 1);
    addDependency(dependencies, "t2", "t3", undefined, T0 + 1, T0 + 1);

    expect(JSON.stringify(collections)).toBe(collectionsBefore);
    expect(JSON.stringify(dependencies)).toBe(dependenciesBefore);
  });
});

describe("reducers are replayable", () => {
  it("produces the same result twice from the same inputs", () => {
    const store = makeStore();
    const tabs = [makeTab({ id: "t1", notes: "note" }), makeTab({ id: "t2" })];

    // updateWorkspaceTabs reads the clock internally, so the two calls can
    // differ in timestamps alone — everything else must match exactly.
    const blank = (value: WorkspaceStore) =>
      JSON.stringify(value, (key, v) => (key === "updatedAt" || key === "createdAt" ? 0 : v));
    expect(blank(updateWorkspaceTabs(store, "w1", tabs))).toBe(blank(updateWorkspaceTabs(store, "w1", tabs)));

    // Given the timestamp, the result is identical down to the byte.
    const collections = makeCollections();
    expect(JSON.stringify(renameCollection(collections, "c1", "Later", T0 + 5))).toBe(
      JSON.stringify(renameCollection(collections, "c1", "Later", T0 + 5))
    );
    expect(JSON.stringify(addDependency([], "t1", "t2", "reference", T0 + 5, T0 + 5))).toBe(
      JSON.stringify(addDependency([], "t1", "t2", "reference", T0 + 5, T0 + 5))
    );
  });

  it("returns the same reference when nothing changed", () => {
    const collections = makeCollections();
    // A no-op must be detectable with ===, which is what lets callers skip a
    // write entirely rather than persisting an identical store.
    expect(addTabToCollection(collections, "c1", "t1", T0 + 1)).toBe(collections);
    expect(removeTabsFromCollection(collections, "c1", [], T0 + 1)).toBe(collections);

    const tabs = [makeTab({ id: "t1" })];
    expect(stampChangedTabs(tabs, tabs, T0 + 1)).toBe(tabs);
  });
});
