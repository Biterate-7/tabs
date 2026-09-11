import type { ClusterTree } from "./clusters";
import { NODE_MIN_EDGE_GAP } from "./engine";

/**
 * Category layout mode.
 *
 * "ring" is the original behaviour: every category gets a single anchor POINT
 * on one shared ring, pulled at by a deliberately weak spring. Measured on the
 * real 283-tab export, that leaves only 17% of tabs closer to their own
 * category's anchor than to some other category's, 32% kNN category locality,
 * and a mean category boundary purity of 0.18 — i.e. the categories do not
 * exist as places, so the boundary boxes drawn around them enclose mostly
 * unrelated nodes (worst drawn box: "Dafont", 12.5% of the viewport, 86% of
 * its contents foreign — the reported screenshot bug).
 *
 * "packed2d" gives every category a REGION instead: a disc sized from its
 * member count, packed into a compact blob, which its members are confined to.
 * Same export: 100% nearest-own, 97% kNN locality, 0.98 purity, worst drawn
 * box 0% foreign.
 *
 * Flip this one constant to revert; nothing else needs changing.
 */
export const CLUSTER_LAYOUT_MODE: "ring" | "packed2d" = "packed2d";

/** A category's reserved territory: members are confined inside this disc. */
export type ClusterRegion = { x: number; y: number; r: number };

/**
 * Empty space kept between neighbouring category discs.
 *
 * Not cosmetic. With discs merely touching, a node near its own disc's rim is
 * immediately adjacent to a foreign disc's nodes, which is what kNN locality
 * measures — packing with no gap scores 78% where gap 180 scores 100%. Beyond
 * ~180 the gain is exhausted (gap 260 also scores 100%) while the graph keeps
 * growing, which lengthens every cross-category edge.
 */
export const REGION_GAP = 180;

/**
 * Multiplier on a category disc's radius beyond the minimum that would hold
 * its members at collide spacing.
 *
 * This is the rim-artifact control. At 1.0 the disc is exactly big enough, so
 * charge keeps pressing members against the boundary and 5 of 17 measurable
 * categories end up rim-piled (crescent-shaped rather than filled). Slack lets
 * them settle inside: 1.3 -> 2 crescents, 1.5 -> 0, and 2.2 holds 0 crescents
 * with the rim share at 30% against a uniformly-filled-disc expectation of 36%.
 * It also, counter-intuitively, SHORTENS cross-category edges (2.32x baseline
 * vs 2.59x at scale 1.0): fatter discs pack into a rounder blob.
 */
export const REGION_DISC_SCALE = 2.2;

/**
 * Multiplier on a category disc's radius for the CONFINEMENT disc — the disc
 * its members are actually held inside, as opposed to REGION_DISC_SCALE above,
 * which sizes the territory the packer RESERVES for the category.
 *
 * These were the same number until members were measured against each other
 * rather than against their region. Inside a 2.2x-oversized disc nothing holds
 * a category together at range: charge(-260) reaches every same-category pair
 * (distanceMax 600), links only pull the pairs that happen to BE linked, and
 * the category anchor spring is deliberately weak — so a member with one or no
 * same-category link is pushed outward until confinement stops it, at the rim,
 * hundreds of pixels from the nearest tab it shares a category with. Measured
 * on the real 283-tab export: the farthest member sat 316px from its own
 * category's nearest other member (median 49px), 29 members were >100px away,
 * and 15 of 33 multi-member categories broke into two or more spatial groups
 * at a 100px single-linkage threshold — one tab visibly adrift from its own
 * category, which is the reported bug.
 *
 * Raising the anchor spring does NOT fix that (measured: 0.06 -> 0.45 moves the
 * worst member only 316px -> 291px and still leaves 15 of 33 categories split),
 * because a fixed-point spring competes against charge from the whole cluster
 * plus cross-category links that are far longer, hence far stronger, than it
 * is. Sizing the confinement disc to what the members actually need does fix
 * it: the same export at 1.0 has 0 of 33 categories split, a worst member 97px
 * from its nearest sibling, and 100% kNN category locality.
 *
 * Kept separate from REGION_DISC_SCALE rather than lowering that one, because
 * the two do different jobs and the 2.2x reservation is load-bearing: it is
 * what packs the discs into a well-spaced blob (see REGION_GAP), and lowering
 * it would move every category, i.e. redo the whole layout. Confining more
 * tightly inside an unchanged reservation only ADDS empty space between
 * categories — measured kNN locality 99% -> 100%, purity 0.99 -> 1.00.
 *
 * 1.0 is the tightest setting that leaves the layout uniformly filled rather
 * than rim-piled: the rim share sits at 36%, exactly the uniformly-filled-disc
 * expectation quoted above, with one category (Instagram, 42 tabs) mildly
 * annular. Looser reintroduces the bug (1.2 -> 3 of 33 categories split, worst
 * member 121px; 1.5 -> 11 of 33, 166px); tighter starts genuinely rim-piling
 * (0.9 -> 40% rim share, 2 crescent-shaped categories) for no cohesion gain.
 * The one cost is cross-category edge length, 186px -> 207px, the direct
 * consequence of pulling members away from their shared borders.
 */
