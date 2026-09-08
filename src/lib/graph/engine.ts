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
import { MAX_GRAPH_COORD, type GraphEdge, type GraphNode } from "./types";
import type { ClusterAnchorAssignment } from "./clusters";
import { clampNodeRadius } from "./node-size";
import {
  adoptPersistedOffsets,
  buildBoundaryFrames,
  clampFramesWithinParents,
  emptyBoundaryFrames,
  rigidMove,
  translateFrames,
  type BoundaryFrames,
  type FrameOffset,
} from "./boundary-frames";
import {
  BOUNDARY_SLEEP_SPEED,
  releaseVelocity,
  sanitizeBody,
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
   * renderer passes its live boundary set, which is also exactly what it
   * draws and hit-tests, so what is grabbable is always what is visible.
   * Bodies already present keep their velocity/sleep state (and the
   * in-progress drag), new ids get a fresh resting body, and ids no longer
   * present are dropped.
   *
   * A body has no position of its own: its rect is re-derived from
   * `memberIds`' live physics positions on every tick, padded by `padding`
   * world units.
   *
   * Which ids are present must be a function of which clusters EXIST, never
   * of where they currently are: this call is what creates and destroys
   * bodies, so anything transient feeding it (an overlap test, a zoom level)
   * turns a collision or a camera change into a destroyed body. See
   * collection-layout.ts's `resolveLiveBoundaries`, which is what the
   * renderer passes through before calling this.
   */
  setBoundaryBodies: (specs: { id: string; memberIds: string[]; padding: number }[]) => void;
  /**
   * Overrides the world-space rect boundary bodies are kept inside. `null`
   * restores the automatic sandbox (see `worldSandbox` in the implementation)
   * — which is derived from the graph's own extent and is deliberately
   * independent of the camera, so zooming or panning never moves the walls
   * and therefore never shoves a square around.
   */
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
   * GraphPersistedState.boundaryOffsets). Only fills in TERRITORIES that
   * haven't already been moved this session, so reloading saved state can
   * never undo a move made in this one — the same "existing wins" rule
   * setNodes uses for positions.
   *
   * Saved offsets are per tab but a territory is what actually moves, so they
   * are folded into whole-disc offsets on the way in. That is also what heals
   * a workspace saved by a build that displaced tabs individually: its tabs
   * come back on one disc rather than held apart across the reload. See
   * boundary-frames.ts's adoptPersistedOffsets.
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
  /** Every present tab's current territory offset — the per-tab view the graph persists. Non-destructive. */
  getBoundaryOffsets: () => Record<string, { x: number; y: number }>;
  /**
   * The repaired offsets for tabs whose SAVED displacement disagreed with the
   * rest of their territory, or null when the saved state was already
   * coherent. Cleared on read.
   *
   * This is what lets a workspace carrying the old per-tab corruption be
   * written back healed instead of being repaired from scratch on every load
   * forever. Only the tabs actually normalized are reported, so the caller
   * merges rather than replaces — tabs filtered out of the current view still
   * exist and must keep the offsets they have.
   */
  takeNormalizedBoundaryOffsets: () => Record<string, { x: number; y: number }> | null;
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
// overlap (a stronger pull can't fully eliminate it: same-tier clusters sit on a ring
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
 * Floor on the half-side of the automatic boundary sandbox, and how much
 * clear world beyond the outermost node it always leaves. Generous on
 * purpose: the walls are there so nothing can be launched irrecoverably far
 * away, not to fence in ordinary dragging — a user pushing a square around
 * their own layout should essentially never feel them.
 */
const MIN_SANDBOX_HALF_SIZE = 4000;
const SANDBOX_CONTENT_MARGIN = 1200;

/** Hard ceiling on |x|,|y| for a node — the world's own, shared with the boundary layer and with persistence. */
const MAX_NODE_COORD = MAX_GRAPH_COORD;

