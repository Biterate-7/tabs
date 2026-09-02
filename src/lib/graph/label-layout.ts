export type LabelBox = { id: string; x: number; y: number; width: number; height: number; priority: number };

/**
 * Decides which of this frame's candidate cluster labels (category,
 * subcategory, collection) to actually draw, given only a few dozen
 * clusters at once — an O(k^2) pairwise overlap check is trivial at that
 * scale, consistent with this codebase's existing brute-force hit-testing
 * (see graph-canvas.tsx's hitTestNode/hitTestEdge, which do the same).
 *
 * A box overlapping an already-placed higher-priority box is suppressed
 * entirely for the frame rather than nudged/repositioned — a missing label
 * reads better than two overlapping, unreadable ones, and priority order
 * keeps the choice stable from frame to frame instead of flickering between
 * candidates.
 */
export function resolveLabelOverlaps(boxes: LabelBox[]): Set<string> {
  const sorted = [...boxes].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const placed: LabelBox[] = [];
  const suppressed = new Set<string>();

  for (const box of sorted) {
    const overlaps = placed.some(
      (p) => box.x < p.x + p.width && box.x + box.width > p.x && box.y < p.y + p.height && box.y + box.height > p.y
    );
    if (overlaps) suppressed.add(box.id);
    else placed.push(box);
  }

  return suppressed;
}
