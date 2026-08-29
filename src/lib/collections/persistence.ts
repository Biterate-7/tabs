import type { Collection, CollectionPersistedState } from "./types";

const STORAGE_KEY = "tabdump:collections:v1";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeCollection(value: unknown): Collection | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.workspaceId !== "string") return null;
  if (typeof c.name !== "string" || !c.name.trim()) return null;
  const rawTabIds = Array.isArray(c.tabIds) ? c.tabIds : [];
  const tabIds = [...new Set(rawTabIds.filter((id): id is string => typeof id === "string"))];
  const now = Date.now();
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    name: c.name.trim(),
    tabIds,
    createdAt: isFiniteNumber(c.createdAt) ? c.createdAt : now,
    updatedAt: isFiniteNumber(c.updatedAt) ? c.updatedAt : now,
  };
}

function sanitizeCollections(value: unknown): Collection[] {
  if (!Array.isArray(value)) return [];
  const out: Collection[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const collection = sanitizeCollection(entry);
    if (!collection || seenIds.has(collection.id)) continue;
    seenIds.add(collection.id);
    out.push(collection);
  }
  return out;
}

export function defaultCollectionState(): CollectionPersistedState {
  return { version: 1, collections: [] };
}

/** Never throws — corrupted or missing collection state degrades to an empty list rather than blocking the app. */
export function loadCollectionState(): CollectionPersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultCollectionState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultCollectionState();
    const v = parsed as Record<string, unknown>;
    return { version: 1, collections: sanitizeCollections(v.collections) };
  } catch {
    return defaultCollectionState();
  }
}

export function saveCollectionState(state: CollectionPersistedState): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearCollectionState(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/**
 * Drops every collection whose workspace no longer exists (workspace
 * deletion — collections don't outlive their workspace), then, for every
 * surviving collection, keeps only the tab ids that still exist AND still
 * live in THAT collection's workspace — a tab that was deleted, or moved to
 * a different workspace, silently drops out of the collection rather than
 * leaving a dangling or cross-workspace reference. `tabWorkspaceOf` maps
 * every tab id (across all workspaces) to the id of the workspace that
 * currently holds it, so a tab moved elsewhere is detected the same render
 * it moves, no separate synchronization step required (mirrors
 * useDependencyStore's "prune at read time" approach).
 */
export function pruneCollectionState(
  state: CollectionPersistedState,
  validWorkspaceIds: Set<string>,
  tabWorkspaceOf: Map<string, string>
): CollectionPersistedState {
  const collections: Collection[] = [];
  for (const collection of state.collections) {
    if (!validWorkspaceIds.has(collection.workspaceId)) continue;
    const tabIds = collection.tabIds.filter((id) => tabWorkspaceOf.get(id) === collection.workspaceId);
    collections.push(tabIds.length === collection.tabIds.length ? collection : { ...collection, tabIds });
  }
  return { ...state, collections };
}
