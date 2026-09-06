export type CollectionBoundaryPoint = { x: number; y: number; radius: number };
export type CollectionBoundaryRect = { x: number; y: number; width: number; height: number };

/**
 * World-space padding around a Collection's member bounding box —
 * `computeCollectionBoundary`'s default, named so callers that need to
 * reproduce the same box elsewhere (the collider behind a draggable
 * boundary, say) can't drift from it.
 *
 * World, not screen: a boundary square's geometry must never depend on the
 * camera. A screen-space padding is a fixed number of PIXELS however far out
 * you zoom, so a zoomed-out box becomes almost entirely padding — which is
 * what used to collapse cleanly separated squares into each other, and then
 * into the suppression pass that deleted them. See `resolveLiveBoundaries`.
 */
export const COLLECTION_BOUNDARY_PADDING = 20;

/**
 * Axis-aligned bounding rect (with a fixed screen-space padding) around a
 * collection's currently-visible member nodes — the "soft enclosing region"
 * the graph draws behind a collection's nodes (AGENTS.md-style spec:
 * "subtle enclosing region... not an edge between every tab"). Returns null
 * when nothing is visible so the caller can skip drawing/hit-testing
 * entirely rather than rendering a degenerate zero-size box.
 */
export function computeCollectionBoundary(
  points: CollectionBoundaryPoint[],
  padding = COLLECTION_BOUNDARY_PADDING
): CollectionBoundaryRect | null {
  if (points.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - p.radius);
    maxX = Math.max(maxX, p.x + p.radius);
    minY = Math.min(minY, p.y - p.radius);
    maxY = Math.max(maxY, p.y + p.radius);
  }

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

/**
 * World-space padding around a Category / Subcategory candidate AABB (see
 * COLLECTION_BOUNDARY_PADDING above for why world rather than screen).
 *
 * Halved from 40/28 — a real-pipeline benchmark sweep (570 tabs, dozens of
 * real per-domain categories) found the smaller padded AABB lets more
 * legitimate boundaries survive overlap suppression (mean drawn count +16%
 * at this value, aggregated across 250-750 tabs x 5-50 categories) with
 * zero crossings/oversized boxes and unchanged parent/child containment.
 * Halving both together (not just Category) matters: shrinking Category
 * alone while leaving Subcategory fixed can pop a Subcategory box outside
 * its own parent's shrunk box, which the crossing-suppression pass then
 * treats as ordinary unrelated overlap instead of intentional nesting.
 * Collections keep computeCollectionBoundary's own 20px default.
 *
 * These live here, beside the rest of the boundary policy, rather than in
 * graph-canvas.tsx, so the regression suites can assert against the values
 * the renderer actually uses. They previously sat private to the component
 * and dense-boundaries.test.ts kept its own copies, which silently went on
 * testing the pre-halving 40/28 after production moved to 20/14 — a green
 * suite that no longer described the shipped renderer.
 */
export const CATEGORY_BOUNDARY_PADDING = 20;
export const SUBCATEGORY_BOUNDARY_PADDING = 14;

/*
 * There is deliberately no ambient boundary cap here any more.
 *
 * MAX_AMBIENT_BOUNDARIES = 8 used to bound how many unselected boundaries a
 * frame could draw. It was introduced under the old ring layout, where every
 * category was a point on one shared circle and adjacent categories'
 * axis-aligned bounding boxes overlapped near the ring's centre as a pure
 * geometry artifact — dozens of candidate boxes contending for the same
 * territory, so "whatever greedy overlap suppression happened to leave" was
 * unpredictable and a deliberate top-N was the honest alternative.
 *
 * The packed2d layout (see cluster-regions.ts) removed that premise: every
 * category owns a disjoint disc, so its box is small and lands on its own
 * territory. Measured on the real 283-tab export at one fixed layout seed,
 * with the cap the only variable: 39 candidates, 0 rejected by the
 * concentration gate, 3 by overlap suppression — and then 28 more discarded by
 * the cap alone, leaving 8 boxes for 34 categories. Uncapped, the same frame
 * draws 36, with zero rectangle intersections, 1.00 mean category purity, 5%
 * foreign nodes inside drawn boxes, and a 0.5% mean / 1.4% largest box as a
 * share of the viewport (against 0.9%/1.4% at the cap). Every box the cap was
 * hiding was clean; the cap was the only reason most categories had no
 * boundary at all.
 *
 * Nor did it ever protect the ring layout it was written for: measured
 * there, the greedy overlap suppression of the day left only 1-6 boxes, so a
 * ceiling of 8 never bound.
 *
 * Both of those passes are gone now (see the note further down, where
 * selectNonOverlappingRects was). The density control that remains is
 * boundaryDelimitsMembers, which refuses to admit a box that doesn't delimit
 * anything; a purely count-based cap on top of it only ever hid legitimate
 * categories.
 */

