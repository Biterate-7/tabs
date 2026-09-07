import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Section } from "@/lib/sections/types";
import { resolveCategoryKey } from "./clusters";
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

/**
 * Connecting every pair within a shared-attribute group is O(n^2) and turns
 * a 50-tab category into ~1,200 edges — unreadable and slow. Chaining
 * consecutive members instead costs O(n) edges per group while still pulling
 * the group together under the link force, since attraction propagates
 * transitively along the chain.
 *
 * WHICH chain matters as much as its length. Any spanning path over the
 * group represents the relationship equally well — "these tabs share a
 * domain/workspace/category" says nothing about pair order — so the order is
 * free to be chosen, and choosing it badly is expensive. Sorting by tab id
 * (which is what this used to do) is effectively a random permutation of the
 * group, so a chain over a group that spans the graph links arbitrary
 * far-apart pairs. Measured on the real 283-tab export, where all 283 tabs
 * share one workspace: the workspace chain's 162 pure-workspace edges
 * averaged 1237px against a graph only ~3300px across, with the longest at
 * 2843px — an edge crossing 86% of the canvas whose entire meaning is "both
 * of these are in the workspace you are already looking at". Those are the
 * long stretched lines, and each one is also a 100px-rest-length spring
 * pulling two tabs out of their own clusters.
 *
 * `orderOf` therefore supplies a LOCALITY-PRESERVING sort key: consecutive
 * members of the chain are tabs the layout already places near each other
 * (same category, then same domain), so a group's chain is a short walk
 * through its own territory rather than a random walk across the graph. Same
 * edge count, same relationship, same determinism — the ties still break on
 * id — but the edges land where the nodes actually are.
 */
function chainEdges(
  ids: string[],
  reason: EdgeReason,
  orderOf?: (id: string) => string
): Array<{ a: string; b: string; reason: EdgeReason }> {
  if (ids.length < 2) return [];
  const sorted = orderOf
    ? [...ids].sort((a, b) => {
        const keyA = orderOf(a);
        const keyB = orderOf(b);
        return keyA < keyB ? -1 : keyA > keyB ? 1 : a < b ? -1 : a > b ? 1 : 0;
      })
    : [...ids].sort();
  const edges: Array<{ a: string; b: string; reason: EdgeReason }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    edges.push({ a: sorted[i], b: sorted[i + 1], reason });
  }
  return edges;
}

/**
 * Where a tab's cluster sits in the world, for `buildChainOrder`. Supplied by
 * the caller (graph-view.tsx already computes exactly this, via
 * `computeClusterAnchors`) rather than derived here, so this module keeps no
 * dependency on the layout it is ordering against.
 */
export type ChainAnchorOf = (tabId: string) => { x: number; y: number } | undefined;

/**
 * Serpentine ("boustrophedon") rank for a set of cluster anchor points: sweep
 * the plane in horizontal bands, left-to-right in one band and right-to-left
 * in the next, so consecutive ranks are always adjacent in space and the
 * sweep never jumps back across the whole graph at the end of a row.
 *
 * This decides where a chain's unavoidable SEAMS land. A single spanning
 * chain over a graph of k clusters must cross between clusters k-1 times, and
 * every crossing draws an edge — so the only thing that can be chosen is
 * whether a crossing joins two neighbouring clusters or two clusters on
 * opposite sides of the canvas. Ordered by category key (a hash-like id, i.e.
 * spatially arbitrary) it was the latter: measured on the real export after
 * within-cluster locality ordering but before this, 70 workspace edges still
 * averaged 841px and the longest ran 3218px — 93% of the graph's own width —
 * and every one of them was a seam.
 *
 * Band height comes from the anchors' own spread rather than a fixed number,
 * so this behaves the same on a tight 10-tab graph as on a sprawling 500-tab
 * one.
 */
function serpentineRanks(points: Map<string, { x: number; y: number }>): Map<string, number> {
  const entries = [...points.entries()];
  if (entries.length <= 1) return new Map(entries.map(([key], index) => [key, index]));

  const ys = entries.map(([, p]) => p.y);
  const minY = Math.min(...ys);
  const spread = Math.max(...ys) - minY;
  // ~sqrt(k) bands: the aspect ratio a roughly square blob of k clusters
  // wants. Guarded so a degenerate single-row layout stays one band.
  const bandCount = Math.max(1, Math.round(Math.sqrt(entries.length)));
  const bandHeight = spread > 0 ? spread / bandCount : 1;

  const banded = entries.map(([key, p]) => ({
    key,
    p,
    band: spread > 0 ? Math.min(bandCount - 1, Math.floor((p.y - minY) / bandHeight)) : 0,
  }));
  banded.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    const direction = a.band % 2 === 0 ? 1 : -1;
    if (a.p.x !== b.p.x) return (a.p.x - b.p.x) * direction;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const ranks = new Map<string, number>();
  banded.forEach((entry, index) => ranks.set(entry.key, index));
  return ranks;
}

/**
 * Sort keys for `chainEdges`, one per tab: "where the layout puts this tab",
 * coarse to fine. A chain sorted by this walks cluster by cluster along a
 * serpentine sweep of the canvas and, within a cluster, domain by domain —
 * the same nesting the cluster tree and the boundary boxes use (see
 * clusters.ts), so a chained pair is almost always a pair that already shares
 * a boundary box, and the pairs that aren't are spatial neighbours.
 *
 * Without `anchorOf` the sweep is unavailable and clusters fall back to being
 * ordered by category key. That is still locality-preserving WITHIN a cluster
 * — the part that accounts for the overwhelming majority of edges; only the
 * seams between clusters lose their ordering.
 *
 * The levels are joined by U+0000, which sorts below every character a
 * category key, domain or id can contain — that is what makes the composite
 * string order identically to a true lexicographic tuple ordering, instead of
 * one where a long category key can bleed into the next field.
 */
