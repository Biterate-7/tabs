/**
 * Rigid-body layer for the graph's boundary squares.
 *
 * The Category / Subcategory / Collection boxes the canvas already draws are
 * axis-aligned bounding boxes over their member nodes (see
 * collection-layout.ts's computeCollectionBoundary), so a box has never had a
 * position of its own — it *is* wherever its members are. That stays true
 * here: a body's centre and half-extents are re-derived from its members
 * every tick (see engine.ts's syncBoundaryBodies), and the only thing this
 * module produces is a per-body TRANSLATION, which the engine then applies
 * rigidly to that body's member nodes. There is deliberately no second,
 * box-only position that could drift out of sync with the graph the boxes
 * are drawn around.
 *
 * Everything here is world-space and frame-stepped (dt = 1 frame), matching
 * d3-force's own velocity convention in engine.ts, and is ticked from that
 * same simulation's tick() — this is a layer on the existing engine, not a
 * second physics system.
 */

/** One draggable boundary square. Mutated in place by `stepBoundaryBodies`. */
export type BoundaryBody = {
  id: string;
  /** Tabs the box encloses — translated rigidly whenever the box moves. */
  memberIds: string[];
  /** `memberIds` as a set, for the shared-membership test below. */
  members: ReadonlySet<string>;
  /** Centre, world space. Re-derived from members each tick before stepping. */
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  vx: number;
  vy: number;
  /** A resting body is skipped entirely, so an untouched layout never churns. */
  asleep: boolean;
  /** Set by `stepBoundaryBodies` for the single body under the pointer. */
  dragging: boolean;
};

/** The world-space rect boundary bodies are kept inside (the visible canvas). */
export type Sandbox = { minX: number; minY: number; maxX: number; maxY: number };

/** Where the pointer wants the dragged body's CENTRE to be this frame. */
export type BoundaryDrag = { id: string; targetX: number; targetY: number };

/**
 * Per-frame velocity retention for a body that is coasting after a push or a
 * release. Deliberately heavier than the node simulation's own 0.32
 * velocityDecay: a box carries a whole cluster of tabs with it, so it should
 * come to rest in well under a second rather than glide.
 */
export const BOUNDARY_DAMPING = 0.82;

/** Below this speed (world units per frame) a body stops and goes to sleep. */
export const BOUNDARY_SLEEP_SPEED = 0.08;

/**
 * How much of a separation is converted into velocity for the body that got
 * pushed. Low on purpose: the separation itself already resolves the overlap,
 * so this only adds the small "bumped" follow-through. Read together with the
 * damping above (a coasting body travels `1 / (1 - damping)` = ~5.5x its
 * current speed before stopping), it means a bumped box glides roughly HALF
 * the distance it was shoved and then settles — a nudge, not a launch.
 */
export const BOUNDARY_PUSH_IMPULSE = 0.1;

/** Hard ceiling on push- and release-imparted speed, so nothing ever flies off. */
export const BOUNDARY_MAX_SPEED = 26;

/** Fraction of the pointer's own speed a released body keeps. */
export const BOUNDARY_RELEASE_FACTOR = 0.5;

/**
 * Overlap (world units) tolerated before two boxes count as colliding.
 * Without it, two boxes resting edge-to-edge would flip between "touching"
 * and "penetrating" as their members jiggle under the node forces, and push
 * each other a fraction of a pixel every frame forever.
 */
export const BOUNDARY_PENETRATION_SLOP = 0.5;

/**
 * Ceiling on how many collision passes one frame's pointer motion is split
 * into. A fast drag can move a box further than its own width in a single
 * frame; without substepping the box would be *past* its neighbour before any
 * overlap is ever detected, i.e. tunnel straight through it.
 */
const MAX_SUBSTEPS = 8;

/** Sequential-impulse style: a couple of passes settles a body wedged between two others. */
const RESOLUTION_PASSES = 2;

