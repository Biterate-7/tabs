import type { Tab } from "@/lib/tabs/types";
import type { DependencyType } from "@/lib/dependencies/types";

/** The relationship signals a graph edge can be built from. `manual` is user-created and never auto-generated. */
export type EdgeReason = "domain" | "workspace" | "category" | "group" | "section" | "manual";

/**
 * `dependencies` gates a separate, directional edge set (see
 * GraphDependencyEdge) built from the dependency store rather than from
 * EdgeReason — dependencies aren't a symmetric "these two match" signal like
 * the others, so they don't fit EdgeReason's undirected-pair model.
 */
export type ConnectionFilters = Record<Exclude<EdgeReason, "manual">, boolean> & {
  manual: boolean;
  dependencies: boolean;
};

export const DEFAULT_CONNECTION_FILTERS: ConnectionFilters = {
  domain: true,
  workspace: true,
  category: false,
  group: false,
  section: false,
  manual: true,
  dependencies: true,
};

/**
 * Absolute ceiling on |x| and |y| for anything in the graph's world — a node,
 * a boundary square's centre, a saved position, a saved boundary offset.
 *
 * A last-resort numeric guard, not a layout constraint: the layout's own
 * territories and the boundary sandbox both sit orders of magnitude inside
 * it. It exists so a coordinate that has gone bad by some route nobody
 * anticipated is caught and recovered rather than left to propagate — past
 * this magnitude the next multiply reaches Infinity, and one Infinity turns
 * every position derived from it into NaN, which is a node that renders
 * nowhere and hit-tests nowhere.
 *
 * Lives here, with no dependencies of its own, so the physics engine, the
 * boundary layer and the persistence layer can all agree on one number rather
 * than each carrying a copy.
 */
export const MAX_GRAPH_COORD = 1e7;

export type GraphNode = {
  id: string;
  tab: Tab;
  workspaceId: string;
  workspaceName: string;
};

/** One resolved edge between two tabs, carrying every reason that justifies it (a pair can match more than one relationship at once). */
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  reasons: EdgeReason[];
};

export type ManualConnection = {
  a: string;
  b: string;
  createdAt: number;
};

/**
 * A directional edge built from one TabDependency, kept separate from
 * GraphEdge (which canonicalizes source/target into an undirected pair) so
 * A→B and B→A can coexist as two distinct edges instead of colliding on one
 * merged undirected key.
 */
export type GraphDependencyEdge = {
  id: string;
  parentTabId: string;
  childTabId: string;
  type?: DependencyType;
};

export type GraphViewMode = "global" | "local";

/** `"infinite"` stands in for Infinity so the value survives JSON persistence. */
export type GraphDepth = 1 | 2 | 3 | "infinite";

export type NodeSizeMode = "uniform" | "connections" | "relevance";

export type CameraState = {
  x: number;
  y: number;
  zoom: number;
};

export type GraphDisplaySettings = {
  nodeSize: NodeSizeMode;
  edgeStrength: number;
  textSize: number;
};

export type GraphSettings = {
  view: GraphViewMode;
  depth: GraphDepth;
  filters: ConnectionFilters;
  display: GraphDisplaySettings;
  sidebarOpen: boolean;
  workspaceFilter: string | "all";
  camera: CameraState;
  selectedTabId: string | null;
  /** Master toggle for the Category/Subcategory boundary+label rendering (lib/graph/clusters.ts) — independent of Collection boundaries, which have always been on and stay that way. */
  showClusterBoundaries: boolean;
};

export const DEFAULT_CAMERA: CameraState = { x: 0, y: 0, zoom: 1 };

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  view: "global",
  depth: 2,
  filters: DEFAULT_CONNECTION_FILTERS,
  display: { nodeSize: "connections", edgeStrength: 1, textSize: 1 },
  sidebarOpen: true,
  workspaceFilter: "all",
  camera: DEFAULT_CAMERA,
  selectedTabId: null,
  showClusterBoundaries: true,
};

export type GraphPersistedState = {
  version: 1;
  positions: Record<string, { x: number; y: number }>;
  /**
   * How far each tab's cluster anchor and confinement disc have been carried
   * by boundary-square drags — see engine.ts's anchorOffsetById.
   *
   * Saved alongside `positions` because on its own a saved position doesn't
   * survive a reload: computeClusterAnchors puts a category's territory back
   * at its canonical point every session, and confineToRegions then projects
   * the tabs straight back into it, undoing the move. Keyed by tab id, like
   * `positions`, so it prunes with exactly the same rule.
   *
   * Absent in blobs written before draggable boundaries existed; an empty
   * record means "nothing has been moved", which is the correct reading.
   */
  boundaryOffsets: Record<string, { x: number; y: number }>;
  manualConnections: ManualConnection[];
  settings: GraphSettings;
};
