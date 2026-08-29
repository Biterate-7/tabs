import { describe, expect, it } from "vitest";
import {
  addTabToCollection,
  addTabsToCollection,
  buildCollectionsByWorkspace,
  buildTabCollectionLookup,
  createCollection,
  deleteCollection,
  getCollectionForTab,
  getCollectionsForWorkspace,
  getCollectionTabs,
  moveTabToCollection,
  removeTabFromCollection,
  removeTabsFromCollection,
  renameCollection,
} from "./relations";
import type { Collection } from "./types";

describe("createCollection", () => {
  it("creates a collection with a stable id and trimmed name", () => {
    const { collections, collection } = createCollection([], "ws-1", "  Physics IA  ");
    expect(collections).toHaveLength(1);
    expect(collection.name).toBe("Physics IA");
    expect(collection.workspaceId).toBe("ws-1");
    expect(collection.tabIds).toEqual([]);
    expect(collection.id).toBeTruthy();
  });

  it("falls back to a default name when blank", () => {
    const { collection } = createCollection([], "ws-1", "   ");
    expect(collection.name).toBe("New Collection");
  });

  it("seeds the collection with the given tabs (gather), deduplicated", () => {
    const { collection } = createCollection([], "ws-1", "Physics IA", ["a", "b", "a"]);
    expect(collection.tabIds).toEqual(["a", "b"]);
  });

  it("does not mutate array indexes into ids — two collections never collide", () => {
    const first = createCollection([], "ws-1", "One").collection;
    const second = createCollection([first], "ws-1", "Two").collection;
    expect(first.id).not.toBe(second.id);
  });

  it("gathering a tab already in another collection removes it from the old one (exclusivity)", () => {
    const { collections: afterFirst, collection: physics } = createCollection([], "ws-1", "Physics", ["a", "b"]);
    const { collections: afterSecond, collection: chem } = createCollection(afterFirst, "ws-1", "Chem", ["b", "c"]);
    const updatedPhysics = afterSecond.find((c) => c.id === physics.id)!;
    expect(updatedPhysics.tabIds).toEqual(["a"]);
    expect(chem.tabIds).toEqual(["b", "c"]);
  });
});

describe("renameCollection", () => {
  it("renames the matching collection and bumps updatedAt", () => {
    const { collections, collection } = createCollection([], "ws-1", "Old");
    const renamed = renameCollection(collections, collection.id, "New");
    expect(renamed.find((c) => c.id === collection.id)?.name).toBe("New");
  });

  it("is a no-op for a blank name", () => {
    const { collections, collection } = createCollection([], "ws-1", "Kept");
    const renamed = renameCollection(collections, collection.id, "   ");
    expect(renamed.find((c) => c.id === collection.id)?.name).toBe("Kept");
  });
});

describe("deleteCollection", () => {
  it("removes the collection but implicitly leaves tabs untouched (no tab store involved)", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["a", "b"]);
    const next = deleteCollection(collections, collection.id);
    expect(next).toHaveLength(0);
  });

  it("leaves other collections untouched", () => {
    const { collections: afterFirst, collection: a } = createCollection([], "ws-1", "A");
    const { collections: afterSecond, collection: b } = createCollection(afterFirst, "ws-1", "B");
    const next = deleteCollection(afterSecond, a.id);
    expect(next).toEqual([b]);
  });
});

describe("addTabToCollection / moveTabToCollection", () => {
  it("adds a tab to the target collection", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics");
    const next = addTabToCollection(collections, collection.id, "tab-1");
    expect(next.find((c) => c.id === collection.id)?.tabIds).toEqual(["tab-1"]);
  });

  it("returns the same reference when the tab is already a member (no-op)", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["tab-1"]);
    expect(addTabToCollection(collections, collection.id, "tab-1")).toBe(collections);
  });

  it("returns the same reference when the collection doesn't exist", () => {
    const { collections } = createCollection([], "ws-1", "Physics");
    expect(addTabToCollection(collections, "ghost", "tab-1")).toBe(collections);
  });

  it("prevents a tab being in two collections at once — moving pulls it from the old one", () => {
    const { collections: afterFirst, collection: physics } = createCollection([], "ws-1", "Physics", ["tab-1"]);
    const { collections: afterSecond, collection: chem } = createCollection(afterFirst, "ws-1", "Chem");
    const next = moveTabToCollection(afterSecond, "tab-1", chem.id);
    expect(next.find((c) => c.id === physics.id)?.tabIds).toEqual([]);
    expect(next.find((c) => c.id === chem.id)?.tabIds).toEqual(["tab-1"]);
  });

  it("never contains the same tab twice within one collection", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["tab-1"]);
    const next = addTabToCollection(collections, collection.id, "tab-1");
    expect(next.find((c) => c.id === collection.id)?.tabIds).toEqual(["tab-1"]);
  });
});