function clampSpeed(v: number): number {
  return Math.max(-BOUNDARY_MAX_SPEED, Math.min(BOUNDARY_MAX_SPEED, v));
}

/**
 * The shortest translation that separates `b` from `a` (applied to `b`;
 * negate for `a`), or null when they aren't meaningfully overlapping. Resolves
 * along the axis of least penetration, which is what makes a box slide along
 * its neighbour's face instead of popping around a corner.
 */
export function boundaryPenetration(
  a: Pick<BoundaryBody, "x" | "y" | "halfWidth" | "halfHeight">,
  b: Pick<BoundaryBody, "x" | "y" | "halfWidth" | "halfHeight">
): { x: number; y: number } | null {
  const overlapX = a.halfWidth + b.halfWidth - Math.abs(b.x - a.x);
  if (overlapX <= BOUNDARY_PENETRATION_SLOP) return null;
  const overlapY = a.halfHeight + b.halfHeight - Math.abs(b.y - a.y);
  if (overlapY <= BOUNDARY_PENETRATION_SLOP) return null;

  if (overlapX < overlapY) return { x: overlapX * (b.x >= a.x ? 1 : -1), y: 0 };
  return { x: 0, y: overlapY * (b.y >= a.y ? 1 : -1) };
}

/**
 * Two boxes that enclose any of the same tabs are NOT colliding objects —
 * they're nested views of one region (a subcategory inside its category, a
 * collection inside the category holding most of its members). Moving one
 * already moves the other's members, so resolving them against each other
 * would have them shove themselves around forever.
 */
export function boundariesShareMembers(a: BoundaryBody, b: BoundaryBody): boolean {
  const [small, large] = a.members.size <= b.members.size ? [a.members, b.members] : [b.members, a.members];
  for (const id of small) if (large.has(id)) return true;
  return false;
}

/**
 * Keeps a body inside the sandbox. A box wider (or taller) than the sandbox
 * itself is left alone on that axis — clamping it would jam a large category
 * to the viewport centre and make it undraggable.
 *
 * Velocity into the wall is zeroed, not reflected: a wall stops a box, it
 * doesn't bounce it.
 */
export function clampBodyToSandbox(body: BoundaryBody, sandbox: Sandbox): void {
  if (body.halfWidth * 2 <= sandbox.maxX - sandbox.minX) {
    const min = sandbox.minX + body.halfWidth;
    const max = sandbox.maxX - body.halfWidth;
    if (body.x < min) {
      body.x = min;
      if (body.vx < 0) body.vx = 0;
    } else if (body.x > max) {
      body.x = max;
      if (body.vx > 0) body.vx = 0;
    }
  }
  if (body.halfHeight * 2 <= sandbox.maxY - sandbox.minY) {
    const min = sandbox.minY + body.halfHeight;
    const max = sandbox.maxY - body.halfHeight;
    if (body.y < min) {
      body.y = min;
      if (body.vy < 0) body.vy = 0;
    } else if (body.y > max) {
      body.y = max;
      if (body.vy > 0) body.vy = 0;
    }
  }
}

function push(body: BoundaryBody, mtv: { x: number; y: number }, scale: number): void {
  body.x += mtv.x * scale;
  body.y += mtv.y * scale;
  body.vx = clampSpeed(body.vx + mtv.x * scale * BOUNDARY_PUSH_IMPULSE);
  body.vy = clampSpeed(body.vy + mtv.y * scale * BOUNDARY_PUSH_IMPULSE);
}

