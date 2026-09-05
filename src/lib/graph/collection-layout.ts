export type CollectionBoundaryPoint = { x: number; y: number; radius: number };
export type CollectionBoundaryRect = { x: number; y: number; width: number; height: number };

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
  padding = 20
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
 * Screen-space padding around a Category / Subcategory candidate AABB.
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
 * Nor did it ever protect the ring layout it was written for: measured there,
 * greedy overlap suppression alone leaves 1-6 boxes, so a ceiling of 8 never
 * binds. boundaryDelimitsMembers rejects boxes that don't delimit anything,
 * boundaryDrawPriority decides who claims territory first, and
 * selectNonOverlappingRects guarantees no two drawn boxes ever cross. Those
 * three are the density control; a fourth, purely count-based one only hid
 * legitimate categories.
 *
 * selectNonOverlappingRects still accepts an optional `maxAmbient`, so a
 * caller that genuinely needs a ceiling can pass one — the renderer does not.
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

/**
 * How much a box is worth drawing, used to order `selectNonOverlappingRects`
 * — roughly "how many of its own members this box actually communicates":
 * the cluster's size, discounted by how much foreign content the box drags
 * in alongside them.
 *
 * The ordering matters far more than it looks, because the overlap pass is
 * greedy: whatever goes first claims its territory outright and every later
 * box touching that territory is dropped. Ranking by raw cluster weight —
 * what this replaces — therefore hands the first pick to the single most
 * sprawling box on screen, which is exactly the box most likely to blanket
 * the territory of a dozen smaller, tighter, more informative ones, and to
 * be the least informative box in the frame while it does so.
 *
 * Measured over 35 settled layouts of the skewed dense fixture in
 * dense-boundaries.test.ts (250-750 tabs x 12-40 real per-domain categories),
 * against the weight ordering this replaces: mean purity of the drawn set
 * rises from 0.40 to 0.46, with the drawn count (6.23) and the largest drawn
 * box (10.4% of the viewport) unchanged, and still zero crossings. So the
 * frame shows the same number of boundaries, but each one is markedly more
 * about its own cluster and less a rectangle laid over its neighbours.
 *
 * What this is NOT: it does not draw materially more boxes. On this fixture
 * family the count is flat; on an earlier, more separable fixture it rose
 * ~13%. Either way ~6 boxes out of 30-50 eligible candidates is what
 * non-overlapping axis-aligned packing allows at these densities, and
 * reordering cannot lift that ceiling — only looser geometry or a stronger
 * anchor force could, both of which are out of scope here. Purity is the
 * axis this moves.
 *
 * It is deliberately not a purity-maximizing rule either. Ranking by purity
 * alone scores better on box quality but drops the heaviest cluster's box in
 * 31 of 40 measured layouts, which reads as broken when that cluster visibly
 * dominates the graph. Multiplying by weight keeps a big cluster near the top
 * while its box stays honest, and demotes it below its compact neighbours
 * once the box stops being honest — the intended trade, and the one the spec
 * asks for: "a meaningful boundary is preferable to a misleading boundary".
 *
 * Also rejected, measured on the same layouts: tolerating a small overlap
 * rather than reordering. It raises the count (7.4 boxes at a tolerance of
 * 25% of the smaller box) but leaves mean purity at 0.41 and the largest box
 * at 9.1% — it packs in more of the same bad boxes, and reintroduces exactly
 * the visibly-crossing outlines overlap suppression exists to prevent.
 */
export function boundaryDrawPriority(occupancy: BoundaryOccupancy, weight: number): number {
  return weight * boundaryPurity(occupancy);
}

