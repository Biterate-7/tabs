import { scopedKey } from "@/lib/storage/namespace";
import { DEPENDENCY_TYPE_ORDER } from "./types";
import type { DependencyPersistedState, DependencyType, TabDependency } from "./types";

// Base key. Signed out this is the literal key used; signed in, scopedKey()
// prefixes it with the account (see src/lib/storage/namespace.ts), which is what
// keeps two accounts sharing a browser from sharing each other's data.
const STORAGE_KEY = "tabdump:dependencies:v1";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeType(value: unknown): DependencyType | undefined {
  return typeof value === "string" && (DEPENDENCY_TYPE_ORDER as string[]).includes(value)
    ? (value as DependencyType)
    : undefined;
}

function sanitizeDependencies(value: unknown): TabDependency[] {
  if (!Array.isArray(value)) return [];
  const out: TabDependency[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, parentTabId, childTabId, type, createdAt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || seenIds.has(id)) continue;
    if (typeof parentTabId !== "string" || typeof childTabId !== "string") continue;
    if (parentTabId === childTabId) continue;
    seenIds.add(id);
    const dep: TabDependency = {
      id,
      parentTabId,
      childTabId,
      createdAt: isFiniteNumber(createdAt) ? createdAt : Date.now(),
    };
    const sanitizedType = sanitizeType(type);
    if (sanitizedType) dep.type = sanitizedType;
    out.push(dep);
  }
  return out;
}

export function defaultDependencyState(): DependencyPersistedState {
  return { version: 1, dependencies: [] };
}

/** Never throws — corrupted or missing dependency state degrades to an empty list rather than blocking the app. */
export function loadDependencyState(): DependencyPersistedState {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return defaultDependencyState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultDependencyState();
    const v = parsed as Record<string, unknown>;
    return { version: 1, dependencies: sanitizeDependencies(v.dependencies) };
  } catch {
    return defaultDependencyState();
  }
}

export function saveDependencyState(state: DependencyPersistedState): boolean {
  try {
    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops any dependency referencing a tab id that no longer exists (deleted
 * tab, cleared/deleted workspace) so a stale reference can never resurrect a
 * ghost edge in the graph or a dangling entry in a tab's dependency list.
 */
export function pruneDependencyState(
  state: DependencyPersistedState,
  validTabIds: Set<string>
): DependencyPersistedState {
  return {
    ...state,
    dependencies: state.dependencies.filter(
      (d) => validTabIds.has(d.parentTabId) && validTabIds.has(d.childTabId)
    ),
  };
}