describe("addTabsToCollection (bulk)", () => {
  it("adds every tab not already a member", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["a"]);
    const next = addTabsToCollection(collections, collection.id, ["a", "b", "c"]);
    expect(next.find((c) => c.id === collection.id)?.tabIds).toEqual(["a", "b", "c"]);
  });

  it("pulls tabs out of whatever collection they were previously in", () => {
    const { collections: afterFirst, collection: physics } = createCollection([], "ws-1", "Physics", ["a", "b"]);
    const { collections, collection: chem } = createCollection(afterFirst, "ws-1", "Chem");
    const next = addTabsToCollection(collections, chem.id, ["a", "b"]);
    expect(next.find((c) => c.id === physics.id)?.tabIds).toEqual([]);
    expect(next.find((c) => c.id === chem.id)?.tabIds).toEqual(["a", "b"]);
  });

  it("returns the same reference when every tab is already a member", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["a", "b"]);
    expect(addTabsToCollection(collections, collection.id, ["a", "b"])).toBe(collections);
  });

  it("returns the same reference for an unknown collection", () => {
    const { collections } = createCollection([], "ws-1", "Physics");
    expect(addTabsToCollection(collections, "ghost", ["a"])).toBe(collections);
  });
});

describe("removeTabFromCollection / removeTabsFromCollection", () => {
  it("removes a single tab", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["a", "b"]);
    const next = removeTabFromCollection(collections, collection.id, "a");
    expect(next.find((c) => c.id === collection.id)?.tabIds).toEqual(["b"]);
  });

  it("removing an absent tab is a stable no-op", () => {
    const { collections } = createCollection([], "ws-1", "Physics", ["a"]);
    expect(removeTabFromCollection(collections, "ghost-collection", "a")).toBe(collections);
  });

  it("removes multiple tabs at once", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["a", "b", "c"]);
    const next = removeTabsFromCollection(collections, collection.id, ["a", "c"]);
    expect(next.find((c) => c.id === collection.id)?.tabIds).toEqual(["b"]);
  });
});

describe("getCollectionForTab / getCollectionsForWorkspace", () => {
  it("finds the collection containing a tab", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["a"]);
    expect(getCollectionForTab(collections, "a")?.id).toBe(collection.id);
  });

  it("returns undefined for an ungrouped tab", () => {
    const { collections } = createCollection([], "ws-1", "Physics", ["a"]);
    expect(getCollectionForTab(collections, "b")).toBeUndefined();
  });

  it("scopes collections to a single workspace", () => {
    const { collections: afterFirst } = createCollection([], "ws-1", "A");
    const { collections } = createCollection(afterFirst, "ws-2", "B");
    expect(getCollectionsForWorkspace(collections, "ws-1")).toHaveLength(1);
    expect(getCollectionsForWorkspace(collections, "ws-2")).toHaveLength(1);
  });
});

describe("buildTabCollectionLookup / buildCollectionsByWorkspace", () => {
  it("indexes every member tab to its collection id", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["a", "b"]);
    const lookup = buildTabCollectionLookup(collections);
    expect(lookup.get("a")).toBe(collection.id);
    expect(lookup.get("b")).toBe(collection.id);
    expect(lookup.get("c")).toBeUndefined();
  });

  it("groups collections by workspace", () => {
    const { collections: afterFirst, collection: a } = createCollection([], "ws-1", "A");
    const { collections, collection: b } = createCollection(afterFirst, "ws-2", "B");
    const byWorkspace = buildCollectionsByWorkspace(collections);
    expect(byWorkspace.get("ws-1")).toEqual([a]);
    expect(byWorkspace.get("ws-2")).toEqual([b]);
  });
});

describe("getCollectionTabs", () => {
  it("resolves member ids to objects via a lookup map", () => {
    const collection: Collection = {
      id: "c1",
      workspaceId: "ws-1",
      name: "Physics",
      tabIds: ["a", "b", "ghost"],
      createdAt: 0,
      updatedAt: 0,
    };
    const tabsById = new Map([
      ["a", { id: "a" }],
      ["b", { id: "b" }],
    ]);
    expect(getCollectionTabs(collection, tabsById)).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
