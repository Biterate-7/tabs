/**
 * Development-time assertions on the graph's two sizes.
 *
 * The graph has exactly two things with dimensions, and each has exactly one
 * source of truth:
 *
 *   node   — a circle of `radius`, from node-size.ts's computeNodeRadius,
 *            clamped to [BASE_NODE_RADIUS, MAX_NODE_RADIUS]. Zoom multiplies
 *            it at paint time and never writes it back.
 *   square — the padded bounding box of its members, from
 *            collection-layout.ts's computeCollectionBoundary. Its members
 *            are confined to their cluster's disc (cluster-regions.ts), so a
 *            square over ONE disc cannot exceed that disc, plus padding.
 *
 * Neither is measured from the DOM, so neither can be contaminated by a
 * screen-space rect, a transform, or a viewport size. What CAN go wrong is
 * the second invariant: a square grows when its members are pulled apart, and
 * the historical bug was the boundary layer doing exactly that (see
 * boundary-frames.ts). These checks are how that shows up as a message
 * naming the cluster instead of as a rectangle someone has to notice.
 *
 * Development only, and rate-limited per subject: a violation repeats on
 * every animation frame, and a warning that floods the console is a warning
 * nobody reads. Nothing here runs in a production bundle.
 */
import type { ClusterAnchorAssignment } from "./clusters";
import type { CollectionBoundaryRect } from "./collection-layout";
import { BASE_NODE_RADIUS, MAX_NODE_RADIUS } from "./node-size";

const isDev = process.env.NODE_ENV !== "production";

/** Subjects already reported, so one wrong square costs one message, not one per frame. */
const reported = new Set<string>();

/**
 * How far over its budget a square has to be before it is reported.
 *
 * A square is its members' bounding box PLUS padding, and its members are
 * circles whose own radius pushes that box out a little further, so the exact
 * budget is a touch under the drawn rect even when everything is correct.
 * 1.25 clears that comfortably while still catching the real failure, which
 * ran 4-6x over — and, at its worst, four orders of magnitude over.
 */
const EXTENT_TOLERANCE = 1.25;

/**
 * Room for the fact that confinement is a partial pullback rather than a wall.
 *
 * engine.ts's confineToRegions moves a node half of its overshoot back per
 * tick and cancels only its outward radial velocity — deliberately, so members
 * settle inside their disc instead of piling against its rim. A settled layout
 * therefore rests with some members a little way outside, most visibly in a
 * two-tab cluster, whose disc is smaller than the spacing charge and collide
 * want between its members. Without this allowance the guard reports every
 * small cluster in a real workspace and stops being read.
 */
const CONFINEMENT_SETTLE_SLACK = 40;

/**
 * The largest a boundary square over `memberIds` may legitimately be, or null
 * when its members are spread over more than one confinement disc.
 *
 * Null is not a pass — it means "this square's size is a fact about the
 * LAYOUT, not about this square". A Collection cutting across three
 * categories genuinely encloses ground three categories wide, and no ceiling
 * on the square itself would be honest about that. Those squares are checked
 * by keeping the boundary layer from ever pulling a cluster apart in the
 * first place, not here.
 */
export function confinementBudget(
  memberIds: readonly string[],
  anchors: ReadonlyMap<string, ClusterAnchorAssignment>,
  padding: number
): number | null {
  let discId: string | null = null;
  let radius = 0;
  for (const id of memberIds) {
    const assignment = anchors.get(id);
    const region = assignment?.confineTo;
    if (!region) return null;
    const regionId = assignment?.confineToId ?? `@${region.x}:${region.y}:${region.r}`;
    if (discId === null) discId = regionId;
    else if (discId !== regionId) return null;
    // The OUTERMOST disc the member is inside. A subcategory's sub-disc is
    // what holds its members, but the guarantee the boundary layer actually
    // makes is against the parent category's disc — a sub-disc is only ever
    // clamped to stay inside that (see clampFramesWithinParents), so the
    // parent is the honest ceiling for both tiers. Measuring against the
    // sub-disc instead reports a category whose every tab happens to live in
    // one subcategory, which is a normal, correct layout.
    radius = Math.max(radius, assignment?.confineWithin?.r ?? region.r);
  }
  if (discId === null) return null;
  return radius * 2 + padding * 2 + MAX_NODE_RADIUS * 2 + CONFINEMENT_SETTLE_SLACK * 2;
}

/**
 * Reports a boundary square drawn larger than the disc its members are
 * confined to. No-op in production, and at most once per cluster per session.
 */
export function assertBoundaryWithinBudget(
  clusterId: string,
  label: string,
  rect: CollectionBoundaryRect,
  memberIds: readonly string[],
  anchors: ReadonlyMap<string, ClusterAnchorAssignment>,
  padding: number,
  context: { zoom: number; dragging: boolean; settling: boolean }
): void {
  if (!isDev) return;
  const budget = confinementBudget(memberIds, anchors, padding);
  const bad =
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width < 0 ||
    rect.height < 0 ||
    (budget !== null && Math.max(rect.width, rect.height) > budget * EXTENT_TOLERANCE);
  if (!bad) return;
  const key = `boundary:${clusterId}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[graph] boundary square "${label}" (${clusterId}) is ${Math.round(rect.width)}x${Math.round(rect.height)} ` +
      `at (${Math.round(rect.x)}, ${Math.round(rect.y)}) over ${memberIds.length} members, ` +
      `budget ${budget === null ? "n/a" : Math.round(budget)} — its members have been pulled outside their own ` +
      `confinement disc. zoom=${context.zoom.toFixed(2)} dragging=${context.dragging} settling=${context.settling}. ` +
      `See lib/graph/boundary-frames.ts.`
  );
}

/** Reports a node whose radius has left the one range node-size.ts is allowed to produce. */
export function assertNodeRadius(id: string, label: string, radius: number): void {
  if (!isDev) return;
  if (Number.isFinite(radius) && radius >= BASE_NODE_RADIUS && radius <= MAX_NODE_RADIUS) return;
  const key = `node:${id}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[graph] node "${label}" (${id}) has radius ${radius}, outside ` +
      `[${BASE_NODE_RADIUS}, ${MAX_NODE_RADIUS}] — something bypassed node-size.ts's clampNodeRadius.`
  );
}

/** Test hook: forget what has already been reported. */
export function resetDimensionGuard(): void {
  reported.clear();
}
