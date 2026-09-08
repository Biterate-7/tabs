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
import { buildBulkSeeds, type SeedRegion } from "./bulk-layout";
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
    /**
     * Optional seed region for a brand-new node (no saved position): its
     * cluster's territory, so it appears where its cluster already is
     * instead of having to physically migrate there.
     *
     * Nodes sharing a region are seeded TOGETHER, packed across it at
     * collide spacing rather than jittered individually — see
     * bulk-layout.ts for why individual jitter is what made a bulk dump
     * explode.
     */
    anchorFallback?: (node: GraphNode) => SeedRegion | undefined
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

  /**
   * How many brand-new nodes the last `setNodes` had to seed from scratch —
   * i.e. how big an arrival this was. The renderer uses it to decide whether
   * to run `settleBulk` before painting; see BULK_ARRIVAL_THRESHOLD.
   */
  lastArrivalCount: () => number;
  /** True while the simulation is still inside the post-bulk-arrival settling window (tighter speed cap, heavier damping). */
  isBulkSettling: () => boolean;
  /**
   * Runs up to `maxTicks` ticks immediately, stopping early once the layout
   * settles or `budgetMs` of wall clock is used up.
   *
   * This is the "controlled transition" half of a bulk dump: the deterministic
   * seeding (see bulk-layout.ts) removes the explosion, and this removes the
   * long visible crawl afterwards by spending one bounded, interruptible
   * chunk of time before the first frame is painted rather than animating
   * several hundred frames of coarse rearrangement the user has no reason to
   * watch. Returns how many ticks it actually ran.
   */
  settleBulk: (maxTicks: number, budgetMs: number) => number;
  /**
   * A node that must be left out of every boundary square's geometry — the
   * one currently under the pointer.
   *
   * A boundary box IS the bounding box of its members (see
   * syncBoundaryBodies), so dragging one member 800px away stretches its
   * group's box by 800px, and the box's collider along with it: one tab
   * being dragged visibly resizes and shoves its whole neighbourhood.
   * Excluding the dragged node makes the box's geometry depend only on the
   * members that are actually at rest, which is what keeps a group
   * geometrically stable during a drag. On release the node is re-included,
   * by which point confineToRegions has it back inside its own region.
   */
  setBoundaryExcluded: (id: string | null) => void;
  getBoundaryExcluded: () => string | null;
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
 * Whether the pointer is holding this node at a fixed point — d3's `fx`/`fy`,
 * which only `pin`/`unpin` below ever set, i.e. exactly "a tab is being
 * dragged".
 *
 * Such a node's position is an INPUT to the simulation, not an output: d3
 * writes `x = fx` on every tick, and the drag handler rewrites `fx` on every
 * pointermove. Anything that would otherwise move a node has to leave these
 * alone — the layout forces do (via d3), `confineToRegions` does, and so does
 * the boundary layer (see `translateBoundaryMembers` and
 * `syncBoundaryBodies`), because a "rigid" translation that a member silently
 * refuses is a deformation.
 */
