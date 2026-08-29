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
