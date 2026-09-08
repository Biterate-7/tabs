import { createGraphSimulation } from "./engine";
import { buildClusterTree, computeClusterAnchors } from "./clusters";
import { computeNodeRadius } from "./node-size";
import { buildDegreeMap, buildDependencyEdges, buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "./relations";
import type { GraphPersistedState } from "./types";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Workspace } from "@/lib/workspace/types";
import {
  CATEGORY_BOUNDARY_PADDING,
  COLLECTION_BOUNDARY_PADDING,
  SUBCATEGORY_BOUNDARY_PADDING,
  computeCollectionBoundary,
  resolveLiveBoundaries,
  type BoundaryCandidate,
  type BoundaryOccupant,
} from "./collection-layout";
import type { ClusterAnchorAssignment, ClusterTree } from "./clusters";
import type { GraphEdge, GraphNode } from "./types";

/**
 * A hard ceiling, not the expected cost: the simulation cools below its own
 * alphaMin in roughly 180 ticks from a full reheat, and the boundary layer
 * falls asleep shortly after. This only bounds the pathological case (a
 * boundary body oscillating against a neighbour and never quite sleeping) so
 * a dump can always finish, and matches the bound the layout verification
 * harness already uses (g-verification.test.ts).
 */
export const MAX_PRECOMPUTE_TICKS = 8000;

/**
 * How often the live boundary set is re-elected during the precompute. The
 * bodies themselves re-derive their rect from member positions every tick
 * (engine.ts), so this only has to keep up with clusters becoming eligible
 * as the layout spreads out — the renderer does the same work once per
 * frame, this does it once per 8 ticks.
 */
const BOUNDARY_REFRESH_INTERVAL = 8;

export type LayoutPrecomputeInput = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusterTree: ClusterTree;
  clusterAnchors: Map<string, ClusterAnchorAssignment>;
  collections: { id: string; tabIds: string[] }[];
  radiusOf: (node: GraphNode) => number;
  /** Positions already persisted for tabs the user has seen before — carried through unchanged, exactly as GraphCanvas would. */
  positions: Record<string, { x: number; y: number }>;
  boundaryOffsets: Record<string, { x: number; y: number }>;
  edgeStrength: number;
};

export type LayoutPrecomputeResult = {
  positions: Record<string, { x: number; y: number }>;
  boundaryOffsets: Record<string, { x: number; y: number }>;
  /** How many physics ticks were actually needed — reported so the "settled" claim is measurable rather than asserted. */
  ticks: number;
  /** False only when MAX_PRECOMPUTE_TICKS was hit first. The layout is still coherent (it has been through thousands of ticks), just not provably at rest. */
  settled: boolean;
};

export type LayoutPrecompute = {
  /** Advances at most `maxTicks` ticks. Returns true once the layout has settled (or the tick ceiling is reached), so the caller can yield to the browser between slices instead of blocking a large dump's whole settle on one frame. */
  step: (maxTicks: number) => boolean;
  ticks: () => number;
  settled: () => boolean;
  result: () => LayoutPrecomputeResult;
};

/**
 * Runs the graph's REAL physics — the same createGraphSimulation, the same
 * forces, the same boundary layer the canvas runs — with no canvas attached,
 * so a dump's final layout can be brought to rest BEFORE the Graph View is
 * ever mounted.
 *
 * This is what makes "the first interactive frame is the final frame" true.
 * Without it the canvas seeds nodes at their cluster anchors, reheats to
 * alpha 0.5 and settles on screen over ~180 frames — which is precisely the
 * "graph opens, then everything moves around for several seconds" the
 * readiness gate exists to eliminate. Feeding the settled positions back
 * through GraphPersistedState.positions means setNodes() adopts them
 * verbatim (see engine.ts) and the layout opens already at its fixed point.
 *
 * The boundary layer is included deliberately: boundary squares are physics
 * bodies that shove their members around (engine.ts's
 * translateBoundaryMembers), so a layout that settled without them would
 * still visibly rearrange the moment the renderer created them.
 */
