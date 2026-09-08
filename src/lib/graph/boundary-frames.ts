/**
 * Territories: the ground a boundary square is allowed to move.
 *
 * A boundary square has no geometry of its own — it is the padded bounding
 * box of its members (see collection-layout.ts's computeCollectionBoundary),
 * so its width and height are decided entirely by where its members are.
 * That makes "how big is this square" the same question as "how far apart
 * can its members get", and the layout already answers it: packed2d gives
 * every category a confinement disc and every subcategory a sub-disc inside
 * it (see cluster-regions.ts), and engine.ts's confineToRegions holds each
 * tab inside its own. A square over a confined cluster therefore cannot be
 * bigger than that cluster's disc, plus padding.
 *
 * It cannot, that is, unless something moves a cluster's members *apart*.
 * That is exactly what the boundary layer used to do: it translated one
 * body's members rigidly while giving each moved tab its own displacement of
 * its confinement disc, so a body that enclosed only PART of some other
 * cluster carried that part away and left the rest behind — permanently,
 * since each tab's territory had followed it. The abandoned cluster's
 * bounding box then spanned the gap, which is the "stretched square"
 * corruption. Measured on a 300-tab / 10-category / 7-collection fixture,
 * 1500 frames, no user input at all: category boxes settled at 316x314 with
 * the boundary layer off, and at 1935x645 with it on, with 238 of 300 tabs
 * ending up outside the disc they were supposed to be confined to (worst
 * overshoot 1450px).
 *
 * A frame is the fix's unit of movement. Each one owns a confinement disc,
 * the tabs held inside it, and how far that disc has been carried. The rule
 * the engine enforces on top of them is:
 *
 *   a boundary body may move only WHOLE frames.
 *
 * A body that would have to split a frame — a Collection cutting across
 * three categories, say — is not a rigid body at all: it is still drawn,
 * hit-tested and selectable, it just cannot be shoved around, because there
 * is no way to shove it that doesn't tear a cluster in half.
 *
 * Nothing here knows about physics, rendering or React; it is pure data
 * about which tabs share ground.
 */
import type { ClusterRegion } from "./cluster-regions";
import type { ClusterAnchorAssignment } from "./clusters";

export type FrameOffset = { dx: number; dy: number };

export type BoundaryFrame = {
  id: string;
  /** The confinement disc, as the layout placed it — never mutated. */
  region: ClusterRegion;
  /** The frame this one is nested inside (a subcategory's category), if any. */
  parentId: string | null;
  /** Tabs confined directly to this frame's own disc. */
  ownTabs: Set<string>;
  /** `ownTabs` plus every descendant frame's — the whole territory. */
  allTabs: Set<string>;
  /** How far the disc has been carried by boundary moves. Mutated in place. */
  offset: FrameOffset;
};

export type BoundaryFrames = {
  byId: Map<string, BoundaryFrame>;
  /** Which frame each tab is confined to. Absent = untethered (no confinement). */
  frameOfTab: Map<string, string>;
};

export function emptyBoundaryFrames(): BoundaryFrames {
  return { byId: new Map(), frameOfTab: new Map() };
}

/**
 * The name of a territory, for an assignment that carries a disc but no
 * `confineToId`.
 *
 * A territory IS its disc, so the disc's own geometry is a sound identity for
 * it: two tabs confined to the same disc are on the same ground whatever the
 * caller chose to call it. This keeps hand-built assignments (tests, and any
 * caller predating `confineToId`) grouping correctly instead of silently
 * degrading to one-tab-per-territory, which would make every body look like
 * it was splitting something.
 */
function regionKey(region: ClusterRegion): string {
  return `@${region.x}:${region.y}:${region.r}`;
}

/**
 * Rebuilds the frame set from the current cluster anchors, restricted to the
 * tabs actually in the simulation.
 *
 * `previous`, when given, carries each frame's accumulated offset across the
 * rebuild — the cluster tree is recomputed whenever tabs change, and a move
 * the user made must not be undone by a tab being added somewhere else.
 */
