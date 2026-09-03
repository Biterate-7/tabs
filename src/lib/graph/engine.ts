import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode } from "./types";
import type { ClusterAnchorAssignment } from "./clusters";

export type PhysicsNode = SimulationNodeDatum & {
  id: string;
  radius: number;
};

type PhysicsLink = SimulationLinkDatum<PhysicsNode>;

export type GraphSimulation = {
  /** Advances the simulation by one step. Call once per animation frame; a no-op once the simulation has cooled below its alphaMin. */
  tick: () => void;
  isSettled: () => boolean;
  /** Bumps alpha back up so the layout reacts to a change (new node, new edge, drag start) instead of staying frozen. */
  reheat: (amount?: number) => void;
  /**
   * Replaces the node set. Nodes that existed before keep their current
   * physics position/velocity (so an edge-filter change doesn't reset
   * everything); brand new nodes seed from `initialPositions` when
   * available, otherwise scatter lightly around the origin so they don't
   * all spawn stacked exactly on top of each other.
   */
  setNodes: (
    nodes: GraphNode[],
    radiusOf: (node: GraphNode) => number,
    initialPositions: Record<string, { x: number; y: number }>,
    /** Optional seed for a brand-new node (no saved position): jitters it near this point instead of the world origin, so it appears roughly where its cluster already is instead of having to physically migrate there. */
    anchorFallback?: (node: GraphNode) => { x: number; y: number } | undefined
  ) => void;
  setEdges: (edges: GraphEdge[], strength: number) => void;
  /**
   * Installs a weak attraction pulling each collection's member nodes toward
   * their shared centroid — the graph's "collection members tend to
   * cluster" behavior (AGENTS.md-style spec: "influence layout, not
   * dominate it"). Single-member collections are skipped (nothing to
   * cluster toward). Deliberately much weaker than the link force so
   * dependency/manual-link edges and the charge/collide forces still win —
   * see COLLECTION_FORCE_STRENGTH.
   */
  setCollections: (collections: { tabIds: string[] }[]) => void;
  /**
   * Installs the hierarchical Category/Subcategory anchor pull — a weak,
   * per-tab target position derived from lib/graph/clusters.ts's
   * deterministic cluster-anchor seeding. Unlike the collection force above,
   * this doesn't need a live-centroid computation (the target is a fixed
   * point per tick), so it's implemented as plain forceX/forceY accessor
   * forces rather than a hand-rolled Force. A tab absent from `assignments`
   * (or with a null anchor) is left untouched — the accessor falls back to
   * the node's own current position, i.e. a true no-op.
   */
  setClusterAnchors: (assignments: Map<string, ClusterAnchorAssignment>) => void;
  pin: (id: string, x: number, y: number) => void;
  unpin: (id: string) => void;
  findNode: (id: string) => PhysicsNode | undefined;
};

const ALPHA_MIN = 0.005;
// Tuned together, not independently: the spec treats "subcategory" and
// "collection" as the same attraction tier, so COLLECTION_FORCE_STRENGTH
// sits close to SUBCATEGORY_ANCHOR_STRENGTH rather than well below it, while
// CATEGORY_ANCHOR_STRENGTH stays the loosest (outermost) pull. All three
// remain far below collide(0.85)/link(<=0.5) so they influence layout
// without ever fighting node-overlap or explicit-relationship forces.
const COLLECTION_FORCE_STRENGTH = 0.045;
const CATEGORY_ANCHOR_STRENGTH = 0.02;
const SUBCATEGORY_ANCHOR_STRENGTH = 0.05;

/**
 * Pulls every node toward a per-node anchor point read fresh each tick from
 * `anchorById`/`byId` (both closed over from createGraphSimulation), rather
 * than d3-force's built-in forceX/forceY — those cache their accessor
 * function's result once at `initialize()` time (when `.nodes()` is set),
 * so a `setClusterAnchors()` call arriving after `setNodes()` (the actual
 * call order in graph-canvas.tsx's physics effect) would otherwise be
 * silently ignored until the next full setNodes(). Reading live state each
 * tick, like createCollectionForce below, sidesteps that entirely.
 */
function createClusterAnchorForce(
  strength: number,
  byId: Map<string, PhysicsNode>,
  anchorById: () => Map<string, ClusterAnchorAssignment>,
  pick: (a: ClusterAnchorAssignment) => { x: number; y: number } | null
): Force<PhysicsNode, PhysicsLink> {
  return ((alpha: number) => {
    const anchors = anchorById();
    for (const [id, node] of byId) {
      if (node.x === undefined || node.y === undefined) continue;
      const assignment = anchors.get(id);
      const target = assignment ? pick(assignment) : null;
      if (!target) continue;
      node.vx = (node.vx ?? 0) + (target.x - node.x) * strength * alpha;
      node.vy = (node.vy ?? 0) + (target.y - node.y) * strength * alpha;
    }
  }) as Force<PhysicsNode, PhysicsLink>;
}

