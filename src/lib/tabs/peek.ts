import { loadWorkspaceStore } from "@/lib/workspace/persistence";
import { loadCollectionState } from "@/lib/collections/persistence";
import { loadGraphState } from "@/lib/graph/persistence";
import { loadDependencyState } from "@/lib/dependencies/persistence";
import { buildDegreeMap, buildDependencyEdges, buildGraphEdges, buildWorkspaceLookup } from "@/lib/graph/relations";
import { CATEGORIES } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { Tab } from "./types";

export type TabPeekContext = {
  workspaceName: string | null;
  categoryName: string;
  collectionName: string | null;
  hasNotes: boolean;
  connectionCount: number;
};

/**
 * Assembles Tab Peek's contextual info (workspace, collection, notes,
 * connection count) straight from the same persisted stores Workspace/Graph
 * views already read — no new cache, no network request. A handful of
 * localStorage reads plus one edge-building pass, cheap enough to call fresh
 * every time a peek opens rather than memoize or precompute for every tab.
 */
export function computeTabPeekContext(tab: Tab): TabPeekContext {
  const categoryId = (tab.category as CategoryId | undefined) ?? "other";
  const categoryName = CATEGORIES[categoryId]?.name ?? CATEGORIES.other.name;
  const hasNotes = Boolean(tab.notes?.trim());

  if (typeof window === "undefined") {
    return { workspaceName: null, categoryName, collectionName: null, hasNotes, connectionCount: 0 };
  }

  const workspaces = loadWorkspaceStore()?.workspaces ?? [];
  const workspaceLookup = buildWorkspaceLookup(workspaces);
  const allTabs = workspaces.flatMap((w) => w.tabs);

  const collection = loadCollectionState().collections.find((c) => c.tabIds.includes(tab.id)) ?? null;

  const graphState = loadGraphState();
  const edges = buildGraphEdges(allTabs, workspaceLookup, graphState.settings.filters, graphState.manualConnections);
  const dependencyEdges = graphState.settings.filters.dependencies
    ? buildDependencyEdges(allTabs, loadDependencyState().dependencies)
    : [];
  const connectionCount = buildDegreeMap(edges, dependencyEdges).get(tab.id) ?? 0;

  return {
    workspaceName: workspaceLookup.get(tab.id)?.name ?? null,
    categoryName,
    collectionName: collection?.name ?? null,
    hasNotes,
    connectionCount,
  };
}