const CHAIN_KEY_SEPARATOR = "\u0000";

function buildChainOrder(
  tabs: Tab[],
  sections: Section[],
  anchorOf?: ChainAnchorOf
): (id: string) => string {
  const categoryOf = new Map<string, string>();
  for (const tab of tabs) categoryOf.set(tab.id, resolveCategoryKey(tab, sections));

  let clusterRank: Map<string, number> | null = null;
  if (anchorOf) {
    const anchorByCategory = new Map<string, { x: number; y: number }>();
    for (const tab of tabs) {
      const category = categoryOf.get(tab.id)!;
      if (anchorByCategory.has(category)) continue;
      const anchor = anchorOf(tab.id);
      if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
        anchorByCategory.set(category, anchor);
      }
    }
    // Only swept when the anchors describe EVERY category: a partial map
    // would interleave ranked and unranked categories, which orders worse
    // than either scheme on its own.
    if (anchorByCategory.size > 0 && anchorByCategory.size === new Set(categoryOf.values()).size) {
      clusterRank = serpentineRanks(anchorByCategory);
    }
  }

  const keyById = new Map<string, string>();
  for (const tab of tabs) {
    const category = categoryOf.get(tab.id)!;
    // Zero-padded so a numeric rank still sorts numerically under the string
    // comparison chainEdges does.
    const head = clusterRank ? String(clusterRank.get(category) ?? 0).padStart(6, "0") : category;
    keyById.set(tab.id, [head, tab.domain ?? "", tab.id].join(CHAIN_KEY_SEPARATOR));
  }
  return (id) => keyById.get(id) ?? id;
}

/**
 * Builds every automatic relationship among `tabs` (domain / workspace /
 * category / group), gated by `filters`, plus manual connections (gated by
 * `filters.manual`). Nodes outside `tabs` are ignored entirely, so callers
 * scope edges to whatever subset of tabs is currently visible (a workspace
 * filter, a local-graph BFS result, etc). Deterministic: same inputs always
 * produce the same edge list in the same order, which keeps the physics
 * layout and tests stable across renders.
 *
 * `clusterAnchorOf` is optional layout information — where each tab's cluster
 * sits — used only to decide the ORDER the O(n) group chains run in, never
 * which tabs are related. Omitting it produces the same edge count and the
 * same relationships, just with the chains' cluster-to-cluster seams landing
 * arbitrarily instead of between neighbours. See `buildChainOrder`.
 */
export function buildGraphEdges(
  tabs: Tab[],
  workspaceOf: WorkspaceLookup,
  filters: ConnectionFilters,
  manualConnections: ManualConnection[],
  sections: Section[] = [],
  clusterAnchorOf?: ChainAnchorOf
): GraphEdge[] {
  const validIds = new Set(tabs.map((t) => t.id));
  const raw: Array<{ a: string; b: string; reason: EdgeReason }> = [];
  // Shared by every chained group below, so all five relationship types lay
  // their chains along the same category → domain → id ordering the layout is
  // itself built around. See chainEdges.
  const chainOrder = buildChainOrder(tabs, sections, clusterAnchorOf);

  if (filters.domain) {
    const byDomain = new Map<string, string[]>();
    for (const tab of tabs) {
      if (!tab.domain) continue;
      const list = byDomain.get(tab.domain);
      if (list) list.push(tab.id);
      else byDomain.set(tab.domain, [tab.id]);
    }
    for (const ids of byDomain.values()) raw.push(...chainEdges(ids, "domain", chainOrder));
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
    for (const ids of byWorkspace.values()) raw.push(...chainEdges(ids, "workspace", chainOrder));
  }

  if (filters.category) {
    // Section-tree-aware: two tabs under different Subcategories of the same
    // root Category now correctly share a "category" edge (they used to get
    // none at all, since tab.category is only ever set for section-less
    // tabs) — see resolveCategoryKey's doc comment. Uses the exact same key
    // clusters.ts's cluster tree buckets by, so an edge and a cluster
    // boundary can never disagree about "same category."
    const byCategory = new Map<string, string[]>();
    for (const tab of tabs) {
      const key = resolveCategoryKey(tab, sections);
      const list = byCategory.get(key);
      if (list) list.push(tab.id);
      else byCategory.set(key, [tab.id]);
    }
    for (const ids of byCategory.values()) raw.push(...chainEdges(ids, "category", chainOrder));
  }

  if (filters.group) {
    const byGroup = new Map<string, string[]>();
    for (const tab of tabs) {
      if (!tab.groupId) continue;
      const list = byGroup.get(tab.groupId);
      if (list) list.push(tab.id);
      else byGroup.set(tab.groupId, [tab.id]);
    }
    for (const ids of byGroup.values()) raw.push(...chainEdges(ids, "group", chainOrder));
  }

  if (filters.section) {
    const bySection = new Map<string, string[]>();
    for (const tab of tabs) {
      if (!tab.sectionId) continue;
      const list = bySection.get(tab.sectionId);
      if (list) list.push(tab.id);
      else bySection.set(tab.sectionId, [tab.id]);
    }
    for (const ids of bySection.values()) raw.push(...chainEdges(ids, "section", chainOrder));
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