export function buildBoundaryFrames(
  assignments: ReadonlyMap<string, ClusterAnchorAssignment>,
  presentTabIds: Iterable<string>,
  previous?: BoundaryFrames
): BoundaryFrames {
  const byId = new Map<string, BoundaryFrame>();
  const frameOfTab = new Map<string, string>();

  const ensure = (id: string, region: ClusterRegion, parentId: string | null): BoundaryFrame => {
    const existing = byId.get(id);
    if (existing) {
      // A parent frame can be discovered either directly (a tab confined to
      // it) or via a child's `confineWithinId`; whichever arrives second must
      // not clear the link the first one established.
      if (existing.parentId === null && parentId !== null) existing.parentId = parentId;
      return existing;
    }
    const carried = previous?.byId.get(id)?.offset;
    const frame: BoundaryFrame = {
      id,
      region,
      parentId,
      ownTabs: new Set(),
      allTabs: new Set(),
      offset: { dx: carried?.dx ?? 0, dy: carried?.dy ?? 0 },
    };
    byId.set(id, frame);
    return frame;
  };

  for (const tabId of presentTabIds) {
    const assignment = assignments.get(tabId);
    const region = assignment?.confineTo;
    // No disc means "not confined" — a tab the layout never reserved ground
    // for (ring mode, or a tab missing from the cluster tree). It belongs to
    // no territory and tears nothing.
    if (!region) continue;
    const frameId = assignment.confineToId ?? regionKey(region);

    const parentRegion = assignment.confineWithin ?? null;
    const parentId = parentRegion ? (assignment.confineWithinId ?? regionKey(parentRegion)) : null;
    if (parentRegion && parentId) ensure(parentId, parentRegion, null);

    const frame = ensure(frameId, region, parentId);
    frame.ownTabs.add(tabId);
    frameOfTab.set(tabId, frameId);
  }

  // allTabs: own tabs, plus every descendant's. The nesting is at most two
  // deep (category → subcategory), so one pass upward is enough.
  for (const frame of byId.values()) {
    for (const tabId of frame.ownTabs) frame.allTabs.add(tabId);
  }
  for (const frame of byId.values()) {
    if (!frame.parentId) continue;
    const parent = byId.get(frame.parentId);
    if (!parent) continue;
    for (const tabId of frame.ownTabs) parent.allTabs.add(tabId);
  }

  // An empty frame (every one of its tabs has left the graph) is not ground
  // any more — keeping it would let a body "cover" it vacuously.
  for (const [id, frame] of [...byId]) if (frame.allTabs.size === 0) byId.delete(id);

  return { byId, frameOfTab };
}

/**
 * Whether `memberIds` can be translated as one rigid piece, and which frames
 * that translation would carry.
 *
 * `ok` is false as soon as one frame is only PARTIALLY inside the member set:
 * moving then would separate tabs that share ground, which is the whole
 * failure mode this module exists to prevent. `frameIds` is every frame lying
 * wholly inside the member set — including a parent whose own tabs all live
 * in its children, so a category's disc travels with the subcategory discs
 * nested in it.
 */
export function rigidMove(
  frames: BoundaryFrames,
  memberIds: ReadonlySet<string>
): { ok: boolean; frameIds: string[] } {
  // Counted rather than scanned: walking up from each member tab visits only
  // the frames this body actually touches, so the check costs one pass over
  // the body's members instead of one over every territory in the graph. It
  // runs for every square on every animation frame.
  const held = new Map<string, number>();
  for (const tabId of memberIds) {
    let frameId = frames.frameOfTab.get(tabId);
    // An untethered tab has no ground to split, so it never blocks a move.
    while (frameId !== undefined && frameId !== null) {
      held.set(frameId, (held.get(frameId) ?? 0) + 1);
      frameId = frames.byId.get(frameId)?.parentId ?? undefined;
    }
  }

  const frameIds: string[] = [];
  const moved = new Set<string>();
  for (const [frameId, count] of held) {
    const frame = frames.byId.get(frameId);
    if (!frame || frame.allTabs.size === 0) continue;
    if (count < frame.allTabs.size) continue;
    frameIds.push(frameId);
    moved.add(frameId);
  }

  // Every confined member must be travelling with its own disc. A member
  // whose disc stays behind would be pulled straight back out of the square
  // by confineToRegions — and, worse, would be held apart from the tabs it
  // shares that disc with, which is the split this whole rule exists to stop.
  //
  // A partly-covered PARENT is fine and deliberately allowed: dragging one
  // subcategory does not need to carry its whole category, because the
  // sub-disc is clamped to stay inside the category's own disc either way
  // (see clampFramesWithinParents), so the category's box stays bounded.
  for (const tabId of memberIds) {
    const frameId = frames.frameOfTab.get(tabId);
    if (frameId === undefined) continue;
    if (!moved.has(frameId)) return { ok: false, frameIds: [] };
  }

  return { ok: true, frameIds };
}

