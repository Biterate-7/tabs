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
import {
  releaseVelocity,
  stepBoundaryBodies,
  type BoundaryBody,
  type BoundaryDrag,
  type Sandbox,
} from "./boundary-physics";

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

  /**
   * Declares which boundary squares currently exist as physics bodies — the
   * renderer passes exactly the boxes it actually drew this frame, so what is
   * grabbable is always what is visible. Bodies already present keep their
   * velocity/sleep state (and the in-progress drag), new ids get a fresh
   * resting body, and ids no longer present are dropped.
   *
   * A body has no position of its own: its rect is re-derived from
   * `memberIds`' live physics positions on every tick, padded by `padding`
   * world units (the renderer's screen-space padding divided by the zoom).
   */
  setBoundaryBodies: (specs: { id: string; memberIds: string[]; padding: number }[]) => void;
  /** The world-space rect boundary bodies are kept inside. `null` removes the walls. */
  setBoundarySandbox: (sandbox: Sandbox | null) => void;
  /** Grabs the body at `id` from world point (x, y). Returns false when there's no such body. */
  beginBoundaryDrag: (id: string, x: number, y: number) => boolean;
  /** Retargets the in-progress drag to a world point. No-op when nothing is being dragged. */
  moveBoundaryDrag: (x: number, y: number) => void;
  /** Releases the dragged body back into the physics, keeping a damped, capped share of the pointer's speed. */
  endBoundaryDrag: () => void;
  getBoundaryBody: (id: string) => BoundaryBody | undefined;
  /** True once nothing is being dragged and every boundary body has come to rest. */
  isBoundaryLayerSettled: () => boolean;
  /**
   * Restores previously persisted per-tab anchor offsets (see
   * GraphPersistedState.boundaryOffsets). Only fills in tabs that don't
   * already carry a live offset, so reloading saved state can never undo a
   * move made in this session — the same "existing wins" rule setNodes uses
   * for positions.
   */
  seedBoundaryOffsets: (offsets: Record<string, { x: number; y: number }>) => void;
  /**
   * Tabs whose position was changed by a boundary move since the last call —
   * their current position plus their accumulated anchor offset. The caller
   * persists both: the position through the same per-node state a node drag
   * writes to, the offset so the move survives a reload. Cleared on read.
   */
  takeDisplacedBoundaryMembers: () => {
    id: string;
    x: number;
    y: number;
    offset: { x: number; y: number };
  }[];
};

const ALPHA_MIN = 0.005;
// Tuned together, not independently: CATEGORY_ANCHOR_STRENGTH stays the
// loosest (outermost) pull, SUBCATEGORY_ANCHOR_STRENGTH pulls tighter, and
// COLLECTION_FORCE_STRENGTH sits near the subcategory tier. All three remain
// far below collide(0.9)/link(<=0.5) so they influence layout without ever
// fighting node-overlap or explicit-relationship forces.
//
// Raised 3x from their original 0.02/0.05 (still <= a third of the weakest
// competing force, link's 0.5 floor) after measuring that anchor strength
// alone can only ever partially reduce Category/Subcategory boundary-box
// overlap (see collection-layout.ts's selectNonOverlappingRects for why a
// stronger pull can't fully eliminate it: same-tier clusters sit on a ring
// as angular wedges, and adjacent wedges' axis-aligned bounding boxes
// overlap near the ring's center as a geometry artifact, independent of how
// tightly each wedge's own members are pulled together). This bump still
// buys real, measured separation without approaching collide/link strength.
const COLLECTION_FORCE_STRENGTH = 0.045;
const CATEGORY_ANCHOR_STRENGTH = 0.06;
const SUBCATEGORY_ANCHOR_STRENGTH = 0.12;