/** A minimal d3-force-compatible force: pulls each group of nodes toward its own centroid, scaled by alpha like any built-in force. */
function createCollectionForce(strength: number) {
  let groups: PhysicsNode[][] = [];
  const force = ((alpha: number) => {
    for (const group of groups) {
      if (group.length < 2) continue;
      let cx = 0;
      let cy = 0;
      let counted = 0;
      for (const n of group) {
        if (n.x === undefined || n.y === undefined) continue;
        cx += n.x;
        cy += n.y;
        counted += 1;
      }
      if (counted === 0) continue;
      cx /= counted;
      cy /= counted;
      for (const n of group) {
        if (n.x === undefined || n.y === undefined) continue;
        n.vx = (n.vx ?? 0) + (cx - n.x) * strength * alpha;
        n.vy = (n.vy ?? 0) + (cy - n.y) * strength * alpha;
      }
    }
  }) as Force<PhysicsNode, PhysicsLink> & { setGroups: (next: PhysicsNode[][]) => void };
  force.setGroups = (next) => {
    groups = next;
  };
  return force;
}

export function createGraphSimulation(): GraphSimulation {
  const byId = new Map<string, PhysicsNode>();
  const collectionForce = createCollectionForce(COLLECTION_FORCE_STRENGTH);
  let anchorById = new Map<string, ClusterAnchorAssignment>();
  const getAnchorById = () => anchorById;
  const categoryAnchorForce = createClusterAnchorForce(
    CATEGORY_ANCHOR_STRENGTH,
    byId,
    getAnchorById,
    (a) => a.categoryAnchor
  );
  const subcategoryAnchorForce = createClusterAnchorForce(
    SUBCATEGORY_ANCHOR_STRENGTH,
    byId,
    getAnchorById,
    (a) => a.subcategoryAnchor
  );

  const simulation: Simulation<PhysicsNode, PhysicsLink> = forceSimulation<PhysicsNode>([])
    .force("charge", forceManyBody().strength(-260).distanceMax(600))
    .force(
      "collide",
      forceCollide<PhysicsNode>()
        .radius((n) => n.radius + 26)
        .strength(0.9)
    )
    .force("center", forceCenter(0, 0).strength(0.015))
    .force("x", forceX(0).strength(0.008))
    .force("y", forceY(0).strength(0.008))
    .force("collections", collectionForce)
    .force("categoryAnchor", categoryAnchorForce)
    .force("subcategoryAnchor", subcategoryAnchorForce)
    .alphaMin(ALPHA_MIN)
    .alphaDecay(0.025)
    .velocityDecay(0.32)
    .stop();

  function setNodes(
    nodes: GraphNode[],
    radiusOf: (node: GraphNode) => number,
    initialPositions: Record<string, { x: number; y: number }>,
    anchorFallback?: (node: GraphNode) => { x: number; y: number } | undefined
  ) {
    const next: PhysicsNode[] = nodes.map((node) => {
      const existing = byId.get(node.id);
      if (existing) {
        existing.radius = radiusOf(node);
        return existing;
      }
      const saved = initialPositions[node.id];
      if (saved) return { id: node.id, radius: radiusOf(node), x: saved.x, y: saved.y };

      // No saved position: seed near the tab's eventual cluster anchor (small
      // jitter) when one is known, instead of scattering around the world
      // origin — the anchor forces would otherwise have to drag a new tab
      // across the whole canvas to reach its cluster.
      const anchor = anchorFallback?.(node);
      const angle = Math.random() * Math.PI * 2;
      const dist = anchor ? 24 * Math.random() : 60 + Math.random() * 160;
      const originX = anchor?.x ?? 0;
      const originY = anchor?.y ?? 0;
      return {
        id: node.id,
        radius: radiusOf(node),
        x: originX + Math.cos(angle) * dist,
        y: originY + Math.sin(angle) * dist,
      };
    });

    byId.clear();
    for (const n of next) byId.set(n.id, n);
    simulation.nodes(next);
  }

  function setEdges(edges: GraphEdge[], strength: number) {
    const links: PhysicsLink[] = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    simulation.force(
      "link",
      forceLink<PhysicsNode, PhysicsLink>(links)
        .id((n) => n.id)
        .distance(100)
        .strength(Math.max(0.02, Math.min(1, strength)) * 0.5)
    );
  }

  function setCollections(collections: { tabIds: string[] }[]) {
    const groups = collections
      .map((c) => c.tabIds.map((id) => byId.get(id)).filter((n): n is PhysicsNode => Boolean(n)))
      .filter((group) => group.length >= 2);
    collectionForce.setGroups(groups);
  }

  function setClusterAnchors(assignments: Map<string, ClusterAnchorAssignment>) {
    anchorById = assignments;
  }

  return {
    tick: () => {
      if (simulation.alpha() > simulation.alphaMin()) simulation.tick();
    },
    isSettled: () => simulation.alpha() <= simulation.alphaMin(),
    reheat: (amount = 0.4) => {
      simulation.alpha(Math.max(simulation.alpha(), amount));
    },
    setNodes,
    setEdges,
    setCollections,
    setClusterAnchors,
    pin: (id, x, y) => {
      const node = byId.get(id);
      if (!node) return;
      node.fx = x;
      node.fy = y;
    },
    unpin: (id) => {
      const node = byId.get(id);
      if (!node) return;
      node.fx = null;
      node.fy = null;
    },
    findNode: (id) => byId.get(id),
  };
}
