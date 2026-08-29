import type { Tab } from "@/lib/tabs/types";
import type { DependencyType } from "@/lib/dependencies/types";

/** The relationship signals a graph edge can be built from. `manual` is user-created and never auto-generated. */
export type EdgeReason = "domain" | "workspace" | "category" | "group" | "manual";

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
  manual: true,
  dependencies: true,
};

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
};

export type GraphPersistedState = {
  version: 1;
  positions: Record<string, { x: number; y: number }>;
  manualConnections: ManualConnection[];
  settings: GraphSettings;
};