function resolveOverlaps(bodies: BoundaryBody[]): void {
  for (let pass = 0; pass < RESOLUTION_PASSES; pass++) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        // Two resting boxes are never re-tested. The drawn set is
        // non-overlapping by construction (selectNonOverlappingRects), so
        // this is what keeps an untouched graph completely inert instead of
        // nudging boxes around as their members jiggle under the node forces.
        if (a.asleep && b.asleep) continue;
        const mtv = boundaryPenetration(a, b);
        if (!mtv) continue;
        if (boundariesShareMembers(a, b)) continue;
        a.asleep = false;
        b.asleep = false;
        // The dragged box has effectively infinite mass: the pointer, not
        // the other box, decides where it goes, so it pushes and is never
        // pushed. That is also what stops a drag from ever getting wedged.
        if (a.dragging) push(b, mtv, 1);
        else if (b.dragging) push(a, mtv, -1);
        else {
          push(b, mtv, 0.5);
          push(a, mtv, -0.5);
        }
      }
    }
  }
}

/**
 * Advances the boundary layer by one frame and reports how far each body
 * actually moved, so the caller can translate that body's member nodes by the
 * same amount (which is what makes the move real rather than cosmetic).
 *
 * `drag`, when given, names the body under the pointer and where its centre
 * should be; that body is moved there directly — pointer control outranks the
 * physics — and only the sandbox walls can hold it back.
 */
export function stepBoundaryBodies(
  bodies: BoundaryBody[],
  sandbox: Sandbox | null,
  drag: BoundaryDrag | null
): Map<string, { dx: number; dy: number }> {
  const start = new Map(bodies.map((b) => [b.id, { x: b.x, y: b.y }]));

  const dragged = drag ? (bodies.find((b) => b.id === drag.id) ?? null) : null;
  for (const body of bodies) body.dragging = body === dragged;
  if (dragged) dragged.asleep = false;

  let dragDx = 0;
  let dragDy = 0;
  let substeps = 1;
  if (dragged && drag) {
    dragDx = drag.targetX - dragged.x;
    dragDy = drag.targetY - dragged.y;
    // Never advance further than roughly the dragged box's smaller half-side
    // per substep, so a neighbour can't be skipped over entirely.
    const maxStep = Math.max(8, Math.min(dragged.halfWidth, dragged.halfHeight));
    substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.hypot(dragDx, dragDy) / maxStep)));
  }

  for (let step = 0; step < substeps; step++) {
    if (dragged) {
      dragged.x += dragDx / substeps;
      dragged.y += dragDy / substeps;
    }
    for (const body of bodies) {
      if (body === dragged || body.asleep) continue;
      body.x += body.vx / substeps;
      body.y += body.vy / substeps;
    }
    resolveOverlaps(bodies);
    if (sandbox) {
      for (const body of bodies) {
        if (body.asleep) continue;
        clampBodyToSandbox(body, sandbox);
      }
    }
  }

  const deltas = new Map<string, { dx: number; dy: number }>();
  for (const body of bodies) {
    const from = start.get(body.id)!;
    const dx = body.x - from.x;
    const dy = body.y - from.y;

    if (body.dragging) {
      // A dragged body doesn't integrate its velocity — the pointer moves it.
      // Its velocity instead records how fast the pointer is actually
      // carrying it, which is what releaseVelocity hands back as the throw.
      body.vx = clampSpeed(dx);
      body.vy = clampSpeed(dy);
    } else if (!body.asleep) {
      body.vx *= BOUNDARY_DAMPING;
      body.vy *= BOUNDARY_DAMPING;
      if (Math.hypot(body.vx, body.vy) < BOUNDARY_SLEEP_SPEED && Math.hypot(dx, dy) < BOUNDARY_SLEEP_SPEED) {
        body.vx = 0;
        body.vy = 0;
        body.asleep = true;
      }
    }

    if (dx !== 0 || dy !== 0) deltas.set(body.id, { dx, dy });
  }
  return deltas;
}

/** The velocity a body keeps when the pointer lets go of it — damped and capped so a fast flick can never launch it. */
export function releaseVelocity(body: BoundaryBody): { vx: number; vy: number } {
  return {
    vx: clampSpeed(body.vx * BOUNDARY_RELEASE_FACTOR),
    vy: clampSpeed(body.vy * BOUNDARY_RELEASE_FACTOR),
  };
}
