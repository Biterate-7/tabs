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
  isExemptOverlap?: (a: string, b: string) => boolean
): Set<string> {
  const isAlwaysDraw = (id: string): boolean =>
    alwaysDrawId !== null && (typeof alwaysDrawId === "string" ? id === alwaysDrawId : alwaysDrawId.has(id));
  let drawn: { id: string; rect: CollectionBoundaryRect }[] = [];
  const result = new Set<string>();
  for (const { id, rect } of entries) {
    const conflicts = drawn.filter(
      (existing) => !isExemptOverlap?.(existing.id, id) && rectsOverlap(existing.rect, rect)
    );
    if (isAlwaysDraw(id)) {
      for (const conflict of conflicts) {
        if (!isAlwaysDraw(conflict.id)) result.delete(conflict.id);
      }
      const evictedIds = new Set(conflicts.filter((c) => !isAlwaysDraw(c.id)).map((c) => c.id));
      drawn = drawn.filter((d) => !evictedIds.has(d.id));
      result.add(id);
      drawn.push({ id, rect });
    } else if (conflicts.length === 0) {
      result.add(id);
      drawn.push({ id, rect });
    }
  }
  return result;
}