export const REGION_CONFINE_DISC_SCALE = 1.0;

/**
 * The disc a category's members are actually held inside, given the territory
 * reserved for it by computeClusterRegions — same centre, radius rescaled from
 * REGION_DISC_SCALE to REGION_CONFINE_DISC_SCALE. Also the disc subcategory
 * regions start from, so a subcategory stays nested inside the part of its
 * parent that the parent's own members actually occupy — see
 * layoutSubcategories, which may grow it (never past `reserved`) when the
 * children need more ground than their parent's own members would.
 */
export function confinementRegion(reserved: ClusterRegion): ClusterRegion {
  return { ...reserved, r: (reserved.r / REGION_DISC_SCALE) * REGION_CONFINE_DISC_SCALE };
}

/** Matches engine.ts's collide spacing, so a disc sized from member count can actually hold them. */
const MEMBER_SPACING = NODE_MIN_EDGE_GAP;

/**
 * Radius that comfortably holds `weight` members at collide spacing, before
 * REGION_DISC_SCALE.
 *
 * This is the one density standard in the layout: at REGION_CONFINE_DISC_SCALE
 * 1.0 it is exactly the ground a category's own members are held in, so any
 * other cluster measured against it is being given the same room per tab that
 * a category gets. A disc sized by anything OTHER than its own member count
 * is how a cluster ends up over-dense — see layoutSubcategories.
 */
export function baseDiscRadius(weight: number): number {
  return Math.sqrt(Math.max(1, weight) / Math.PI) * MEMBER_SPACING + MEMBER_SPACING;
}

/**
 * Packs discs into a COMPACT BLOB around the origin, each one clearing every
 * other by at least `gap`.
 *
 * Deliberately not a ring. A ring leaves its entire centre empty, so the
 * graph's diameter is set by the ring rather than by its contents and every
 * cross-category edge has to traverse that void: measured on the real export,
 * ring packing costs 297px mean cross-category edge length against this
 * layout's 180px, for no gain in separation (kNN 96% vs 97%).
 *
 * Greedy largest-first: each disc takes the candidate position closest to the
 * origin that clears every disc already placed, with candidates sampled around
 * the placed discs so the result stays tangent-tight. Deterministic — discs
 * are ordered by radius then id, and nothing here is random — which matters
 * because the anchors must be stable across reloads (see computeClusterAnchors).
 */
