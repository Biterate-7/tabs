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
  if (inside === 0 || ownTotal === 0) return true;

  const graphWideShare = ownTotal / occupants.length;
  const bar = Math.min(MAX_BOUNDARY_SHARE_BAR, graphWideShare * minConcentration);
  return ownInside / inside >= bar;
}

/**
 * Decides which boundary rects in one priority-ordered batch are actually
 * safe to draw so no two drawn rects visibly overlap on screen. `entries`
 * must already be in priority order (earlier wins a contested overlap) —
 * graph-canvas.tsx feeds this the cluster tree's existing weight-desc order,
 * so bigger/more populated clusters win over smaller ones.
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
