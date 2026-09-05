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

/** Matches engine.ts's collide spacing, so a disc sized from member count can actually hold them. */
const MEMBER_SPACING = NODE_MIN_EDGE_GAP;

/** Radius that comfortably holds `weight` members at collide spacing, before REGION_DISC_SCALE. */
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