export function createLayoutPrecompute(input: LayoutPrecomputeInput): LayoutPrecompute {
  const simulation = createGraphSimulation();

  // Deliberately the same call order as graph-canvas.tsx's physics effect:
  // setNodes prunes stale anchor offsets, seedBoundaryOffsets restores the
  // ones that survived, and setClusterAnchors reads both.
  simulation.setNodes(
    input.nodes,
    input.radiusOf,
    input.positions,
    (node) => input.clusterAnchors.get(node.id)?.categoryAnchor ?? undefined
  );
  simulation.seedBoundaryOffsets(input.boundaryOffsets);
  simulation.setEdges(input.edges, input.edgeStrength);
  simulation.setCollections(input.collections);
  simulation.setClusterAnchors(input.clusterAnchors);
  simulation.reheat(1);

  const liveBoundaryIds = new Set<string>();
  let tickCount = 0;

  function positionOf(id: string): { x: number; y: number; radius: number } | null {
    const node = simulation.findNode(id);
    if (!node || node.x === undefined || node.y === undefined) return null;
    return { x: node.x, y: node.y, radius: node.radius };
  }

  /**
   * The renderer's boundary pass, minus the drawing: same candidate rects
   * (same paddings), same `resolveLiveBoundaries` admission latch, same
   * resulting body specs. Kept in lockstep with graph-canvas.tsx's draw() on
   * purpose — a precompute that settled a different boundary set than the one
   * the canvas creates would hand the user a layout that still had to
   * rearrange on open.
   */
  function refreshBoundaryBodies(): void {
    const occupants: BoundaryOccupant[] = [];
    for (const node of input.nodes) {
      const point = positionOf(node.id);
      if (point) occupants.push({ id: node.id, x: point.x, y: point.y });
    }

    const candidates: BoundaryCandidate[] = [];
    const specs: { id: string; memberIds: string[]; padding: number }[] = [];

    const offer = (id: string, memberIds: string[], padding: number) => {
      const points: { x: number; y: number; radius: number }[] = [];
      for (const memberId of memberIds) {
        const point = positionOf(memberId);
        if (point) points.push(point);
      }
      // Matches the renderer: a cluster with a single positioned member draws
      // no box unless it is selected, and nothing is selected here.
      if (points.length < 2) return;
      const rect = computeCollectionBoundary(points, padding);
      if (!rect) return;
      candidates.push({ id, rect, memberIds: new Set(memberIds) });
      specs.push({ id, memberIds, padding });
    };

    for (const category of input.clusterTree.roots) {
      offer(category.id, category.totalTabIds, CATEGORY_BOUNDARY_PADDING);
      for (const child of category.children) {
        if (child.kind === "subcategory") offer(child.id, child.totalTabIds, SUBCATEGORY_BOUNDARY_PADDING);
      }
    }
    for (const collection of input.collections) {
      offer(collection.id, collection.tabIds, COLLECTION_BOUNDARY_PADDING);
    }

    resolveLiveBoundaries(candidates, liveBoundaryIds, occupants, new Set());
    simulation.setBoundaryBodies(specs.filter((spec) => liveBoundaryIds.has(spec.id)));
  }

  function isSettled(): boolean {
    return simulation.isSettled() && simulation.isBoundaryLayerSettled();
  }

  refreshBoundaryBodies();

  return {
    step: (maxTicks: number) => {
      for (let i = 0; i < maxTicks; i++) {
        if (isSettled() || tickCount >= MAX_PRECOMPUTE_TICKS) break;
        simulation.tick();
        tickCount++;
        if (tickCount % BOUNDARY_REFRESH_INTERVAL === 0) refreshBoundaryBodies();
      }
      return isSettled() || tickCount >= MAX_PRECOMPUTE_TICKS;
    },
    ticks: () => tickCount,
    settled: () => isSettled(),
    result: () => {
      const positions: Record<string, { x: number; y: number }> = { ...input.positions };
      for (const node of input.nodes) {
        const point = positionOf(node.id);
        if (point) positions[node.id] = { x: point.x, y: point.y };
      }

      const boundaryOffsets: Record<string, { x: number; y: number }> = { ...input.boundaryOffsets };
      for (const moved of simulation.takeDisplacedBoundaryMembers()) {
        boundaryOffsets[moved.id] = moved.offset;
      }

      return { positions, boundaryOffsets, ticks: tickCount, settled: isSettled() };
    },
  };
}

