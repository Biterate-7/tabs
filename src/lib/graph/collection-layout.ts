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
 * Decides which same-tier boundary rects (all Categories, or all
 * Subcategories within one draw pass) are actually safe to draw so no two
 * drawn rects visibly overlap on screen. `entries` must already be in
 * priority order (earlier wins a contested overlap) — graph-canvas.tsx feeds
 * this the cluster tree's existing weight-desc order, so bigger/more
 * populated clusters win over smaller ones.
 *
 * This exists because the anchor forces that position cluster members are
 * deliberately weak relative to collide/link (see engine.ts), so same-tier
 * clusters routinely end up spatially interleaved rather than cleanly
 * separated — and even a much stronger anchor pull can't fully fix that on
 * its own: clusters sit on a ring as angular wedges, and adjacent wedges'
 * axis-aligned bounding boxes overlap near the ring's center purely as a
 * geometry artifact of "smallest rect containing a wedge," independent of
 * how tightly each wedge's members are pulled together. Suppressing the
 * draw of a losing rect is what actually guarantees the rendered picture
 * never shows two overlapping boundary boxes, regardless of layout.
 *
 * `alwaysDrawId` (typically the selected cluster) is exempt from
 * suppression — its own boundary should never vanish just because something
 * else was drawn first.
 */
export function selectNonOverlappingRects(
  entries: { id: string; rect: CollectionBoundaryRect }[],
  alwaysDrawId: string | null
): Set<string> {
  const drawn: CollectionBoundaryRect[] = [];
  const result = new Set<string>();
  for (const { id, rect } of entries) {
    if (id === alwaysDrawId || !drawn.some((existing) => rectsOverlap(existing, rect))) {
      result.add(id);
      drawn.push(rect);
    }
  }
  return result;
}
