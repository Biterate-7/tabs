import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type {
  ConnectionFilters,
  EdgeReason,
  GraphDependencyEdge,
  GraphEdge,
  GraphNode,
  ManualConnection,
} from "./types";

export type WorkspaceLookup = Map<string, { id: string; name: string }>;

/** Maps every tab id to the workspace that currently holds it, across all workspaces. */
export function buildWorkspaceLookup(workspaces: Workspace[]): WorkspaceLookup {
  const lookup: WorkspaceLookup = new Map();
  for (const workspace of workspaces) {
    for (const tab of workspace.tabs) {
      lookup.set(tab.id, { id: workspace.id, name: workspace.name });
    }
  }
  return lookup;
}

export function buildGraphNodes(tabs: Tab[], workspaceOf: WorkspaceLookup): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const tab of tabs) {
    if (!tab || typeof tab.id !== "string" || typeof tab.url !== "string") continue;
    const workspace = workspaceOf.get(tab.id);
    nodes.push({
      id: tab.id,
      tab,
      workspaceId: workspace?.id ?? "",
      workspaceName: workspace?.name ?? "Unknown",
    });
  }
  return nodes;
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function categoryOf(tab: Tab): string {
  return tab.category?.trim() || "other";
}

/**
 * Connecting every pair within a shared-attribute group is O(n^2) and turns
 * a 50-tab category into ~1,200 edges — unreadable and slow. Chaining
 * consecutive members (sorted for determinism) instead costs O(n) edges per
 * group while still pulling the group together under the link force, since
 * attraction propagates transitively along the chain.
 */
function chainEdges(ids: string[], reason: EdgeReason): Array<{ a: string; b: string; reason: EdgeReason }> {
  if (ids.length < 2) return [];
  const sorted = [...ids].sort();
  const edges: Array<{ a: string; b: string; reason: EdgeReason }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    edges.push({ a: sorted[i], b: sorted[i + 1], reason });
  }
  return edges;
}

/**
 * Builds every automatic relationship among `tabs` (domain / workspace /
 * category / group), gated by `filters`, plus manual connections (gated by
 * `filters.manual`). Nodes outside `tabs` are ignored entirely, so callers
 * scope edges to whatever subset of tabs is currently visible (a workspace
 * filter, a local-graph BFS result, etc). Deterministic: same inputs always
 * produce the same edge list in the same order, which keeps the physics
 * layout and tests stable across renders.
 */
export function buildGraphEdges(
  tabs: Tab[],
  workspaceOf: WorkspaceLookup,
  filters: ConnectionFilters,
  manualConnections: ManualConnection[]
): GraphEdge[] {
  const validIds = new Set(tabs.map((t) => t.id));
  const raw: Array<{ a: string; b: string; reason: EdgeReason }> = [];

  if (filters.domain) {
    const byDomain = new Map<string, string[]>();
    for (const tab of tabs) {
      if (!tab.domain) continue;
      const list = byDomain.get(tab.domain);
      if (list) list.push(tab.id);
      else byDomain.set(tab.domain, [tab.id]);
    }
    for (const ids of byDomain.values()) raw.push(...chainEdges(ids, "domain"));
  }

  if (filters.workspace) {
    const byWorkspace = new Map<string, string[]>();
    for (const tab of tabs) {
      const workspaceId = workspaceOf.get(tab.id)?.id;
      if (!workspaceId) continue;
      const list = byWorkspace.get(workspaceId);
      if (list) list.push(tab.id);
      else byWorkspace.set(workspaceId, [tab.id]);
    }
    for (const ids of byWorkspace.values()) raw.push(...chainEdges(ids, "workspace"));
  }

  if (filters.category) {
    const byCategory = new Map<string, string[]>();
    for (const tab of tabs) {
      const key = categoryOf(tab);
      const list = byCategory.get(key);
      if (list) list.push(tab.id);
      else byCategory.set(key, [tab.id]);
    }
    for (const ids of byCategory.values()) raw.push(...chainEdges(ids, "category"));
  }

  if (filters.group) {
    const byGroup = new Map<string, string[]>();
    for (const tab of tabs) {
      if (!tab.groupId) continue;
      const list = byGroup.get(tab.groupId);
      if (list) list.push(tab.id);
      else byGroup.set(tab.groupId, [tab.id]);
    }
    for (const ids of byGroup.values()) raw.push(...chainEdges(ids, "group"));
  }

  if (filters.manual) {
    for (const connection of manualConnections) {
      if (!validIds.has(connection.a) || !validIds.has(connection.b)) continue;
      if (connection.a === connection.b) continue;
      raw.push({ a: connection.a, b: connection.b, reason: "manual" });
    }
  }

  const merged = new Map<string, GraphEdge>();
  for (const { a, b, reason } of raw) {
    const key = edgeKey(a, b);
    const existing = merged.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      continue;
    }
    const [source, target] = a < b ? [a, b] : [b, a];
    merged.set(key, { id: key, source, target, reasons: [reason] });
  }

  return [...merged.values()].sort((x, y) => x.id.localeCompare(y.id));
}

/**
 * Builds one directional edge per TabDependency, scoped to `tabs` currently
 * visible (same convention as buildGraphEdges) — a dependency naming a tab
 * outside that set (deleted, filtered out by the workspace filter) is
 * dropped rather than rendered as a dangling edge. Kept separate from
 * buildGraphEdges's undirected merge so A→B and B→A never collide into one
 * edge — see GraphDependencyEdge's doc comment.
 */
export function buildDependencyEdges(tabs: Tab[], dependencies: TabDependency[]): GraphDependencyEdge[] {
  const validIds = new Set(tabs.map((t) => t.id));
  const edges: GraphDependencyEdge[] = [];
  for (const dep of dependencies) {
    if (!validIds.has(dep.parentTabId) || !validIds.has(dep.childTabId)) continue;
    if (dep.parentTabId === dep.childTabId) continue;
    edges.push({ id: dep.id, parentTabId: dep.parentTabId, childTabId: dep.childTabId, type: dep.type });
  }
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Maps every tab id touched by at least one edge to its total degree (plain
 * edges plus dependency edges, both endpoints counted). Shared by GraphCanvas
 * (node-size "connections" mode) and Tab Peek (the "N connections" line) so
 * both read the exact same notion of "how connected is this tab" rather than
 * keeping two counting implementations in sync by hand.
 */
export function buildDegreeMap(edges: GraphEdge[], dependencyEdges: GraphDependencyEdge[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const edge of edges) {
    map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
    map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
  }
  for (const edge of dependencyEdges) {
    map.set(edge.parentTabId, (map.get(edge.parentTabId) ?? 0) + 1);
    map.set(edge.childTabId, (map.get(edge.childTabId) ?? 0) + 1);
  }
  return map;
}