/** Convenience wrapper that runs a precompute to completion in one go — used by tests and by callers with no frame budget to respect. */
export function precomputeGraphLayout(input: LayoutPrecomputeInput): LayoutPrecomputeResult {
  const precompute = createLayoutPrecompute(input);
  precompute.step(MAX_PRECOMPUTE_TICKS);
  return precompute.result();
}

/** Small, pure, deterministic string hash — used only to keep the layout key short in localStorage, never for anything security-sensitive. */
function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Identifies the exact graph a settled layout belongs to: which tabs are in
 * it, which cluster each one sits in, and the display settings that shape the
 * forces.
 *
 * This is what lets the canvas know whether the positions it was handed are
 * still the finished layout for what it is about to draw — and therefore
 * whether it may open static (`cool()`) or has to lay out again. Without it,
 * "every node has a saved position" would wrongly count as settled after any
 * structural change that keeps the same tabs: recategorizing a tab, applying
 * an Auto-Organize plan, moving one between sections. Those all change a
 * tab's cluster, and a cluster change is a layout change.
 */
export function computeLayoutKey(
  clusterTree: ClusterTree,
  nodeIds: string[],
  settings: GraphPersistedState["settings"]
): string {
  const entries = nodeIds
    .map((id) => `${id}@${(clusterTree.clusterPathOfTab.get(id) ?? []).join(">")}`)
    .sort();
  const shape = [
    settings.display.nodeSize,
    settings.display.edgeStrength,
    settings.workspaceFilter,
    Object.entries(settings.filters)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, on]) => `${name}=${on ? 1 : 0}`)
      .join(","),
  ].join("|");
  return hashString(`${shape}#${entries.join(";")}`);
}

/**
 * Derives exactly the node/edge/cluster set GraphView would build for the
 * global view, from the same raw materials it reads (the workspace store, the
 * dependency and collection stores, and the persisted graph settings).
 *
 * It has to agree with graph-view.tsx: a precompute that settled a different
 * graph than the one that gets mounted would hand the user positions their
 * actual graph then has to move away from — the very thing this is here to
 * prevent. Local view (`view: "local"`) is deliberately NOT modelled: it
 * shows a filtered subset of these same nodes at these same positions, so
 * settling the global layout settles it too.
 */
export function resolveGraphLayoutInput(
  workspaces: Workspace[],
  dependencies: TabDependency[],
  collections: Collection[],
  graphState: GraphPersistedState
): LayoutPrecomputeInput {
  const workspaceLookup = buildWorkspaceLookup(workspaces);
  const allTabs = workspaces.flatMap((w) => w.tabs);
  const workspaceFilter = graphState.settings.workspaceFilter;
  const scopedTabs =
    workspaceFilter === "all" ? allTabs : allTabs.filter((t) => workspaceLookup.get(t.id)?.id === workspaceFilter);

  const sections = workspaces.flatMap((w) => w.sections ?? []);
  const nodes = buildGraphNodes(scopedTabs, workspaceLookup);
  const relationEdges = buildGraphEdges(
    scopedTabs,
    workspaceLookup,
    graphState.settings.filters,
    graphState.manualConnections,
    sections
  );
  const dependencyEdges = graphState.settings.filters.dependencies
    ? buildDependencyEdges(scopedTabs, dependencies)
    : [];
  const degreeById = buildDegreeMap(relationEdges, dependencyEdges);
  const clusterTree = buildClusterTree(scopedTabs, sections, collections);

  return {
    nodes,
    // The physics edge set, as graph-canvas.tsx assembles it: relation edges
    // plus dependency edges flattened into the same undirected springs.
    edges: [
      ...relationEdges,
      ...dependencyEdges.map((e) => ({ id: e.id, source: e.parentTabId, target: e.childTabId, reasons: [] })),
    ],
    clusterTree,
    clusterAnchors: computeClusterAnchors(clusterTree),
    collections,
    // `centerDistances` is undefined here for the same reason local view is
    // not modelled — the "relevance" size mode only differs inside it.
    radiusOf: (node) => computeNodeRadius(graphState.settings.display.nodeSize, degreeById.get(node.id) ?? 0, undefined),
    positions: graphState.positions,
    boundaryOffsets: graphState.boundaryOffsets,
    edgeStrength: graphState.settings.display.edgeStrength,
  };
}