// The node body's actual on-screen footprint is a CIRCLE, not a square.
// node-renderer.ts's drawNode() always does
// `beginPath(); arc(x, y, radius, 0, 2*PI)` and then either `clip()` before
// `drawImage(x - radius, y - radius, radius * 2, radius * 2)` (favicon path)
// or `fill()` (no-favicon path) — the favicon image is a `2*radius` square,
// but it's painted through a circular clip, so every pixel outside the
// `radius`-circle is discarded; the fillable path in the other branch *is*
// that same circle. Either way, nothing square ever reaches the screen (see
// node-renderer.test.ts, which asserts `clip()` precedes `drawImage()`, and
// that the clip circle's radius matches `node.radius`). Camera zoom scales
// x/y and radius uniformly (graph-canvas.tsx), so this world-space circle
// stays a circle on screen at every zoom level.
//
// Because the rendered body is a circle, forceCollide's own circular
// collision geometry is exactly the right model — no square-to-circle
// padding (e.g. a sqrt(2)-circumscribed circle) is needed, and adding it
// only inflates the effective spacing well beyond NODE_MIN_EDGE_GAP for no
// visual benefit. Two circles of collision radius `r + GAP/2` never overlap
// (per forceCollide) exactly when their centers are >= `r1 + r2 + GAP`
// apart, which leaves >= GAP of clear space between the *visible* circle
// edges, from any angle — circles are radially symmetric, so there's no
// worst-case direction to guard against as there would be for a square.
export const NODE_MIN_EDGE_GAP = 36;
export function nodeCollisionRadius(radius: number): number {
  return radius + NODE_MIN_EDGE_GAP / 2;
}

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
  anchorOffsetById: () => Map<string, { dx: number; dy: number }>,
  pick: (a: ClusterAnchorAssignment) => { x: number; y: number } | null
): Force<PhysicsNode, PhysicsLink> {
  return ((alpha: number) => {
    const anchors = anchorById();
    const offsets = anchorOffsetById();
    for (const [id, node] of byId) {
      if (node.x === undefined || node.y === undefined) continue;
      const assignment = anchors.get(id);
      const target = assignment ? pick(assignment) : null;
      if (!target) continue;
      const offset = offsets.get(id);
      const targetX = target.x + (offset?.dx ?? 0);
      const targetY = target.y + (offset?.dy ?? 0);
      node.vx = (node.vx ?? 0) + (targetX - node.x) * strength * alpha;
      node.vy = (node.vy ?? 0) + (targetY - node.y) * strength * alpha;
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
  /**
   * How far each tab's cluster anchor (and confinement disc) has been carried
   * by boundary drags, accumulated per tab.
   *
   * Without this, dragging a boundary square would be a tug of war it always
   * loses: computeClusterAnchors places a category's anchor and confinement
   * disc at fixed points, and confineToRegions projects members back inside
   * that disc every tick — so the box would spring straight back the moment
   * the pointer let go. Moving a box moves its members, and its members'
   * territory moves with them.
   *
   * Kept beside the anchors rather than folded into them because the anchor
   * map is replaced wholesale by setClusterAnchors whenever the cluster tree
   * is recomputed; the offsets have to survive that.
   */
  const anchorOffsetById = new Map<string, { dx: number; dy: number }>();
  const getAnchorOffsetById = () => anchorOffsetById;
  const categoryAnchorForce = createClusterAnchorForce(
    CATEGORY_ANCHOR_STRENGTH,
    byId,
    getAnchorById,
    getAnchorOffsetById,
    (a) => a.categoryAnchor
  );
  const subcategoryAnchorForce = createClusterAnchorForce(
    SUBCATEGORY_ANCHOR_STRENGTH,
    byId,
    getAnchorById,
    getAnchorOffsetById,
    (a) => a.subcategoryAnchor
  );

  // Boundary-square layer — see boundary-physics.ts. Stepped from this
  // simulation's own tick() below, so there is exactly one physics loop.
  const boundaryBodies = new Map<string, BoundaryBody>();
  const boundaryPadding = new Map<string, number>();
  let boundarySandbox: Sandbox | null = null;
  let boundaryDrag: (BoundaryDrag & { grabDx: number; grabDy: number }) | null = null;
  const displacedMembers = new Set<string>();

  const simulation: Simulation<PhysicsNode, PhysicsLink> = forceSimulation<PhysicsNode>([])
    .force("charge", forceManyBody().strength(-260).distanceMax(600))
    .force(
      "collide",
      forceCollide<PhysicsNode>()
        .radius((n) => nodeCollisionRadius(n.radius))
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

    // A tab that has left the visible set can't be carried by a boundary any
    // more, so its in-memory offset goes with it rather than accumulating for
    // the life of the session. If it comes back, seedBoundaryOffsets restores
    // it from the persisted record, which is the source of truth.
    for (const id of [...anchorOffsetById.keys()]) if (!byId.has(id)) anchorOffsetById.delete(id);
    for (const id of [...displacedMembers]) if (!byId.has(id)) displacedMembers.delete(id);
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

  /**
   * Keeps every node inside its cluster's reserved region (see
   * cluster-regions.ts), applied AFTER the tick rather than as a force.
   *
   * A force cannot do this job: charge(-260) and collide(0.9) are an order of
   * magnitude stronger than any cluster spring that doesn't also distort the
   * layout, so a spring-based "confinement" only ever reaches ~89% locality
   * even at 4x strength (measured on the real export), while the same geometry
   * with this projection reaches 97%.
   *
   * "Partial pullback": a node outside its region is moved HALF the overshoot
   * back, not pinned to the rim, and only its OUTWARD radial velocity is
   * cancelled — the tangential component survives, so it slides along and
   * settles inward. Pinning to the rim instead makes the boundary behave like
   * a wall that members stack against, which is the rim/crescent artifact.
   * With REGION_DISC_SCALE giving members room to begin with, the measured
   * rim share sits at 30% against a uniformly-filled-disc expectation of 36%,
   * with zero crescent-shaped categories.
   *
   * A node with no region (ring mode, or a tab absent from the anchor map) is
   * untouched, so this is a true no-op whenever confinement isn't in use.
   */
  function confineToRegions() {
    for (const node of byId.values()) {
      const region = anchorById.get(node.id)?.confineTo;
      if (!region || node.x === undefined || node.y === undefined) continue;
      // A pinned node is under the user's finger — never fight a drag.
      if (node.fx !== undefined && node.fx !== null) continue;
      // The region travels with any boundary drag that carried this tab —
      // see anchorOffsetById.
      const offset = anchorOffsetById.get(node.id);
      const dx = node.x - (region.x + (offset?.dx ?? 0));
      const dy = node.y - (region.y + (offset?.dy ?? 0));
      const distance = Math.hypot(dx, dy);
      if (distance <= region.r || distance === 0) continue;
      const ux = dx / distance;
      const uy = dy / distance;
      node.x -= ux * (distance - region.r) * 0.5;
      node.y -= uy * (distance - region.r) * 0.5;
      const radialSpeed = (node.vx ?? 0) * ux + (node.vy ?? 0) * uy;
      if (radialSpeed > 0) {
        node.vx = (node.vx ?? 0) - radialSpeed * ux;
        node.vy = (node.vy ?? 0) - radialSpeed * uy;
      }
    }
  }

  function setBoundaryBodies(specs: { id: string; memberIds: string[]; padding: number }[]) {
    const nextIds = new Set(specs.map((s) => s.id));
    for (const id of [...boundaryBodies.keys()]) {
      if (nextIds.has(id)) continue;
      boundaryBodies.delete(id);
      boundaryPadding.delete(id);
      if (boundaryDrag?.id === id) boundaryDrag = null;
    }
    for (const spec of specs) {
      boundaryPadding.set(spec.id, spec.padding);
      const existing = boundaryBodies.get(spec.id);
      if (existing) {
        // Membership can change under a live body (a tab is recategorized, a
        // filter narrows the graph) — the body itself, and its motion, are
        // deliberately untouched. Bodies are never merged or replaced.
        existing.memberIds = spec.memberIds;
        existing.members = new Set(spec.memberIds);
        continue;
      }
      boundaryBodies.set(spec.id, {
        id: spec.id,
        memberIds: spec.memberIds,
        members: new Set(spec.memberIds),
        x: 0,
        y: 0,
        halfWidth: 0,
        halfHeight: 0,
        vx: 0,
        vy: 0,
        asleep: true,
        dragging: false,
      });
    }
    syncBoundaryBodies();
  }

  /**
   * Re-derives every body's rect from its members' live physics positions —
   * the box IS its members' padded bounding box, exactly as the renderer
   * draws it, so the collider and the visible square can never disagree.
   * A body whose members have no positions yet keeps its previous rect.
   */
  function syncBoundaryBodies() {
    for (const body of boundaryBodies.values()) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of body.memberIds) {
        const node = byId.get(id);
        if (!node || node.x === undefined || node.y === undefined) continue;
        minX = Math.min(minX, node.x - node.radius);
        maxX = Math.max(maxX, node.x + node.radius);
        minY = Math.min(minY, node.y - node.radius);
        maxY = Math.max(maxY, node.y + node.radius);
      }
      if (minX === Infinity) continue;
      const padding = boundaryPadding.get(body.id) ?? 0;
      body.x = (minX + maxX) / 2;
      body.y = (minY + maxY) / 2;
      body.halfWidth = (maxX - minX) / 2 + padding;
      body.halfHeight = (maxY - minY) / 2 + padding;
    }
  }

  /**
   * Moves a boundary's tabs — and the cluster territory holding them — by the
   * same rigid delta the box itself moved. This is what makes a boundary drag
   * a real change to the graph's own node positions rather than a floating
   * rectangle drawn somewhere else.
   */
  function translateBoundaryMembers(memberIds: string[], dx: number, dy: number) {
    for (const id of memberIds) {
      const node = byId.get(id);
      if (!node) continue;
      if (node.x !== undefined) node.x += dx;
      if (node.y !== undefined) node.y += dy;
      if (node.fx !== undefined && node.fx !== null) node.fx += dx;
      if (node.fy !== undefined && node.fy !== null) node.fy += dy;
      const offset = anchorOffsetById.get(id);
      if (offset) {
        offset.dx += dx;
        offset.dy += dy;
      } else {
        anchorOffsetById.set(id, { dx, dy });
      }
      displacedMembers.add(id);
    }
  }

  function stepBoundaryLayer() {
    if (boundaryBodies.size === 0) return;
    syncBoundaryBodies();
    const bodies = [...boundaryBodies.values()];
    if (!boundaryDrag && bodies.every((b) => b.asleep)) return;

    const drag = boundaryDrag
      ? {
          id: boundaryDrag.id,
          targetX: boundaryDrag.targetX + boundaryDrag.grabDx,
          targetY: boundaryDrag.targetY + boundaryDrag.grabDy,
        }
      : null;
    const deltas = stepBoundaryBodies(bodies, boundarySandbox, drag);
    for (const [id, delta] of deltas) {
      const body = boundaryBodies.get(id);
      if (!body) continue;
      translateBoundaryMembers(body.memberIds, delta.dx, delta.dy);
    }
  }

  return {
    tick: () => {
      if (simulation.alpha() > simulation.alphaMin()) {
        simulation.tick();
        confineToRegions();
      }
      // Always stepped, even once the node layout has cooled: a boundary drag
      // is direct manipulation and shouldn't depend on alpha. A no-op when
      // every body is asleep and nothing is being dragged.
      stepBoundaryLayer();
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

    setBoundaryBodies,
    setBoundarySandbox: (sandbox) => {
      boundarySandbox = sandbox;
    },
    beginBoundaryDrag: (id, x, y) => {
      const body = boundaryBodies.get(id);
      if (!body) return false;
      body.asleep = false;
      body.vx = 0;
      body.vy = 0;
      // Grab offset, so the box keeps its position relative to the pointer
      // instead of snapping its centre under the cursor.
      boundaryDrag = { id, targetX: x, targetY: y, grabDx: body.x - x, grabDy: body.y - y };
      return true;
    },
    moveBoundaryDrag: (x, y) => {
      if (!boundaryDrag) return;
      boundaryDrag.targetX = x;
      boundaryDrag.targetY = y;
    },
    endBoundaryDrag: () => {
      if (!boundaryDrag) return;
      const body = boundaryBodies.get(boundaryDrag.id);
      boundaryDrag = null;
      if (!body) return;
      const { vx, vy } = releaseVelocity(body);
      body.dragging = false;
      body.vx = vx;
      body.vy = vy;
      body.asleep = false;
    },
    getBoundaryBody: (id) => boundaryBodies.get(id),
    isBoundaryLayerSettled: () => !boundaryDrag && [...boundaryBodies.values()].every((b) => b.asleep),
    seedBoundaryOffsets: (offsets) => {
      for (const [id, offset] of Object.entries(offsets)) {
        if (anchorOffsetById.has(id)) continue;
        anchorOffsetById.set(id, { dx: offset.x, dy: offset.y });
      }
    },
    takeDisplacedBoundaryMembers: () => {
      const moved: { id: string; x: number; y: number; offset: { x: number; y: number } }[] = [];
      for (const id of displacedMembers) {
        const node = byId.get(id);
        if (node?.x === undefined || node?.y === undefined) continue;
        const offset = anchorOffsetById.get(id);
        moved.push({ id, x: node.x, y: node.y, offset: { x: offset?.dx ?? 0, y: offset?.dy ?? 0 } });
      }
      displacedMembers.clear();
      return moved;
    },
  };
}
