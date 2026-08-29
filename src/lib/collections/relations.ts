import { createId } from "@/lib/id";
import type { Collection } from "./types";

const DEFAULT_NAME = "New Collection";

/**
 * Strips `tabIds` out of every collection that currently holds any of them —
 * the mechanism behind the "a tab belongs to zero or one collection" rule
 * (AGENTS.md-style invariant, see this module's own doc). Called before a
 * tab is added anywhere else, so moving a tab from one collection to another
 * is just "remove from wherever it was, then add to the target," not a
 * separate code path.
 */
function stripFromAllCollections(collections: Collection[], tabIds: Set<string>, now: number): Collection[] {
  if (tabIds.size === 0) return collections;
  let changed = false;
  const next = collections.map((c) => {
    if (!c.tabIds.some((id) => tabIds.has(id))) return c;
    changed = true;
    return { ...c, tabIds: c.tabIds.filter((id) => !tabIds.has(id)), updatedAt: now };
  });
  return changed ? next : collections;
}

/**
 * Creates a new collection, optionally seeded with `tabIds` — the single
 * entry point both "New collection" (no tabs) and "Gather N tabs…" (a
 * preselected batch) go through, so there is exactly one place that enforces
 * "a tab belongs to at most one collection": any of `tabIds` already sitting
 * in another collection is pulled out of it first.
 */
export function createCollection(
  collections: Collection[],
  workspaceId: string,
  name: string,
  tabIds: string[] = [],
  now: number = Date.now()
): { collections: Collection[]; collection: Collection } {
  const dedupedTabIds = [...new Set(tabIds)];
  const stripped = stripFromAllCollections(collections, new Set(dedupedTabIds), now);
  const collection: Collection = {
    id: createId("collection"),
    workspaceId,
    name: name.trim() || DEFAULT_NAME,
    tabIds: dedupedTabIds,
    createdAt: now,
    updatedAt: now,
  };
  return { collections: [...stripped, collection], collection };
}

export function renameCollection(collections: Collection[], id: string, name: string): Collection[] {
  const trimmed = name.trim();
  if (!trimmed) return collections;
  const now = Date.now();
  return collections.map((c) => (c.id === id ? { ...c, name: trimmed, updatedAt: now } : c));
}

/** Removes the collection itself; the tabs it contained are untouched — deleting a collection only drops the grouping. */
export function deleteCollection(collections: Collection[], id: string): Collection[] {
  return collections.filter((c) => c.id !== id);
}

/**
 * Adds `tabId` to `collectionId`, first removing it from whatever other
 * collection (if any) it belonged to — enforces the "0 or 1 collection per
 * tab" invariant on every call rather than requiring callers to remember to
 * remove-then-add. Returns the same array reference when the target
 * collection doesn't exist or already contains the tab, so callers can
 * cheaply detect a no-op via `===`.
 */
export function addTabToCollection(collections: Collection[], collectionId: string, tabId: string): Collection[] {
  const target = collections.find((c) => c.id === collectionId);
  if (!target) return collections;
  if (target.tabIds.includes(tabId)) return collections;

  const now = Date.now();
  const stripped = stripFromAllCollections(collections, new Set([tabId]), now);
  return stripped.map((c) =>
    c.id === collectionId ? { ...c, tabIds: [...c.tabIds, tabId], updatedAt: now } : c
  );
}

/** Adding one or more tabs already in `collectionId` to any other collection — same exclusivity rule as addTabToCollection, batched. */
export function moveTabToCollection(collections: Collection[], tabId: string, targetCollectionId: string): Collection[] {
  return addTabToCollection(collections, targetCollectionId, tabId);
}

/** Bulk form of addTabToCollection — the selection toolbar's "Add to collection" action. Same exclusivity guarantee, applied to every tab in one pass. */
export function addTabsToCollection(collections: Collection[], collectionId: string, tabIds: string[]): Collection[] {
  const target = collections.find((c) => c.id === collectionId);
  if (!target) return collections;
  const toAdd = [...new Set(tabIds)].filter((id) => !target.tabIds.includes(id));
  if (toAdd.length === 0) return collections;

  const now = Date.now();
  const stripped = stripFromAllCollections(collections, new Set(toAdd), now);
  return stripped.map((c) =>
    c.id === collectionId ? { ...c, tabIds: [...c.tabIds, ...toAdd], updatedAt: now } : c
  );
}

export function removeTabFromCollection(collections: Collection[], collectionId: string, tabId: string): Collection[] {
  const now = Date.now();
  let changed = false;
  const next = collections.map((c) => {
    if (c.id !== collectionId || !c.tabIds.includes(tabId)) return c;
    changed = true;
    return { ...c, tabIds: c.tabIds.filter((id) => id !== tabId), updatedAt: now };
  });
  return changed ? next : collections;
}

export function removeTabsFromCollection(collections: Collection[], collectionId: string, tabIds: string[]): Collection[] {
  if (tabIds.length === 0) return collections;
  const wanted = new Set(tabIds);
  const now = Date.now();
  let changed = false;
  const next = collections.map((c) => {
    if (c.id !== collectionId || !c.tabIds.some((id) => wanted.has(id))) return c;
    changed = true;
    return { ...c, tabIds: c.tabIds.filter((id) => !wanted.has(id)), updatedAt: now };
  });
  return changed ? next : collections;
}

export function getCollectionForTab(collections: Collection[], tabId: string): Collection | undefined {
  return collections.find((c) => c.tabIds.includes(tabId));
}

export function getCollectionsForWorkspace(collections: Collection[], workspaceId: string): Collection[] {
  return collections.filter((c) => c.workspaceId === workspaceId);
}

/** O(1)-per-lookup tabId → collectionId index, so rendering many tabs at once never re-scans every collection per tab (see AGENTS.md's performance rule for this module). */
export function buildTabCollectionLookup(collections: Collection[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const collection of collections) {
    for (const tabId of collection.tabIds) map.set(tabId, collection.id);
  }
  return map;
}

/** Groups collections by workspace so a workspace-scoped view never filters the full cross-workspace list on every render. */
export function buildCollectionsByWorkspace(collections: Collection[]): Map<string, Collection[]> {
  const map = new Map<string, Collection[]>();
  for (const collection of collections) {
    const list = map.get(collection.workspaceId);
    if (list) list.push(collection);
    else map.set(collection.workspaceId, [collection]);
  }
  return map;
}

/** Resolves a collection's tabIds to Tab objects via a prebuilt lookup, silently dropping any id that doesn't resolve (a stale reference the persistence layer hasn't pruned yet). */
export function getCollectionTabs<T extends { id: string }>(collection: Collection, tabsById: Map<string, T>): T[] {
  const tabs: T[] = [];
  for (const id of collection.tabIds) {
    const tab = tabsById.get(id);
    if (tab) tabs.push(tab);
  }
  return tabs;
}
