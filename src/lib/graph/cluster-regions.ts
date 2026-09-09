import type { ClusterTree } from "./clusters";
import { NODE_MIN_EDGE_GAP } from "./engine";
import { BASE_NODE_RADIUS } from "./node-size";

/**
 * The per-member cell `baseDiscRadius` bills for. NOT the spacing collide
 * enforces — that is `2 * radius + NODE_MIN_EDGE_GAP`, larger by the two
 * bodies' own diameters. See REGION_CONFINE_DISC_SCALE, which is exactly the
 * ratio between the two, and which exists because conflating them is what made
 * every confinement disc too small for its own members.
 */
const MEMBER_SPACING = NODE_MIN_EDGE_GAP;

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
 * WHY IT IS NO LONGER 1.0. At 1.0 the disc is not "exactly big enough" — it
 * is too small, and the arithmetic says so. `baseDiscRadius` bills each member
 * for a MEMBER_SPACING (36px) cell at 100% packing efficiency, but the spacing
 * forceCollide actually enforces is `2 * nodeCollisionRadius`, i.e.
 * `2 * radius + 36` = 46px for the smallest node and 62px for the largest, and
 * circles only pack a disc to ~82% of its area. A 75-member category therefore
 * gets a 212px disc for contents that need at least 258px.
 *
 * A cluster that cannot fit inside its own disc does not merely overflow it —
 * it becomes it. Charge presses every member outward, confineToRegions stops
 * them all at the same radius, and the settled cluster is the disc: a
 * uniformly packed circle, identical to every other cluster's, with its
 * members crushed through each other because two POSITION writes (the
 * confinement projection, and the world centring this engine used to apply to
 * confined nodes) overpower an alpha-scaled collide. Measured on a
 * 300-tab/4-category fixture at 1.0: all four categories settled with their
 * outermost member at 212-213px against a 211.9px disc, aspect ratios
 * 0.96-0.99, and 256 pairs overlapping past their collide radius.
 *
 * So this is not a free parameter to taste — it is the correction factor from
 * the spacing baseDiscRadius assumes to the spacing collide enforces, and it
 * is computed below rather than typed in. At the resulting 1.41 the same
 * fixture settles with 6 overlapping pairs instead of 256, aspect ratios
 * spread 0.79-0.97, and no crescents; cohesion is unchanged (0 of 4 categories
 * split, worst member 69px from its nearest sibling against a 140px guard).
 *
 * Cohesion no longer leans on this disc anyway: engine.ts's cluster cohesion
 * force pulls every member toward its group's own LIVE CENTROID, which is the
 * thing the old note below was reaching for when it found that a fixed-point
 * anchor spring could not do the job — a centroid moves with the group, so the
 * spring never has to fight where the group has got to, only how far apart it
 * has spread.
 *
 * The historical note, kept because it is what this constant was tuned
 * against: at 1.0 the real 283-tab export had 0 of 33 categories split and a
 * worst member 97px from its nearest sibling, where the previous behaviour
 * (members spread across the whole 2.2x reservation, no cohesion force at all)
 * had 15 of 33 split and a worst member at 316px. Raising the anchor spring
 * did not fix that (0.06 -> 0.45 moved the worst member only to 291px),
 * because a fixed-point spring competes against charge from the whole cluster
 * plus cross-category links far longer, hence far stronger, than it is.
 *
 * Kept separate from REGION_DISC_SCALE rather than folded into it, because
 * the two do different jobs and the 2.2x reservation is load-bearing: it is
 * what packs the discs into a well-spaced blob (see REGION_GAP), and changing
 * it would move every category, i.e. redo the whole layout. Widening the
 * confinement disc inside an unchanged reservation moves nothing — 1.41 of the
 * base radius still sits far inside the 2.2 reserved for it, so the gap
 * between neighbouring categories is untouched.
 */
const COLLIDE_SPACING = 2 * BASE_NODE_RADIUS + NODE_MIN_EDGE_GAP;
/** Fraction of a disc's area equal circles actually occupy when packed into it. */
const CIRCLE_PACKING_DENSITY = 0.82;
export const REGION_CONFINE_DISC_SCALE =
  COLLIDE_SPACING / MEMBER_SPACING / Math.sqrt(CIRCLE_PACKING_DENSITY);

/**
 * The disc a category's members are actually held inside, given the territory
 * reserved for it by computeClusterRegions — same centre, radius rescaled from
 * REGION_DISC_SCALE to REGION_CONFINE_DISC_SCALE. Also the disc subcategory
 * regions are laid out within, so a subcategory stays nested inside the part of
 * its parent that the parent's own members actually occupy.
 */
export function confinementRegion(reserved: ClusterRegion): ClusterRegion {
  return { ...reserved, r: (reserved.r / REGION_DISC_SCALE) * REGION_CONFINE_DISC_SCALE };
}

/**
 * Radius that holds `weight` members at one MEMBER_SPACING cell each, before
 * REGION_DISC_SCALE. The unit the TERRITORY packer reserves in; what the
 * members actually need is this times REGION_CONFINE_DISC_SCALE.
 */
function baseDiscRadius(weight: number): number {
  return Math.sqrt(Math.max(1, weight) / Math.PI) * MEMBER_SPACING + MEMBER_SPACING;
}

/**
 * Packs one disc per category into a COMPACT BLOB around the origin.
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
export function computeClusterRegions(
  tree: ClusterTree,
  gap = REGION_GAP,
  discScale = REGION_DISC_SCALE
): Map<string, ClusterRegion> {
  const discs = tree.roots
    .map((category) => ({ id: category.id, r: baseDiscRadius(category.weight) * discScale }))
    .sort((a, b) => b.r - a.r || a.id.localeCompare(b.id));

  const placed: { id: string; x: number; y: number; r: number }[] = [];
  const regions = new Map<string, ClusterRegion>();

  for (const disc of discs) {
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

/**
 * Where a subcategory sits inside its parent category's region, and how much
 * room it gets. Subcategories are laid out on a small ring well inside the
 * parent disc so a subcategory's own boundary box lands INSIDE its parent's —
 * the one overlap the boundary renderer treats as intentional nesting rather
 * than as an unrelated crossing (see graph-canvas.tsx's isBoundaryParentChildPair).
 */
export function computeSubcategoryRegion(
  parent: ClusterRegion,
  index: number,
  siblingCount: number,
  weight: number
): ClusterRegion {
  const radius = Math.min(baseDiscRadius(weight) * REGION_DISC_SCALE * 0.6, parent.r * 0.42);
  if (siblingCount <= 1) return { x: parent.x, y: parent.y, r: radius };
  const orbit = Math.max(0, parent.r - radius) * 0.55;
  const angle = (index / siblingCount) * Math.PI * 2;
  return { x: parent.x + Math.cos(angle) * orbit, y: parent.y + Math.sin(angle) * orbit, r: radius };
}