/**
 * Keeps every nested frame's displaced disc inside its parent's displaced
 * disc, and reports whether anything had to be pulled back.
 *
 * This is what bounds a CATEGORY's boundary box when one of its
 * subcategories is dragged. The subcategory move is legitimate — it carries
 * a whole frame — but nothing else stops it carrying that frame clear across
 * the graph, and the parent category's box, which is the bounding box over
 * all of its subcategories, would stretch to follow. Clamping the offset (as
 * opposed to clamping the drawn rect) keeps the collider, the drawn square
 * and the tabs' actual confinement in agreement, because all three are
 * derived from the same disc.
 */
export function clampFramesWithinParents(frames: BoundaryFrames): boolean {
  let clamped = false;
  for (const frame of frames.byId.values()) {
    if (!frame.parentId) continue;
    const parent = frames.byId.get(frame.parentId);
    if (!parent) continue;
    const slack = Math.max(0, parent.region.r - frame.region.r);
    const dx = frame.region.x + frame.offset.dx - (parent.region.x + parent.offset.dx);
    const dy = frame.region.y + frame.offset.dy - (parent.region.y + parent.offset.dy);
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance <= slack) continue;
    const scale = slack / distance;
    frame.offset.dx = parent.region.x + parent.offset.dx + dx * scale - frame.region.x;
    frame.offset.dy = parent.region.y + parent.offset.dy + dy * scale - frame.region.y;
    clamped = true;
  }
  return clamped;
}

/** Adds `(dx, dy)` to the named frames' offsets. Non-finite deltas are ignored rather than poisoning a disc. */
export function translateFrames(frames: BoundaryFrames, frameIds: readonly string[], dx: number, dy: number): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  for (const id of frameIds) {
    const frame = frames.byId.get(id);
    if (!frame) continue;
    frame.offset.dx += dx;
    frame.offset.dy += dy;
  }
}

/**
 * Where a territory actually sat, given per-tab displacements that may
 * disagree — the largest group of tabs that agree, not the mean of all of
 * them.
 *
 * The mean is the wrong repair, and provably so. A category torn in half by
 * the old per-tab displacement (say 40 tabs at home and 3 carried 3200px
 * away, which is the exact shape found in a real saved workspace) has a mean
 * of +223: a position NO tab was ever at, which moves all 43 of them and puts
 * the cluster somewhere the user never left it. The tear was produced by the
 * boundary layer shoving a slice of the cluster, not by a deliberate move, so
 * the tabs that did NOT move are the record of where the cluster belongs.
 * Taking the largest agreeing group keeps the majority exactly where it is
 * and brings the strays back to them, which is both the smaller visual change
 * and the better guess at intent. Where the whole territory was legitimately
 * dragged, every sample agrees and the group is all of them, so a real move
 * is restored exactly.
 *
 * "Agree" is within the disc's own radius: two displacements closer together
 * than the territory is wide describe the same territory position, and the
 * difference is settle noise. Ties break toward the SMALLEST displacement, so
 * an evenly split tear resolves toward home rather than arbitrarily, and the
 * result never depends on map iteration order.
 *
 * Idempotent by construction: run it on its own output and every sample is
 * identical, so there is one group and its mean is that same value.
 */
