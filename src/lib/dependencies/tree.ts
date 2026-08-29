import { dependenciesOf } from "./relations";
import type { DependencyType, TabDependency } from "./types";

export type DependencyTreeNode = {
  tabId: string;
  dependencyId: string;
  type?: DependencyType;
  /** True when `tabId` already appears earlier on this same root-to-node path — its children are not expanded further. */
  isCycle: boolean;
  /** True when the dependency points at a tab id with no matching node (deleted tab, stale reference) — rendered as a safe leaf rather than skipped. */
  isMissing: boolean;
  children: DependencyTreeNode[];
};

const DEFAULT_MAX_DEPTH = 25;

/**
 * Builds the nested "what does `rootTabId` depend on" tree, expanding
 * dependenciesOf at each level. Cycles (A→B→A) and runaway depth are both
 * bounded: a tab id already on the current root-to-node path stops expansion
 * there (isCycle: true) instead of recursing forever, and `maxDepth` is a
 * second, independent backstop against pathological chains that never
 * revisit a node but are still impractically deep. `validTabIds`, when
 * given, marks a dependency's target as `isMissing` rather than silently
 * dropping it, so a deleted tab still surfaces as a safe leaf.
 */
export function buildDependencyTree(
  rootTabId: string,
  dependencies: TabDependency[],
  validTabIds?: Set<string>,
  maxDepth: number = DEFAULT_MAX_DEPTH
): DependencyTreeNode[] {
  function expand(tabId: string, path: Set<string>, depth: number): DependencyTreeNode[] {
    if (depth >= maxDepth) return [];
    const nextPath = new Set(path).add(tabId);
    return dependenciesOf(tabId, dependencies).map((dep) => {
      const isMissing = validTabIds ? !validTabIds.has(dep.childTabId) : false;
      const isCycle = path.has(dep.childTabId);
      return {
        tabId: dep.childTabId,
        dependencyId: dep.id,
        type: dep.type,
        isCycle,
        isMissing,
        children: isCycle || isMissing ? [] : expand(dep.childTabId, nextPath, depth + 1),
      };
    });
  }

  return expand(rootTabId, new Set([rootTabId]), 0);
}