/**
 * How far a repaired offset must sit from the saved one before the saved
 * record counts as needing rewriting. Sub-pixel: a difference this small is
 * float noise from the consensus mean, not a territory in the wrong place,
 * and rewriting on it would make the migration write on every single load.
 */
const OFFSET_NORMALIZATION_EPSILON = 0.5;

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
   * by boundary drags.
   *
   * Without this, dragging a boundary square would be a tug of war it always
   * loses: computeClusterAnchors places a category's anchor and confinement
   * disc at fixed points, and confineToRegions projects members back inside
   * that disc every tick — so the box would spring straight back the moment
   * the pointer let go. Moving a box moves its members, and its members'
   * territory moves with them.
   *
   * DERIVED, not authoritative: the offset belongs to the tab's TERRITORY
   * (see boundary-frames.ts), and this map is only that territory's offset
   * copied onto each of its tabs, refreshed by syncTabOffsetsFromFrames.
   * Writing it per tab is what let one boundary square carry part of a
   * cluster away from the rest and stretch the cluster's box across the gap;
   * every tab on one disc now moves together or not at all. It stays a
   * per-tab map because that is what the forces read per node and what the
   * graph persists (GraphPersistedState.boundaryOffsets).
   */
  const anchorOffsetById = new Map<string, { dx: number; dy: number }>();
  const getAnchorOffsetById = () => anchorOffsetById;
  /** The territories themselves — the authority behind anchorOffsetById. */
  let frames: BoundaryFrames = emptyBoundaryFrames();
  /** Saved per-tab offsets waiting for a cluster tree to fold them into frames. */
  const pendingSeededOffsets = new Map<string, FrameOffset>();
  /**
   * Offsets for tabs the layout reserved no ground for — no confinement disc,
   * so no territory and nothing they could be torn away from. They keep the
   * per-tab accumulation frames replaced, because for them it is the same
   * thing: a tab on its own is a territory of one. Folded into a real frame
   * the moment one appears for them (see rebuildFrames).
   */
  const untetheredOffsetById = new Map<string, FrameOffset>();
  /** Tabs whose saved offset was repaired on the way in — see takeNormalizedBoundaryOffsets. */
  const normalizedOffsets = new Map<string, FrameOffset>();
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
  /** Set by setBoundarySandbox; `null` means "use the automatic one". */
  let boundarySandboxOverride: Sandbox | null = null;
  /**
   * Half-side of the automatic, camera-independent sandbox — a square
   * centred on the world origin, which is where the layout itself is centred
   * (forceCenter/forceX/forceY all pull to 0,0).
   *
   * It must NOT be the visible viewport. Using the viewport made the walls
   * move with the camera, so zooming in squeezed every square toward the
   * middle of the world — a camera change silently rewriting physics
   * positions, and with them the tab positions the graph persists. It only
   * ever grows within a session, so a square can never be crushed by the
   * world shrinking around it either.
   */
  let sandboxHalfSize = MIN_SANDBOX_HALF_SIZE;
  let boundaryDrag: (BoundaryDrag & { grabDx: number; grabDy: number }) | null = null;
  const displacedMembers = new Set<string>();
  /**
   * Last known-good position per node, for `sanitizeNodes`. A node whose
   * coordinates go non-finite is restored here rather than left as NaN —
   * NaN x/y is a node that renders nowhere, hit-tests nowhere, and poisons
   * the bounding box of every boundary square that contains it.
   */
  const lastGoodNodePosition = new Map<string, { x: number; y: number }>();

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
        existing.radius = clampNodeRadius(radiusOf(node));
        return existing;
      }
      const saved = initialPositions[node.id];
      const radius = clampNodeRadius(radiusOf(node));
      if (saved) return { id: node.id, radius, x: saved.x, y: saved.y };

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
        radius,
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
    for (const id of [...displacedMembers]) if (!byId.has(id)) displacedMembers.delete(id);
    for (const id of [...lastGoodNodePosition.keys()]) if (!byId.has(id)) lastGoodNodePosition.delete(id);
    rebuildFrames();
    sanitizeNodes();
  }

  /**
   * Re-derives the territories from the current anchors and node set, then
   * restores the invariants that hold over them: every tab on a disc shares
   * that disc's offset, and no nested disc has been carried outside its
   * parent's.
   *
   * Called whenever either input changes (setNodes, setClusterAnchors) — the
   * cluster tree is rebuilt on every tab/filter change, and the offsets have
   * to survive that, which is what buildBoundaryFrames' `previous` argument
   * carries over.
   */
  function rebuildFrames() {
    frames = buildBoundaryFrames(anchorById, byId.keys(), frames);

    // Both sources of per-tab displacement — what a past session saved, and
    // what an untethered tab accumulated before it had any ground — become
    // whole-frame offsets as soon as there is a frame to hold them.
    const perTabSeeds = new Map(pendingSeededOffsets);
    for (const [id, offset] of untetheredOffsetById) if (!perTabSeeds.has(id)) perTabSeeds.set(id, offset);
    if (perTabSeeds.size > 0) adoptPersistedOffsets(frames, perTabSeeds);
    for (const id of [...untetheredOffsetById.keys()]) {
      if (frames.frameOfTab.has(id) || !byId.has(id)) untetheredOffsetById.delete(id);
    }

    clampFramesWithinParents(frames);
    syncTabOffsetsFromFrames();
    recordOffsetNormalization();
  }

  /**
   * Notes every tab whose SAVED offset disagrees with the territory it turned
   * out to belong to, so the caller can write the repaired value back instead
   * of repairing the same corruption on every load for the life of the
   * workspace. A coherent saved state produces nothing.
   */
  function recordOffsetNormalization() {
    for (const [id, saved] of pendingSeededOffsets) {
      const resolved = anchorOffsetById.get(id);
      // Not in the graph right now (filtered out, or gone): its saved offset
      // is not ours to rewrite — we have no territory to check it against.
      if (!resolved) continue;
      if (
        Math.abs(resolved.dx - saved.dx) <= OFFSET_NORMALIZATION_EPSILON &&
        Math.abs(resolved.dy - saved.dy) <= OFFSET_NORMALIZATION_EPSILON
      ) {
        continue;
      }
      normalizedOffsets.set(id, { dx: resolved.dx, dy: resolved.dy });
    }
  }

  /** Copies each territory's offset onto its tabs — the per-tab view the forces and persistence read. */
  function syncTabOffsetsFromFrames() {
    anchorOffsetById.clear();
    for (const frame of frames.byId.values()) {
      for (const tabId of frame.allTabs) {
        if (!byId.has(tabId)) continue;
        anchorOffsetById.set(tabId, { dx: frame.offset.dx, dy: frame.offset.dy });
      }
    }
    for (const [tabId, offset] of untetheredOffsetById) {
      if (byId.has(tabId)) anchorOffsetById.set(tabId, { dx: offset.dx, dy: offset.dy });
    }
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
    rebuildFrames();
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
    // Which of the offered squares can be a RIGID BODY at all.
    //
    // A body's only power is to translate its members, and translating a set
    // of tabs is only meaningful when that set is whole ground: every
    // territory it touches, it holds all of (see boundary-frames.ts). A
    // square whose members are a slice of somebody else's cluster — the
    // ordinary shape of a Collection, which cuts across categories by design
    // — cannot move without leaving the rest of that cluster behind, and the
    // abandoned cluster's boundary box then stretches across the gap. That
    // is the stretched-square bug, and this is where it is refused.
    //
    // Refused means "not simulated", NOT "not there": the square is still
    // drawn, still hit-tested and still selectable (graph-canvas.tsx builds
    // those from the live boundary set, not from the bodies). It simply
    // cannot be shoved around, because there is no way to shove it that
    // leaves the graph's clusters intact.
    const admitted = specs.filter((spec) => rigidMove(frames, new Set(spec.memberIds)).ok);

    const nextIds = new Set(admitted.map((s) => s.id));
    for (const id of [...boundaryBodies.keys()]) {
      if (nextIds.has(id)) continue;
      boundaryBodies.delete(id);
      boundaryPadding.delete(id);
      if (boundaryDrag?.id === id) boundaryDrag = null;
    }
    for (const spec of admitted) {
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
        // Born AWAKE, with zero velocity — not resting.
        //
        // A new body's rect is simply wherever its members' bounding box
        // already is, so it can be overlapping a neighbour from its very
        // first frame; and since the renderer stopped hiding overlapping
        // boxes (collection-layout.ts's resolveLiveBoundaries), nothing else
        // resolves that any more. Asleep, it never would: resolveOverlaps
        // skips a pair only when BOTH bodies are asleep, and stepBoundaryLayer
        // skips the whole layer when every body is, so a box born inside
        // another one stayed there indefinitely — 3 unrelated pairs left
        // overlapping on the real 283-tab export, one of them by 83% of the
        // smaller box.
        //
        // This is not "sleeping disabled": with no velocity and nothing to
        // push against, a body goes back to sleep on its very next step (see
        // stepBoundaryBodies' settle pass — zero speed and zero movement is
        // below BOUNDARY_SLEEP_SPEED on both counts). The bodies that stay
        // awake are exactly the ones genuinely overlapping a peer, and only
        // until they have separated. Nesting is unaffected: two boxes sharing
        // a member are filtered out before either is woken.
        asleep: false,
        dragging: false,
        lastGoodX: 0,
        lastGoodY: 0,
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
        // Number.isFinite, not just `!== undefined`: one NaN member position
        // would otherwise make every extreme NaN, hand the body a NaN centre,
        // and from there NaN out every other member through the next
        // translate. sanitizeNodes below keeps that from arising at all; this
        // is the second line of defence, on the path that would spread it.
        if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
        const radius = Number.isFinite(node.radius) ? node.radius : 0;
        minX = Math.min(minX, node.x! - radius);
        maxX = Math.max(maxX, node.x! + radius);
        minY = Math.min(minY, node.y! - radius);
        maxY = Math.max(maxY, node.y! + radius);
      }
      // No usable member position: the body keeps the rect it already had
      // rather than collapsing. It stays in the world either way.
      if (minX === Infinity) continue;
      const padding = boundaryPadding.get(body.id) ?? 0;
      const x = (minX + maxX) / 2;
      const y = (minY + maxY) / 2;
      const halfWidth = (maxX - minX) / 2 + padding;
      const halfHeight = (maxY - minY) / 2 + padding;

      // A sleeping body whose SHAPE just changed is no longer a body at rest
      // in a known-good configuration — its members moved under the node
      // forces, so whatever it was or wasn't touching is now stale. Waking it
      // is what gets that re-tested: resolveOverlaps skips a pair only when
      // both bodies are asleep, so without this, two boxes that drift into
      // each other after settling stay overlapped forever, exactly as a box
      // born overlapping used to.
      //
      // This does not make the layer busy. The rects of a settled graph are
      // bit-stable (once alpha falls below alphaMin the node simulation stops
      // advancing at all), so nothing changes, nothing wakes, and an
      // untouched layout stays completely inert — the property the sleeping
      // was there for. While the layout IS converging the rects genuinely do
      // change every tick, which is precisely when the boxes should be
      // colliding rather than sitting inert on top of one another.
      if (
        body.asleep &&
        (Math.abs(x - body.x) > BOUNDARY_SLEEP_SPEED ||
          Math.abs(y - body.y) > BOUNDARY_SLEEP_SPEED ||
          Math.abs(halfWidth - body.halfWidth) > BOUNDARY_SLEEP_SPEED ||
          Math.abs(halfHeight - body.halfHeight) > BOUNDARY_SLEEP_SPEED)
      ) {
        body.asleep = false;
      }

      body.x = x;
      body.y = y;
      body.halfWidth = halfWidth;
      body.halfHeight = halfHeight;
      sanitizeBody(body);
    }
  }

  /**
   * Repairs any node whose position or velocity has gone non-finite or
   * absurd, restoring the last position it was known to be at.
   *
   * d3-force is arithmetic over floats with no guard of its own: a single
   * degenerate input (two nodes at exactly the same point, a zero-length
   * link, an NaN radius) can put NaN into one node and every force then
   * spreads it. A node at NaN is invisible, unclickable and unrecoverable,
   * and it drags the boundary square containing it down with it — so this
   * runs every tick and costs one pass over the nodes.
   */
  function sanitizeNodes() {
    for (const node of byId.values()) {
      const bad =
        !Number.isFinite(node.x) ||
        !Number.isFinite(node.y) ||
        Math.abs(node.x!) > MAX_NODE_COORD ||
        Math.abs(node.y!) > MAX_NODE_COORD;
      if (bad) {
        const good = lastGoodNodePosition.get(node.id);
        node.x = good?.x ?? 0;
        node.y = good?.y ?? 0;
        node.vx = 0;
        node.vy = 0;
        if (node.fx !== undefined && node.fx !== null && !Number.isFinite(node.fx)) node.fx = node.x;
        if (node.fy !== undefined && node.fy !== null && !Number.isFinite(node.fy)) node.fy = node.y;
      } else {
        const good = lastGoodNodePosition.get(node.id);
        if (good) {
          good.x = node.x!;
          good.y = node.y!;
        } else {
          lastGoodNodePosition.set(node.id, { x: node.x!, y: node.y! });
        }
      }
      if (!Number.isFinite(node.vx)) node.vx = 0;
      if (!Number.isFinite(node.vy)) node.vy = 0;
    }
  }

  /**
   * The world-space walls, recomputed from the graph's own extent — never
   * from the camera. Grows to fit the content (plus a wide margin) and never
   * shrinks within a session, so the walls are a fixed feature of the world
   * a square is being dragged around in rather than something the user can
   * move by scrolling.
   */
  function worldSandbox(): Sandbox {
    if (boundarySandboxOverride) return boundarySandboxOverride;
    let reach = MIN_SANDBOX_HALF_SIZE;
    for (const node of byId.values()) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      const radius = Number.isFinite(node.radius) ? node.radius : 0;
      reach = Math.max(reach, Math.abs(node.x!) + radius + SANDBOX_CONTENT_MARGIN);
      reach = Math.max(reach, Math.abs(node.y!) + radius + SANDBOX_CONTENT_MARGIN);
    }
    // Monotonic: content that later contracts must not pull the walls in
    // over a square that has been parked out near where they were.
    sandboxHalfSize = Math.min(MAX_NODE_COORD, Math.max(sandboxHalfSize, reach));
    return {
      minX: -sandboxHalfSize,
      minY: -sandboxHalfSize,
      maxX: sandboxHalfSize,
      maxY: sandboxHalfSize,
    };
  }

  /**
   * Moves a boundary's tabs — and the cluster territories holding them — by
   * the same rigid delta the box itself moved. This is what makes a boundary
   * drag a real change to the graph's own node positions rather than a
   * floating rectangle drawn somewhere else.
   *
   * The territories move as WHOLE discs (setBoundaryBodies only admits a body
   * that covers whole ones), and the nested ones are clamped back inside their
   * parents afterwards — so however far a square is dragged or shoved, every
   * tab that shares a disc stays on it, and no cluster's bounding box can
   * stretch past the disc its members are confined to.
   */
  function translateBoundaryMembers(body: BoundaryBody, dx: number, dy: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

    // Ground moves first, tabs follow it. Doing it in that order is what
    // makes the containment clamp real rather than cosmetic: a subcategory
    // pushed against the edge of its own category's disc has its offset
    // pulled back, and the members then move by the SHORTENED delta, so the
    // square stops at the edge instead of dragging its tabs out and letting
    // confineToRegions haul them back over the following frames.
    //
    // The covered territories are re-derived here rather than reused from
    // setBoundaryBodies: what a square covers is a fact about the CURRENT
    // cluster tree, and the tree can be replaced (a tab recategorized, a
    // filter changed) between the call that admitted the body and this tick.
    const frameIds = rigidMove(frames, body.members).frameIds;
    const before = new Map(frameIds.map((id) => [id, { ...frames.byId.get(id)!.offset }]));
    translateFrames(frames, frameIds, dx, dy);
    clampFramesWithinParents(frames);
    const applied = new Map<string, FrameOffset>();
    for (const id of frameIds) {
      const frame = frames.byId.get(id);
      const start = before.get(id);
      if (!frame || !start) continue;
      applied.set(id, { dx: frame.offset.dx - start.dx, dy: frame.offset.dy - start.dy });
    }

    for (const id of body.memberIds) {
      const node = byId.get(id);
      if (!node) continue;
      const frameId = frames.frameOfTab.get(id);
      // A tab whose disc did not move must not move either — that separation
      // is exactly the tear this whole mechanism exists to prevent. An
      // untethered tab has no disc, so it simply takes the raw delta.
      const delta = frameId === undefined ? { dx, dy } : (applied.get(frameId) ?? { dx: 0, dy: 0 });
      if (delta.dx === 0 && delta.dy === 0) continue;
      if (node.x !== undefined) node.x += delta.dx;
      if (node.y !== undefined) node.y += delta.dy;
      if (node.fx !== undefined && node.fx !== null) node.fx += delta.dx;
      if (node.fy !== undefined && node.fy !== null) node.fy += delta.dy;
      displacedMembers.add(id);
      if (frameId !== undefined) continue;
      const own = untetheredOffsetById.get(id);
      if (own) {
        own.dx += delta.dx;
        own.dy += delta.dy;
      } else {
        untetheredOffsetById.set(id, { dx: delta.dx, dy: delta.dy });
      }
    }

    syncTabOffsetsFromFrames();
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
    const deltas = stepBoundaryBodies(bodies, worldSandbox(), drag);
    for (const [id, delta] of deltas) {
      const body = boundaryBodies.get(id);
      if (!body) continue;
      translateBoundaryMembers(body, delta.dx, delta.dy);
    }
  }

  return {
    tick: () => {
      if (simulation.alpha() > simulation.alphaMin()) {
        simulation.tick();
        sanitizeNodes();
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
      boundarySandboxOverride = sandbox;
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
      // Saved offsets are per tab; territories are what actually move. They
      // are held here until a cluster tree arrives (setClusterAnchors runs
      // after this in graph-canvas.tsx's physics effect) and then folded into
      // whole-frame offsets — which also heals state saved by a build that
      // displaced tabs individually. See adoptPersistedOffsets.
      for (const [id, offset] of Object.entries(offsets)) {
        if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) continue;
        pendingSeededOffsets.set(id, { dx: offset.x, dy: offset.y });
      }
      rebuildFrames();
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
    getBoundaryOffsets: () => {
      const out: Record<string, { x: number; y: number }> = {};
      for (const [id, offset] of anchorOffsetById) out[id] = { x: offset.dx, y: offset.dy };
      return out;
    },
    takeNormalizedBoundaryOffsets: () => {
      if (normalizedOffsets.size === 0) return null;
      const out: Record<string, { x: number; y: number }> = {};
      for (const [id, offset] of normalizedOffsets) out[id] = { x: offset.dx, y: offset.dy };
      normalizedOffsets.clear();
      return out;
    },
  };
}
