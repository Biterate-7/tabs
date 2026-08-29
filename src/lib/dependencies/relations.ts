import type { DependencyType, TabDependency } from "./types";

/**
 * Deterministic and stable: the same parent/child pair always produces the
 * same id, so re-adding after a reload (or resolving a dependency reference
 * through an id remap on import) never mints a second id for what is
 * logically the same relationship. Directional by construction — dependencyId(a,b)
 * and dependencyId(b,a) differ, which is what lets A→B and B→A coexist as
 * two distinct edges (see AGENTS.md section 21).
 */
export function dependencyId(parentTabId: string, childTabId: string): string {
  return `dep-${parentTabId}::${childTabId}`;
}

export function isSelfDependency(parentTabId: string, childTabId: string): boolean {
  return parentTabId === childTabId;
}

export function findDependency(
  dependencies: TabDependency[],
  parentTabId: string,
  childTabId: string
): TabDependency | undefined {
  const id = dependencyId(parentTabId, childTabId);
  return dependencies.find((d) => d.id === id);
}

/**
 * Returns the same array reference when the dependency can't be added
 * (self-dependency, or already exists) so callers can cheaply detect a no-op
 * via `===` rather than re-deriving the reason.
 */
export function addDependency(
  dependencies: TabDependency[],
  parentTabId: string,
  childTabId: string,
  type?: DependencyType,
  createdAt: number = Date.now()
): TabDependency[] {
  if (isSelfDependency(parentTabId, childTabId)) return dependencies;
  if (findDependency(dependencies, parentTabId, childTabId)) return dependencies;
  const next: TabDependency = { id: dependencyId(parentTabId, childTabId), parentTabId, childTabId, createdAt };
  if (type) next.type = type;
  return [...dependencies, next];
}

export function removeDependency(dependencies: TabDependency[], id: string): TabDependency[] {
  return dependencies.filter((d) => d.id !== id);
}

export function updateDependencyType(
  dependencies: TabDependency[],
  id: string,
  type: DependencyType | undefined
): TabDependency[] {
  return dependencies.map((d) => {
    if (d.id !== id) return d;
    if (type === undefined) {
      const { type: _drop, ...rest } = d;
      void _drop;
      return rest;
    }
    return { ...d, type };
  });
}

/** What `tabId` depends on — the tabs it points AT. */
export function dependenciesOf(tabId: string, dependencies: TabDependency[]): TabDependency[] {
  return dependencies.filter((d) => d.parentTabId === tabId);
}

/** What depends on `tabId` — the tabs pointing AT it ("used by"). */
export function usedBy(tabId: string, dependencies: TabDependency[]): TabDependency[] {
  return dependencies.filter((d) => d.childTabId === tabId);
}

export type DependencyCounts = { dependencies: number; usedBy: number };

export function countsFor(tabId: string, dependencies: TabDependency[]): DependencyCounts {
  let deps = 0;
  let used = 0;
  for (const d of dependencies) {
    if (d.parentTabId === tabId) deps++;
    if (d.childTabId === tabId) used++;
  }
  return { dependencies: deps, usedBy: used };
}

/**
 * Indexes `dependencies` by parentTabId (what each tab depends on) so a
 * caller rendering many tabs at once — e.g. a search/filter result list —
 * can look up a tab's outgoing dependencies in O(1) instead of re-scanning
 * the full list per row. Pair with groupDependenciesByChild for the reverse
 * ("used by") direction.
 */
export function groupDependenciesByParent(dependencies: TabDependency[]): Map<string, TabDependency[]> {
  const map = new Map<string, TabDependency[]>();
  for (const dep of dependencies) {
    const list = map.get(dep.parentTabId);
    if (list) list.push(dep);
    else map.set(dep.parentTabId, [dep]);
  }
  return map;
}

/** Indexes `dependencies` by childTabId — the reverse of groupDependenciesByParent, for "used by" lookups. */
export function groupDependenciesByChild(dependencies: TabDependency[]): Map<string, TabDependency[]> {
  const map = new Map<string, TabDependency[]>();
  for (const dep of dependencies) {
    const list = map.get(dep.childTabId);
    if (list) list.push(dep);
    else map.set(dep.childTabId, [dep]);
  }
  return map;
}

/**
 * Bulk-merges `incoming` dependencies into `existing`, skipping anything that
 * would be a self-dependency or a duplicate of one already present (in
 * `existing` or earlier in `incoming` itself) — used by JSON import, where a
 * file might restate a dependency across an already-populated store.
 */
export function mergeDependencies(existing: TabDependency[], incoming: TabDependency[]): TabDependency[] {
  let next = existing;
  for (const dep of incoming) {
    next = addDependency(next, dep.parentTabId, dep.childTabId, dep.type, dep.createdAt);
  }
  return next;
}