function isPointerHeld(node: PhysicsNode): boolean {
  return (node.fx !== undefined && node.fx !== null) || (node.fy !== undefined && node.fy !== null);
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

/** Hard ceiling on |x|,|y| for a node, mirroring boundary-physics's BOUNDARY_MAX_COORD. */
const MAX_NODE_COORD = 1e7;

/**
 * Ceiling on a node's speed, in world units per tick, enforced INSIDE the
 * simulation (see `createSpeedLimitForce`) rather than by clamping positions
 * after the fact.
 *
 * This is the difference between a bounded simulation and a bounded picture.
 * d3-force integrates `x += vx *= velocityDecay` with no bound of any kind, so
 * one near-coincident pair under charge(-260), or one link stretched across
 * the graph, produces an unbounded impulse that the next tick then carries
 * forward. Clamping the RESULT would leave that velocity in the node, so the
 * node would strain against the clamp every frame and shoot away the instant
 * anything moved. Clamping the VELOCITY, before integration, means the
 * excess energy never enters the system: it bounds this frame's displacement
 * AND the next frame's starting condition.
 *
 * 18 is chosen against what legitimate motion actually needs: a settling
 * layout's fastest honest node moves ~10 units/tick right after a reheat and
 * under 4 within a dozen ticks (measured on the real 283-tab export), so this
 * never touches ordinary settling. What it does bound is the pathological
 * case, which was measured at 161 units/tick on the first frame of a cold
 * bulk insert — a node crossing a third of the graph between two frames.
 */
export const MAX_NODE_SPEED = 18;

/**
 * The speed cap while a bulk arrival is still settling. Tighter, because
 * that is exactly the window in which hundreds of nodes are simultaneously
 * resolving overlaps and the sum of their reactions is what reads as chaos.
 */
export const BULK_MAX_NODE_SPEED = 7;

/**
 * How many brand-new nodes at once counts as a "bulk arrival" — a dump or an
 * import, as opposed to a tab or two being added by hand.
 */
export const BULK_ARRIVAL_THRESHOLD = 24;

/** Ticks the tighter bulk regime stays in force after such an arrival. */
const BULK_SETTLE_TICKS = 240;

/**
 * Base link strength, before d3's own degree normalisation.
 *
 * The link force used to be a FLAT `edgeStrength * 0.5` for every link. d3's
 * own default is `1 / min(degree(source), degree(target))` precisely because
 * a flat strength is unstable on any graph with hubs: a node with 20 links
 * accumulates 20 springs each pulling at full strength, so its acceleration
 * scales with its degree and the layout tears it between its neighbours.
 * TabDump's graphs are exactly that shape — chained domain/workspace/category
 * groups all meeting at popular tabs. Normalising by degree makes a hub's
 * total link pull comparable to a leaf's, which is what stops high-degree
 * nodes from being the ones that fly.
 *
 * This is therefore also the CEILING on any single link's strength: the
 * divisor is at least 1 and the user's edge-strength multiplier at most 1, so
 * no link can ever pull harder than this — comfortably below collide's 0.9,
 * which is what keeps a spring from being able to drag nodes through each
 * other.
 */
const LINK_BASE_STRENGTH = 0.55;

/** Rest length of a link. */
const LINK_DISTANCE = 100;

/**
 * Per-tick velocity DECAY, in d3's sense: a node keeps `1 - decay` of its
 * speed each tick. Raised from 0.32 — which kept 68% per tick, i.e. LESS
 * damping than d3-force's own 0.4 default — to 0.55, keeping 45%.
 *
 * A node's total coasting distance after an impulse is
 * `step / (1 - retention)`: at 68% retention a nudge travels ~3.1x its
 * per-frame step before stopping, at 45% it travels ~1.8x. That is the
 * difference between a graph that keeps drifting long after anything caused
 * it to and one that settles. Deliberately not higher: over-damping makes the
 * layout crawl into place rather than move to it, which reads as sluggish
 * rather than calm.
 */
const VELOCITY_DECAY = 0.55;

/**
 * Heavier still (keeping 28%) while a bulk arrival settles — hundreds of
 * simultaneous overlap resolutions should be absorbed rather than rung.
 * Restored to VELOCITY_DECAY as soon as the bulk window closes, so ordinary
 * interaction never inherits the stiffer feel.
 */
const BULK_VELOCITY_DECAY = 0.72;

/**
 * Bounds every node's speed, as a force registered LAST so it runs after
 * every other force has contributed and before d3 integrates — see
 * MAX_NODE_SPEED. Scales the velocity vector rather than clamping each axis
 * independently, so a capped node keeps travelling in the direction the
 * forces actually pointed it.
 */
function createSpeedLimitForce(
  byId: Map<string, PhysicsNode>,
  limitOf: () => number
): Force<PhysicsNode, PhysicsLink> {
  return (() => {
    const limit = limitOf();
    for (const node of byId.values()) {
      const vx = Number.isFinite(node.vx) ? node.vx! : 0;
      const vy = Number.isFinite(node.vy) ? node.vy! : 0;
      const speed = Math.hypot(vx, vy);
      if (speed <= limit) {
        node.vx = vx;
        node.vy = vy;
        continue;
      }
      const scale = limit / speed;
      node.vx = vx * scale;
      node.vy = vy * scale;
    }
  }) as Force<PhysicsNode, PhysicsLink>;
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

  /**
   * Ticks left in the tighter post-bulk-arrival regime. Counted down by
   * tick(), reset by a bulk arrival in setNodes.
   */
  let bulkSettleTicks = 0;
  /** Newcomers seeded by the most recent setNodes call. */
  let arrivalCount = 0;
  /** See setBoundaryExcluded — the node under the pointer, left out of boundary geometry. */
  let boundaryExcludedId: string | null = null;
  /**
   * Set once the layout has settled, so the one-off "park the residual
   * velocity" pass runs exactly once per settle rather than every frame.
   *
   * It matters because d3 stops advancing the moment alpha falls below
   * alphaMin, mid-motion — measured on the real export, the fastest node was
   * still carrying 10 units/tick at that point. That stored momentum sits in
   * the node until something reheats the simulation and then discharges in a
   * single frame, which is why the graph used to lurch when you touched it
   * after it had apparently come to rest.
   */
  let parkedAtSettle = false;

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
    // Registered here, empty, purely to reserve its slot in the force map.
    // d3 runs forces in insertion order and a `.force(name, f)` on an
    // existing name replaces in place, so setEdges() below can swap the real
    // link force in without ever landing AFTER the speed limiter.
    .force("link", forceLink<PhysicsNode, PhysicsLink>([]).id((n) => n.id))
    // LAST on purpose: every other force has had its say by the time this
    // runs, and d3 integrates immediately after the last force. See
    // createSpeedLimitForce.
    .force("limit", createSpeedLimitForce(byId, () => (bulkSettleTicks > 0 ? BULK_MAX_NODE_SPEED : MAX_NODE_SPEED)))
    .alphaMin(ALPHA_MIN)
    .alphaDecay(0.025)
    .velocityDecay(VELOCITY_DECAY)
    .stop();

  function setNodes(
    nodes: GraphNode[],
    radiusOf: (node: GraphNode) => number,
    initialPositions: Record<string, { x: number; y: number }>,
    anchorFallback?: (node: GraphNode) => SeedRegion | undefined
  ) {
    // PHASE 1 — INSERTION. Work out which nodes are genuinely new (no live
    // physics node, no saved position) before placing anything, so the whole
    // arrival can be laid out as one set rather than one node at a time. A
    // node placed without knowing about its 200 siblings is exactly how they
    // all end up stacked on the same point.
    const arrivals: { node: GraphNode; region: SeedRegion | undefined }[] = [];
    for (const node of nodes) {
      if (byId.has(node.id) || initialPositions[node.id]) continue;
      arrivals.push({ node, region: anchorFallback?.(node) });
    }
    arrivalCount = arrivals.length;

    // PHASE 2 — INITIAL LAYOUT. Every arrival that shares a cluster territory
    // is packed across it deterministically at collide spacing, so the set
    // starts out roughly where it will end up and, critically, already
    // non-overlapping. Nothing random, nothing stacked. See bulk-layout.ts.
    const groups = new Map<string, { ids: string[]; region: SeedRegion | undefined }>();
    for (const { node, region } of arrivals) {
      const key = region ? `${region.x}:${region.y}:${region.r ?? ""}` : "";
      const group = groups.get(key);
      if (group) group.ids.push(node.id);
      else groups.set(key, { ids: [node.id], region });
    }
    const seeds = buildBulkSeeds(groups, NODE_MIN_EDGE_GAP);

    const next: PhysicsNode[] = nodes.map((node) => {
      const existing = byId.get(node.id);
      if (existing) {
        existing.radius = radiusOf(node);
        return existing;
      }
      const saved = initialPositions[node.id];
      if (saved) return { id: node.id, radius: radiusOf(node), x: saved.x, y: saved.y };
      const seed = seeds.get(node.id) ?? { x: 0, y: 0 };
      return { id: node.id, radius: radiusOf(node), x: seed.x, y: seed.y, vx: 0, vy: 0 };
    });

    // PHASE 3 — SETTLE. A bulk arrival puts the simulation into a tighter
    // regime (lower speed ceiling, heavier damping) for a bounded number of
    // ticks, so the graph converges to the seeded layout instead of reacting
    // violently to it. Ordinary one-or-two-tab additions never trigger it.
    //
    // A window belonging to an ALREADY-SETTLED arrival is retired first. The
    // countdown only advances while the simulation is running, so a dump that
    // converged in fewer ticks than its budget leaves the remainder sitting
    // there; without retiring it, the next tab added by hand would inherit
    // the leftover and be damped as though it were part of an import. A
    // window whose graph is still moving is deliberately left alone — titles
    // resolving mid-settle re-enter setNodes with zero arrivals, and that
    // must not cut the dump's own settling short.
    if (simulation.alpha() <= simulation.alphaMin()) bulkSettleTicks = 0;
    if (arrivalCount >= BULK_ARRIVAL_THRESHOLD) bulkSettleTicks = BULK_SETTLE_TICKS;

    byId.clear();
    for (const n of next) byId.set(n.id, n);
    simulation.nodes(next);

    // A tab that has left the visible set can't be carried by a boundary any
    // more, so its in-memory offset goes with it rather than accumulating for
    // the life of the session. If it comes back, seedBoundaryOffsets restores
    // it from the persisted record, which is the source of truth.
    for (const id of [...anchorOffsetById.keys()]) if (!byId.has(id)) anchorOffsetById.delete(id);
    for (const id of [...displacedMembers]) if (!byId.has(id)) displacedMembers.delete(id);
    for (const id of [...lastGoodNodePosition.keys()]) if (!byId.has(id)) lastGoodNodePosition.delete(id);
    sanitizeNodes();
  }

  function setEdges(edges: GraphEdge[], strength: number) {
    const links: PhysicsLink[] = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    // Degree normalisation, scaled by the user's edge-strength setting — see
    // LINK_BASE_STRENGTH for why a flat strength is what tore hubs apart.
    // Counted here rather than relying on d3's own default so the user's
    // setting multiplies the normalised value instead of replacing it.
    const degree = new Map<string, number>();
    for (const link of links) {
      const source = link.source as string;
      const target = link.target as string;
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
    const scale = Math.max(0.02, Math.min(1, strength));

    simulation.force(
      "link",
      forceLink<PhysicsNode, PhysicsLink>(links)
        .id((n) => n.id)
        .distance(LINK_DISTANCE)
        .strength((link) => {
          const source = typeof link.source === "string" ? link.source : (link.source as PhysicsNode).id;
          const target = typeof link.target === "string" ? link.target : (link.target as PhysicsNode).id;
          const shared = Math.max(1, Math.min(degree.get(source) ?? 1, degree.get(target) ?? 1));
          return (LINK_BASE_STRENGTH / shared) * scale;
        })
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
      if (isPointerHeld(node)) continue;
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
        // Provisional: syncBoundaryBodies (called at the end of this function,
        // and again every tick) is what actually decides this, from whether
        // the members are ones the physics may move.
        governed: true,
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
   * Re-derives every body's rect from the live physics positions of the
   * members the physics may actually move — the box IS its members' padded
   * bounding box, exactly as the renderer draws it, so the collider and the
   * visible square agree by construction.
   *
   * The one deliberate exception is a member the pointer is holding (see
   * `isPointerHeld`), which is left out of the collider for as long as the
   * drag lasts, and which sets `body.governed` false if it was the body's
   * only member. The renderer keeps drawing the full box — a tab being
   * dragged away from its cluster genuinely does stretch the square around
   * it, and hiding that would be a lie — but the COLLIDER may only describe
   * geometry this layer can move rigidly, and a pinned member is one it
   * cannot. Including it made the collision response deform the box instead
   * of translating it: the box grew by the push, the larger box overlapped
   * its neighbour harder, and the next frame's push grew with it, which is
   * how dragging a single tab used to fling whole clusters thousands of
   * units across the graph. See BoundaryBody.governed.
   *
   * A body whose members have no usable position yet keeps its previous rect.
   */
  function syncBoundaryBodies() {
    for (const body of boundaryBodies.values()) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of body.memberIds) {
        // The node under the pointer is deliberately not part of any box's
        // geometry — see setBoundaryExcluded. A box with nothing BUT the
        // dragged node keeps its previous rect (the minX === Infinity check
        // below), which is still the right answer: it doesn't collapse.
        if (id === boundaryExcludedId) continue;
        const node = byId.get(id);
        // Number.isFinite, not just `!== undefined`: one NaN member position
        // would otherwise make every extreme NaN, hand the body a NaN centre,
        // and from there NaN out every other member through the next
        // translate. sanitizeNodes below keeps that from arising at all; this
        // is the second line of defence, on the path that would spread it.
        if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
        if (isPointerHeld(node)) continue;
        const radius = Number.isFinite(node.radius) ? node.radius : 0;
        minX = Math.min(minX, node.x! - radius);
        maxX = Math.max(maxX, node.x! + radius);
        minY = Math.min(minY, node.y! - radius);
        maxY = Math.max(maxY, node.y! + radius);
      }
      // Nothing movable to derive a rect from — every member is under the
      // pointer, or none is positioned yet. The body keeps the rect it
      // already had rather than collapsing, but that rect now describes
      // where its members WERE, so the body sits out the step instead of
      // colliding against a stale position. It stays in the world either way.
      if (minX === Infinity) {
        body.governed = false;
        continue;
      }
      body.governed = true;
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
   * Moves a boundary's tabs — and the cluster territory holding them — by the
   * same rigid delta the box itself moved. This is what makes a boundary drag
   * a real change to the graph's own node positions rather than a floating
   * rectangle drawn somewhere else.
   */
  function translateBoundaryMembers(memberIds: string[], dx: number, dy: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    for (const id of memberIds) {
      const node = byId.get(id);
      if (!node) continue;
      // A tab the pointer is holding belongs to the pointer, not to this
      // layer: the next pointermove rewrites its fx/fy regardless, so moving
      // it here only pretends the translation was rigid. It is excluded from
      // the body's collider for exactly the same reason, which is what keeps
      // this skip honest rather than a hole in the invariant — the members
      // that define the rect are precisely the members that move with it.
      if (isPointerHeld(node)) continue;
      if (node.x !== undefined) node.x += dx;
      if (node.y !== undefined) node.y += dy;
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
    const deltas = stepBoundaryBodies(bodies, worldSandbox(), drag);
    for (const [id, delta] of deltas) {
      const body = boundaryBodies.get(id);
      if (!body) continue;
      translateBoundaryMembers(body.memberIds, delta.dx, delta.dy);
    }
  }

  /**
   * Whether the post-bulk-arrival regime is still in force, expiring it if
   * not.
   *
   * The window ends on WHICHEVER comes first: the tick budget running out, or
   * the layout settling. The second is the one that matters in practice — a
   * dump usually converges in fewer than BULK_SETTLE_TICKS ticks, and the
   * countdown only advances while the simulation is actually running, so
   * without expiring on settle the tighter regime would latch on
   * indefinitely and the next tab added by hand would be damped as though it
   * were part of a bulk import.
   */
  function inBulkWindow(): boolean {
    if (bulkSettleTicks <= 0) return false;
    if (simulation.alpha() <= simulation.alphaMin()) {
      bulkSettleTicks = 0;
      return false;
    }
    return true;
  }

  /**
   * Zeroes the velocity every node is still carrying at the moment the
   * simulation stops advancing, so "settled" means at rest rather than
   * frozen mid-flight. See `parkedAtSettle`.
   */
  function parkResidualMotion() {
    for (const node of byId.values()) {
      node.vx = 0;
      node.vy = 0;
    }
  }

  function tickOnce() {
    if (simulation.alpha() > simulation.alphaMin()) {
      // Damping is a property of the regime, not of the frame, so it is only
      // written on the transition in or out of the bulk window.
      const decay = inBulkWindow() ? BULK_VELOCITY_DECAY : VELOCITY_DECAY;
      if (simulation.velocityDecay() !== decay) simulation.velocityDecay(decay);

      simulation.tick();
      sanitizeNodes();
      confineToRegions();
      if (bulkSettleTicks > 0) bulkSettleTicks--;
      parkedAtSettle = false;
    } else if (!parkedAtSettle) {
      parkResidualMotion();
      parkedAtSettle = true;
    }
  }

  return {
    tick: () => {
      tickOnce();
      // Always stepped, even once the node layout has cooled: a boundary drag
      // is direct manipulation and shouldn't depend on alpha. A no-op when
      // every body is asleep and nothing is being dragged.
      stepBoundaryLayer();
    },
    isSettled: () => simulation.alpha() <= simulation.alphaMin(),
    reheat: (amount = 0.4) => {
      simulation.alpha(Math.max(simulation.alpha(), amount));
      parkedAtSettle = false;
    },
    lastArrivalCount: () => arrivalCount,
    isBulkSettling: () => inBulkWindow(),
    settleBulk: (maxTicks, budgetMs) => {
      const start = Date.now();
      let ran = 0;
      while (ran < maxTicks && !(simulation.alpha() <= simulation.alphaMin())) {
        tickOnce();
        ran++;
        // Checked every few ticks rather than every tick: Date.now() is
        // cheap but not free, and the point is a soft budget, not a precise
        // one. The tick count is the real bound; this only keeps a very
        // large graph from blocking the frame longer than intended.
        if (ran % 8 === 0 && Date.now() - start >= budgetMs) break;
      }
      // The boundary layer is re-derived from wherever the nodes ended up,
      // once, so the first painted frame's squares match the settled layout
      // instead of the seeded one.
      if (ran > 0) syncBoundaryBodies();
      return ran;
    },
    setBoundaryExcluded: (id) => {
      boundaryExcludedId = id;
    },
    getBoundaryExcluded: () => boundaryExcludedId,
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