function packDiscs(discs: readonly { id: string; r: number }[], gap: number): Map<string, ClusterRegion> {
  const ordered = [...discs].sort((a, b) => b.r - a.r || a.id.localeCompare(b.id));
  const placed: { id: string; x: number; y: number; r: number }[] = [];
  const regions = new Map<string, ClusterRegion>();

  for (const disc of ordered) {
    if (placed.length === 0) {
      const at = { x: 0, y: 0, r: disc.r };
      placed.push({ id: disc.id, ...at });
      regions.set(disc.id, at);
      continue;
    }

    let best: { x: number; y: number } | null = null;
    let bestDistance = Infinity;
    for (const anchor of placed) {
      const orbit = anchor.r + disc.r + gap;
      const steps = 64;
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const x = anchor.x + Math.cos(angle) * orbit;
        const y = anchor.y + Math.sin(angle) * orbit;
        let clear = true;
        for (const other of placed) {
          if (Math.hypot(x - other.x, y - other.y) < other.r + disc.r + gap - 0.5) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        const distance = Math.hypot(x, y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    }

    const at = { x: best?.x ?? 0, y: best?.y ?? 0, r: disc.r };
    placed.push({ id: disc.id, ...at });
    regions.set(disc.id, at);
  }

  return regions;
}

/** One disc per category, packed into a blob around the origin. */
export function computeClusterRegions(
  tree: ClusterTree,
  gap = REGION_GAP,
  discScale = REGION_DISC_SCALE
): Map<string, ClusterRegion> {
  return packDiscs(
    tree.roots.map((category) => ({ id: category.id, r: baseDiscRadius(category.weight) * discScale })),
    gap
  );
}

/**
 * Clear ground kept between neighbouring SUB-discs inside one category — the
 * subcategory-tier counterpart to REGION_GAP, and small for the same reason
 * that one is large: these discs share a category, so a member near the rim of
 * one is supposed to be near the next. One node-gap of empty space is enough
 * to keep two subsections' boundary squares from sharing an edge.
 */
export const SUB_REGION_GAP = NODE_MIN_EDGE_GAP;

/**
 * Empty ground a category keeps around its children's packed blob, as a
 * multiple of the blob's own radius.
 *
 * This is the room a subsection has to be DRAGGED in. A sub-disc is clamped to
 * stay inside its parent's (boundary-frames.ts's clampFramesWithinParents), so
 * one sized flush to its parent has zero slack and cannot be moved at all —
 * and a drag that cannot move anything is exactly the state that used to make
 * the dragged square sweep across the graph shoving its neighbours (see
 * engine.ts's stepBoundaryLayer). 1.25 leaves a quarter of the blob's radius
 * of travel in every direction while still nesting.
 */
const GROUND_SLACK = 1.25;

/**
 * Territory id suffix for the disc holding a category's DIRECT members — the
 * tabs filed under the category itself rather than any of its subsections.
 *
 * They need ground of their own once subsections are sized to what their
 * members actually need: sharing one disc with them, direct members settle
 * inside the subsection's square and make it read (and measure, via
 * collection-layout.ts's concentration gate) as a box full of other people's
 * tabs. A distinct id is what makes it a distinct TERRITORY, so the boundary
 * layer can move a subsection without dragging the category's loose tabs along
 * — and so buildBoundaryFrames never has to reconcile one frame id offered
 * with two different discs.
 */
export const OWN_MEMBERS_TERRITORY_SUFFIX = ":own";

export type SubcategorySpec = { id: string; weight: number };

export type CategoryGround = {
  /**
   * The disc every one of this category's discs is laid out inside, and
   * therefore the ground the whole category occupies. Never larger than the
   * territory the packer reserved for the category, so growing it can never
   * reach a neighbour.
   */
  ground: ClusterRegion;
  /** Where the category's DIRECT members live. Null when it has none. */
  own: ClusterRegion | null;
  /** Where each subcategory lives. */
  subcategories: Map<string, ClusterRegion>;
};

/**
 * Divides a category's ground between its direct members and its
 * subcategories.
 *
 * Every disc is sized from its OWN member count — `baseDiscRadius`, the same
 * density standard a whole category's members are held at — and they are then
 * packed into a blob, exactly as categories are packed into the graph. What
 * stood here instead sized a sub-disc as `min(1.32x what its members need,
 * 0.42x its parent's radius)`, and the second term binds as soon as a
 * subsection holds a meaningful share of its category: measured across fixture
 * shapes, a subsection was granted 0.43-0.64 of the radius its members need,
 * i.e. 2.4x to 5.3x over-density, and at 60 tabs the closest pair of nodes
 * settled 12px INSIDE each other. That is the "tabs collapse together and
 * jitter" half of the large-subsection drag bug: over-dense members leave
 * charge/collide and confineToRegions fighting every tick forever, and that
 * churn is then fed straight back into the drag through the body's own
 * bounding box.
 *
 * The ground grows with the children — a category holding two half-sized
 * subsections genuinely needs more room than one holding the same tabs
 * directly, since two non-overlapping discs can cover at most half of the disc
 * containing them — but never past the 2.2x territory computeClusterRegions
 * already reserved, which REGION_GAP keeps clear of every other category. When
 * even that is not enough the whole arrangement is scaled down uniformly, so
 * the crowding is shared rather than landing on whichever subsection happens
 * to be largest.
 *
 * A category with no subcategories is returned exactly as it came in — one
 * disc, `confined`, at the tuned REGION_CONFINE_DISC_SCALE — so the measured
 * single-tier layout is untouched by any of this.
 *
 * Deterministic: packDiscs orders by radius then id, and nothing here is
 * random (see computeClusterAnchors).
 */
export function layoutCategoryGround(
  categoryId: string,
  confined: ClusterRegion,
  reserved: ClusterRegion,
  ownWeight: number,
  subs: readonly SubcategorySpec[]
): CategoryGround {
  if (subs.length === 0) {
    return { ground: confined, own: ownWeight > 0 ? confined : null, subcategories: new Map() };
  }

  const ownId = `${categoryId}${OWN_MEMBERS_TERRITORY_SUFFIX}`;
  const desired = subs.map((sub) => ({ id: sub.id, r: baseDiscRadius(sub.weight) }));
  if (ownWeight > 0) desired.push({ id: ownId, r: baseDiscRadius(ownWeight) });

  // Packed at full size first, so "how much ground do these need" is measured
  // rather than estimated from a ring formula that assumes they are all the
  // same size. packDiscs grows the blob outward from its LARGEST disc, so the
  // result has to be re-centred on the blob itself before its radius is read —
  // measuring from the first disc's centre instead reads nearly the full
  // diameter as a radius, and the whole arrangement then gets scaled down to
  // fit ground it never needed.
  const packed = packDiscs(desired, SUB_REGION_GAP);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const region of packed.values()) {
    minX = Math.min(minX, region.x - region.r);
    maxX = Math.max(maxX, region.x + region.r);
    minY = Math.min(minY, region.y - region.r);
    maxY = Math.max(maxY, region.y + region.r);
  }
  const blobX = (minX + maxX) / 2;
  const blobY = (minY + maxY) / 2;

  let needed = 0;
  for (const region of packed.values()) {
    needed = Math.max(needed, Math.hypot(region.x - blobX, region.y - blobY) + region.r);
  }
  needed *= GROUND_SLACK;

  const groundR = Math.min(Math.max(confined.r, needed), reserved.r);
  const scale = needed > 0 ? Math.min(1, groundR / needed) : 1;

  const placed = new Map<string, ClusterRegion>();
  for (const [id, region] of packed) {
    placed.set(id, {
      x: confined.x + (region.x - blobX) * scale,
      y: confined.y + (region.y - blobY) * scale,
      r: region.r * scale,
    });
  }

  const subcategories = new Map<string, ClusterRegion>();
  for (const sub of subs) {
    const region = placed.get(sub.id);
    if (region) subcategories.set(sub.id, region);
  }
  return { ground: { x: confined.x, y: confined.y, r: groundR }, own: placed.get(ownId) ?? null, subcategories };
}