export function pointInRect(x: number, y: number, rect: CollectionBoundaryRect): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export function rectsOverlap(a: CollectionBoundaryRect, b: CollectionBoundaryRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** True when `inner` lies wholly within `outer` — the only shape "nesting" actually has. */
export function rectContains(outer: CollectionBoundaryRect, inner: CollectionBoundaryRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** A node's screen position, as seen by the boundary that might enclose it. */
export type BoundaryOccupant = { id: string; x: number; y: number };

/**
 * How much denser a cluster must be INSIDE its own boundary box than it is
 * across the graph as a whole before that box is worth drawing.
 *
 * 2 = "at least twice as concentrated in here as out there". A box whose
 * contents look just like a random sample of the graph tells the reader
 * nothing, however tightly it hugs its members' extremes.
 */
export const MIN_BOUNDARY_CONCENTRATION = 2;

/**
 * Ceiling on the bar `boundaryDelimitsMembers` can demand, so a cluster
 * that legitimately dominates the graph can still show a boundary. Without
 * it, a cluster holding half the tabs would need an impossible 100%-pure
 * box (0.5 x 2) and could never draw one.
 */
const MAX_BOUNDARY_SHARE_BAR = 0.9;

/**
 * Whether `rect` actually *delimits* `memberIds`, rather than merely being
 * the smallest box that happens to contain them.
 *
 * computeCollectionBoundary is a plain axis-aligned bounding box over a
 * cluster's members, and nothing about that construction requires the
 * result to enclose anything meaningful. The anchor forces that group a
 * cluster are deliberately weak relative to collide/link (see engine.ts),
 * so past a few hundred tabs clusters interleave spatially and every
 * cluster's AABB balloons out to cover almost the whole graph: measured on
 * a settled 520-tab layout, the "Claude" category's box spanned 36% of the
 * viewport and contained 513 of the 520 nodes while owning only 52 of
 * them. Boxes like that are not boundaries — they are large faint
 * rectangles draped over the entire graph, and several of them at once is
 * the visual glitch this guard exists to prevent. Suppressing overlaps
 * cannot help: that pass ranks by weight, so its survivors are precisely
 * the most sprawling boxes.
 *
 * The test is concentration, not purity. Purity alone can't tell the two
 * cases apart: clusters sit as adjacent wedges on a ring (see clusters.ts's
 * computeClusterAnchors), so even a cleanly separated category's box picks
 * up a good share of its neighbours' nodes. Measured across settled
 * layouts, a well-separated 520-tab graph's category boxes hold ~29% own
 * members against a 10% graph-wide share (~3x — informative, and drawn),
 * while the degenerate whole-graph boxes hold ~10% against that same 10%
 * (~1x — a random sample of the graph, and dropped). A flat purity
 * threshold high enough to reject the second would throw away the first.
 *
 * `occupants` is every currently-positioned node on screen, not just this
 * cluster's — both the density inside the box and the graph-wide baseline
 * are measured from it. An empty box is vacuously fine.
 */
export function boundaryDelimitsMembers(
  rect: CollectionBoundaryRect,
  memberIds: ReadonlySet<string>,
  occupants: readonly BoundaryOccupant[],
  minConcentration = MIN_BOUNDARY_CONCENTRATION
): boolean {
  return occupancyDelimitsMembers(
    measureBoundaryOccupancy(rect, memberIds, occupants),
    occupants.length,
    minConcentration
  );
}

/**
 * What one candidate box actually encloses, counted once so both the
 * concentration gate and the draw-priority ranking can read it without
 * re-walking every occupant. `inside` is every node inside the rect,
 * `ownInside` the subset belonging to the cluster, `ownTotal` the cluster's
 * members anywhere on screen.
 */
export type BoundaryOccupancy = { inside: number; ownInside: number; ownTotal: number };

export function measureBoundaryOccupancy(
  rect: CollectionBoundaryRect,
  memberIds: ReadonlySet<string>,
  occupants: readonly BoundaryOccupant[]
): BoundaryOccupancy {
  let inside = 0;
  let ownInside = 0;
  let ownTotal = 0;
  for (const point of occupants) {
    const isOwn = memberIds.has(point.id);
    if (isOwn) ownTotal++;
    if (!pointInRect(point.x, point.y, rect)) continue;
    inside++;
    if (isOwn) ownInside++;
  }
  return { inside, ownInside, ownTotal };
}

/** `boundaryDelimitsMembers`'s test, against an already-measured occupancy. */
export function occupancyDelimitsMembers(
  occupancy: BoundaryOccupancy,
  occupantCount: number,
  minConcentration = MIN_BOUNDARY_CONCENTRATION
): boolean {
  const { inside, ownInside, ownTotal } = occupancy;
  if (inside === 0 || ownTotal === 0) return true;

  const graphWideShare = ownTotal / occupantCount;
  const bar = Math.min(MAX_BOUNDARY_SHARE_BAR, graphWideShare * minConcentration);
  return ownInside / inside >= bar;
}

/**
 * The share of what a box encloses that actually belongs to it — 1 when the
 * box holds nothing but its own members, approaching 0 as it sweeps in
 * unrelated graph content. An empty box is vacuously pure.
 */
export function boundaryPurity(occupancy: BoundaryOccupancy): number {
  return occupancy.inside === 0 ? 1 : occupancy.ownInside / occupancy.inside;
}

/*
 * boundaryDrawPriority and selectNonOverlappingRects used to live here.
 *
 * Together they were the overlap-suppression pass: rank every candidate box,
 * then greedily drop any that would visibly cross a higher-ranked one. That
 * is deliberately gone. Boundary squares are persistent physics bodies now
 * (see boundary-physics.ts) — two of them overlapping is the ordinary,
 * expected state of a collision, and the layer resolves it by pushing them
 * apart. Hiding one instead is what deleted squares: the suppressed set was
 * also the set handed to setBoundaryBodies, so losing the overlap contest
 * destroyed the losing square's physics body outright.
 *
 * Keeping boxes from resting on top of each other is therefore the physics
 * layer's job, and only its job. Measured on the real 283-tab export: 3
 * unrelated pairs overlap the moment the bodies are created (worst 83% of
 * the smaller box), and 21 ticks later all 3 have separated with the 7
 * intentional parent/child nestings untouched.
 *
 * What survives here is the part that was never about overlap: the
 * concentration gate (boundaryDelimitsMembers / occupancyDelimitsMembers),
 * which still keeps a box that has degenerated into a rectangle draped over
 * the whole graph from ever being admitted in the first place. See
 * resolveLiveBoundaries below.
 */


/** One boundary square offered to `resolveLiveBoundaries` for this frame. */
export type BoundaryCandidate = {
  id: string;
  /** World-space rect, as re-derived from this frame's member positions. */
  rect: CollectionBoundaryRect;
  /** The cluster/collection's members, for the concentration measurement. */
  memberIds: ReadonlySet<string>;
};

/**
 * Decides which boundary squares are LIVE this frame — live meaning drawn,
 * hit-testable, and backed by a physics body, all three together.
 *
 * The rule is deliberately a latch, not a per-frame re-election:
 *
 *   - a square already live STAYS live, unconditionally, for as long as its
 *     cluster still exists and still has a positioned member;
 *   - a square not yet live joins when it passes the concentration gate
 *     (`occupancyDelimitsMembers`) or is explicitly exempt from it;
 *   - a square leaves only when it stops being offered as a candidate at
 *     all — i.e. its cluster/collection is gone from the tree, or every one
 *     of its members has left the graph. Identity loss, never geometry.
 *
 * This is the whole fix for squares vanishing. What was here before re-ran
 * every quality heuristic against the *current* geometry each frame, and
 * pruned the losers out of the very maps that drive rendering, hit-testing
 * AND the physics body set — so a square that merely moved could lose its
 * body mid-simulation. Measured on cleanly separated clusters, before this
 * latch: pushing one square 260px into its neighbour deleted the neighbour,
 * and 300px deleted both; zooming a six-square frame out to 0.22 deleted
 * four of the six and to 0.08 deleted all six. Overlapping is now the
 * expected state of two colliding rigid bodies, and being small on screen is
 * a property of the camera — neither is a reason to stop existing.
 *
 * The concentration gate survives as an ADMISSION rule only, where it still
 * does its original job (see `boundaryDelimitsMembers`: keeping a cluster
 * whose AABB has degenerated into a rectangle draped over the whole graph
 * from ever appearing). A square that was honest when admitted and later
 * sprawls stays on screen — deliberately: a box the reader can watch grow is
 * a lesser problem than a box that silently disappears out from under them.
 *
 * `live` is read and updated in place; it is the caller's persistent set.
 */
export function resolveLiveBoundaries(
  candidates: readonly BoundaryCandidate[],
  live: Set<string>,
  occupants: readonly BoundaryOccupant[],
  alwaysAdmit: ReadonlySet<string>
): void {
  const offered = new Set<string>();
  for (const candidate of candidates) {
    offered.add(candidate.id);
    if (live.has(candidate.id)) continue;
    if (alwaysAdmit.has(candidate.id)) {
      live.add(candidate.id);
      continue;
    }
    const occupancy = measureBoundaryOccupancy(candidate.rect, candidate.memberIds, occupants);
    if (occupancyDelimitsMembers(occupancy, occupants.length)) live.add(candidate.id);
  }
  for (const id of [...live]) if (!offered.has(id)) live.delete(id);
}

/*
 * There is deliberately no size/purity/sprawl admission rule here.
 *
 * Removing overlap suppression did put visibly large, low-purity boxes back
 * on screen — measured on the dense fixtures at 32-49% of the graph's extent
 * holding 4-5% of their own members, against legitimate category boxes at
 * <=4% and 1.00 purity. A guard rejecting those on size and purity was tried
 * and deliberately taken out again.
 *
 * The reason is the product requirement, not an oversight: a boundary that
 * exists in the graph must be represented by a square, and a box being large
 * or impure is a fact about the LAYOUT, not grounds for the boundary to be
 * absent. Hiding it makes the picture tidier by making it lie. If those boxes
 * read badly, that is a layout/physics problem to solve where the layout is
 * decided — better cluster separation, or the boundary layer pushing them
 * apart — not here by omission.
 */