/**
 * Decides which boundary rects in one priority-ordered batch are actually
 * safe to draw so no two drawn rects visibly overlap on screen. `entries`
 * must already be in priority order (earlier wins a contested overlap) —
 * graph-canvas.tsx feeds this `boundaryDrawPriority` order, so the boxes
 * that most honestly delimit their own cluster claim territory first. That
 * ordering is load-bearing, not cosmetic: this pass is greedy, so the first
 * entry to claim a region silently erases every later one touching it.
 * Feeding it raw cluster weight (as this did before) gives the first pick to
 * the most sprawling box on screen — see boundaryDrawPriority.
 *
 * This exists because the anchor forces that position cluster members are
 * deliberately weak relative to collide/link (see engine.ts), so clusters
 * routinely end up spatially interleaved rather than cleanly separated —
 * and even a much stronger anchor pull can't fully fix that on its own:
 * clusters sit on a ring as angular wedges, and adjacent wedges'
 * axis-aligned bounding boxes overlap near the ring's center purely as a
 * geometry artifact of "smallest rect containing a wedge," independent of
 * how tightly each wedge's members are pulled together. Suppressing the
 * draw of a losing rect is what actually guarantees the rendered picture
 * never shows two overlapping boundary boxes, regardless of layout.
 *
 * `alwaysDrawId` (typically the selected cluster/collection) is exempt from
 * suppression — its own boundary should never vanish just because something
 * else was drawn first. A single id covers the common case; a caller with
 * more than one independent, simultaneously-active selection (e.g. a
 * selected Category/Subcategory cluster AND a separately selected
 * Collection) passes a `Set` instead so neither one can suppress the other.
 * `null` means nothing is exempt.
 *
 * `isExemptOverlap`, when given, lets the caller mark specific pairs as
 * *intentionally* nested (e.g. a Subcategory rect inside its own parent
 * Category rect) rather than the unintended sibling/cross-cluster overlap
 * this function otherwise guards against — an exempt pair never blocks
 * either member from being drawn, in either direction, regardless of which
 * one comes first in `entries`. Omitted (the default), every pair in the
 * batch is treated as mutually exclusive, unchanged from before this
 * parameter existed — so a same-tier-only caller needs no changes.
 *
 * `maxAmbient`, when given, caps how many non-always-drawn entries this call
 * can add to the result, regardless of whether they'd otherwise pass the
 * overlap check. Exists because overlap suppression alone doesn't scale: on
 * a real dense workspace (measured: 570 tabs, 50 real categories from
 * per-domain "collective clustering" — see clusters.ts/pipeline.ts) the ring
 * layout packs dozens of candidate boxes into overlapping territory near its
 * center as a geometry artifact, independent of how well-separated the
 * underlying data actually is (confirmed empirically: neither more anchor
 * spacing nor trimming outlier members meaningfully changed the count) — so
 * an uncapped pass ends up silently keeping only 1-6 of 30-60 legitimate,
 * concentration-passing candidates, in a somewhat arbitrary order driven by
 * which ones happen not to conflict. A bounded ambient set is an honest,
 * predictable "top N by weight" instead. Always-drawn entries are exempt
 * from the cap the same way they're exempt from overlap suppression — a
 * deliberate selection must never vanish for being outside the top N.
 * `undefined` (the default) means no cap, unchanged from before this
 * parameter existed.
 *
 * An always-drawn entry is never merely skipped past a conflict: if it
 * overlaps a non-exempt rect already drawn earlier (lower priority, but
 * processed first), that earlier rect is EVICTED from the result so the
 * always-drawn one never ends up visibly crossing it — "selected boundaries
 * must remain visible" would otherwise be satisfied at the cost of the
 * "unrelated boundaries must never visually cross" guarantee, which this
 * function exists to uphold unconditionally. An already-drawn rect that is
 * itself always-drawn is never evicted this way (two independently selected
 * ids — e.g. a selected cluster and a separately selected collection — are
 * each exempt from suppressing the other; see `alwaysDrawId`'s own doc
 * above), so two simultaneous selections can still cross each other, but a
 * selection can never force an uninvolved bystander to cross it.
 */
export function selectNonOverlappingRects(
  entries: { id: string; rect: CollectionBoundaryRect }[],
  alwaysDrawId: string | ReadonlySet<string> | null,
  isExemptOverlap?: (a: string, b: string) => boolean,
  maxAmbient?: number
): Set<string> {
  const isAlwaysDraw = (id: string): boolean =>
    alwaysDrawId !== null && (typeof alwaysDrawId === "string" ? id === alwaysDrawId : alwaysDrawId.has(id));
  let drawn: { id: string; rect: CollectionBoundaryRect }[] = [];
  const result = new Set<string>();
  let ambientCount = 0;
  for (const { id, rect } of entries) {
    const alwaysDraw = isAlwaysDraw(id);
    if (!alwaysDraw && maxAmbient !== undefined && ambientCount >= maxAmbient) continue;
    const conflicts = drawn.filter(
      (existing) => !isExemptOverlap?.(existing.id, id) && rectsOverlap(existing.rect, rect)
    );
    if (alwaysDraw) {
      for (const conflict of conflicts) {
        if (!isAlwaysDraw(conflict.id)) {
          result.delete(conflict.id);
          ambientCount--;
        }
      }
      const evictedIds = new Set(conflicts.filter((c) => !isAlwaysDraw(c.id)).map((c) => c.id));
      drawn = drawn.filter((d) => !evictedIds.has(d.id));
      result.add(id);
      drawn.push({ id, rect });
    } else if (conflicts.length === 0) {
      result.add(id);
      drawn.push({ id, rect });
      ambientCount++;
    }
  }
  return result;
}