export function consensusOffset(samples: readonly FrameOffset[], discRadius: number): FrameOffset | null {
  if (samples.length === 0) return null;
  const tolerance = Math.max(1, Number.isFinite(discRadius) ? discRadius : 1);

  let best: { count: number; magnitude: number; dx: number; dy: number } | null = null;
  for (const candidate of samples) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const other of samples) {
      if (Math.hypot(other.dx - candidate.dx, other.dy - candidate.dy) > tolerance) continue;
      sumX += other.dx;
      sumY += other.dy;
      count++;
    }
    const dx = sumX / count;
    const dy = sumY / count;
    const magnitude = Math.hypot(dx, dy);
    if (best && (count < best.count || (count === best.count && magnitude >= best.magnitude))) continue;
    best = { count, magnitude, dx, dy };
  }
  return best ? { dx: best.dx, dy: best.dy } : null;
}

/**
 * Folds per-tab offsets — the shape this displacement was persisted in
 * before frames existed, and still is (see GraphPersistedState.boundaryOffsets)
 * — back into whole-frame offsets.
 *
 * A frame takes the CONSENSUS of its own tabs' saved offsets — see
 * `consensusOffset` for why the largest agreeing group, and not their mean,
 * is the right reading of a torn record. On state written by a build that
 * moved tabs individually those offsets disagree, and that disagreement IS
 * the saved corruption: the tabs were being held apart across reloads. Where
 * they agree (everything written by a build with frames) the consensus is
 * that shared value, so a legitimate saved move is restored exactly.
 *
 * Only frames with no live offset are seeded, mirroring the engine's existing
 * "a move made this session always wins over saved state" rule.
 */
export function adoptPersistedOffsets(
  frames: BoundaryFrames,
  perTabOffsets: ReadonlyMap<string, FrameOffset>
): void {
  for (const frame of frames.byId.values()) {
    if (frame.offset.dx !== 0 || frame.offset.dy !== 0) continue;
    // `ownTabs`, not `allTabs`: a tab inside a subcategory carries that
    // SUBCATEGORY's displacement, and folding it into the parent category
    // would shift the parent's disc by a move that was never the parent's.
    //
    // A tab with no saved offset is a tab that was never displaced, which is
    // a (0, 0) SAMPLE, not a missing one — skipping it would let the handful
    // of tabs a bad build happened to carry away outvote the majority that
    // stayed home.
    const samples: FrameOffset[] = [];
    for (const tabId of frame.ownTabs) {
      const offset = perTabOffsets.get(tabId);
      if (!offset) {
        samples.push({ dx: 0, dy: 0 });
        continue;
      }
      if (!Number.isFinite(offset.dx) || !Number.isFinite(offset.dy)) continue;
      samples.push(offset);
    }
    const consensus = consensusOffset(samples, frame.region.r);
    if (!consensus) continue;
    frame.offset.dx = consensus.dx;
    frame.offset.dy = consensus.dy;
  }

  // A category whose every tab lives in a subcategory has no own tabs to read
  // a displacement from, but it still owns the disc its children are kept
  // inside — left at the origin while its children were restored somewhere
  // else, the containment clamp would drag them straight back. It follows its
  // children instead.
  const childOffsets = new Map<string, FrameOffset[]>();
  for (const frame of frames.byId.values()) {
    if (!frame.parentId) continue;
    const list = childOffsets.get(frame.parentId);
    if (list) list.push(frame.offset);
    else childOffsets.set(frame.parentId, [frame.offset]);
  }
  for (const frame of frames.byId.values()) {
    if (frame.ownTabs.size > 0) continue;
    if (frame.offset.dx !== 0 || frame.offset.dy !== 0) continue;
    const children = childOffsets.get(frame.id);
    if (!children || children.length === 0) continue;
    const consensus = consensusOffset(children, frame.region.r);
    if (!consensus) continue;
    frame.offset.dx = consensus.dx;
    frame.offset.dy = consensus.dy;
  }
}
