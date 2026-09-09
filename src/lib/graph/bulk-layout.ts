/**
 * Deterministic initial placement for tabs that have no position yet.
 *
 * WHY THIS EXISTS. `createGraphSimulation`'s `setNodes` used to seed every
 * brand-new node at `anchor + 24 * random()` — a 24px disc around its
 * category's anchor point. For one new tab that is fine. For a bulk dump it
 * is a bomb: a 42-tab category arrives with all 42 nodes inside a 24px disc,
 * while `forceCollide` wants them 36px apart (NODE_MIN_EDGE_GAP) and
 * `forceManyBody(-260)` grows without bound as separation approaches zero.
 * Measured on the real 283-tab export, cold: the FIRST tick after a bulk
 * insert moved one node 424px and every node 168px on average, at speeds up
 * to 161 world units per frame. That single frame is the "hundreds of nodes
 * exploding outward" — everything after it is the graph slowly recovering
 * from an initial condition it should never have been given.
 *
 * The fix is not damping (damping cannot un-stack coincident nodes, it only
 * slows down the un-stacking) — it is to never stack them. `packCluster`
 * lays a cluster's newcomers out on a sunflower (Vogel) spiral at collide
 * spacing, which is a near-optimal disc packing, so the very first frame's
 * net force is already small. Same total footprint the layout would have
 * settled into anyway, reached by construction instead of by explosion.
 *
 * Everything here is PURE and DETERMINISTIC — index and cluster key in, point
 * out, no randomness at all (the per-cluster variation below is hashed, not
 * random). Two dumps of the same tabs produce byte-identical seeds, which is
 * what makes the layout reproducible across reloads and makes these properties
 * testable.
 */

export type SeedRegion = {
  x: number;
  y: number;
  /**
   * Radius of the cluster's territory, when known (see cluster-regions.ts's
   * `confinementRegion`). Used only as a soft preference: the packing is
   * grown to whatever radius the members actually need, so a region too
   * small for its members is honoured in position but not in size — better
   * an overflowing cluster than a stack of coincident nodes.
   */
  r?: number;
};

/**
 * The golden angle. Successive indices land at maximally-irrational angular
 * offsets, which is what makes the sunflower spiral fill a disc evenly
 * instead of forming spokes.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * The per-cluster variation of a sunflower packing: a whole-cluster rotation
 * plus a small per-point wobble.
 *
 * WHY. A sunflower spiral is a beautiful packing and a terrible SEED. It is
 * the same picture for every cluster — same spiral, same handedness, same
 * orientation — and the simulation it seeds is heavily damped and cools in
 * ~180 ticks, so a good part of what the user finally sees is the seed's
 * ghost. Two categories with the same number of tabs therefore settled into
 * visibly the same arrangement, which is a large part of what makes a graph
 * read as generated-by-formula rather than grown. It also means the
 * ARRANGEMENT carries a message it has no business carrying: index 0 always
 * at the middle, index n-1 always at the rim, in golden-angle order.
 *
 * The wobble is bounded well inside the spiral's own spacing, so nothing here
 * can stack two nodes on one point — the property this module exists for. And
 * it stays PURE AND DETERMINISTIC: everything is derived by hash from the
 * cluster's key and the point's index, never from Math.random, so two dumps
 * of the same tabs still produce byte-identical seeds.
 */
export type ClusterVariation = {
  /** Whole-cluster rotation, radians. Rigid, so it cannot change any separation. */
  rotation: number;
  /** Per-point offset, in MULTIPLES OF `spacing`: {radial, tangential}, each in [-JITTER, JITTER]. */
  offset: (index: number) => { radial: number; tangential: number };
};

const NO_VARIATION: ClusterVariation = {
  rotation: 0,
  offset: () => ({ radial: 0, tangential: 0 }),
};

/**
 * How far a point may be nudged, as a multiple of `spacing`.
 *
 * The bound is what makes the wobble safe, and it has to be stated in units
 * of SPACING rather than of the point's own radius: the spiral's neighbours
 * are ~`spacing` apart everywhere, so a jitter proportional to radius is
 * harmless at the centre and catastrophic at the rim (measured at 0.16 of
 * radius: a nearest-neighbour separation of 0.011 * spacing, i.e. two nodes
 * on the same point — exactly what this module exists to prevent).
 *
 * Two points can each move by at most `sqrt(2) * JITTER * spacing`, which
 * bounds the worst case at `1 - 2*sqrt(2)*JITTER` = 0.92 of `spacing`; swept
 * over 60 cluster keys and seven counts, the tightest pair the wobble actually
 * produces sits at 0.943. Deliberately modest: the wobble is texture, and the
 * variation that actually differentiates one cluster from another is the
 * rotation, which is rigid and therefore free.
 */
const JITTER = 0.03;

/** Small, pure, deterministic 32-bit hash — string in, [0,1) out. Never security-sensitive. */
function hashUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000003) / 1000003;
}

/** Hash to [-JITTER, JITTER]. */
function hashOffset(seed: string): number {
  return (hashUnit(seed) - 0.5) * 2 * JITTER;
}

/**
 * The variation for one cluster, keyed by anything stable about it. Same key
 * in, same variation out, forever.
 */
export function clusterVariation(key: string): ClusterVariation {
  return {
    rotation: hashUnit(`${key}#rot`) * Math.PI * 2,
    offset: (index) => ({
      radial: hashOffset(`${key}#r${index}`),
      tangential: hashOffset(`${key}#a${index}`),
    }),
  };
}

/**
 * Places `count` points inside a disc centred on `region`, in a sunflower
 * spiral with a nearest-neighbour separation of about `spacing`.
 *
 * `index` runs 0..count-1 and is the ONLY thing that varies — pass a stable
 * per-cluster index (see `buildBulkSeeds`) and the same tab always lands in
 * the same slot.
 */
export function packCluster(
  index: number,
  count: number,
  region: SeedRegion,
  spacing: number,
  /**
   * Anything stable that identifies THIS cluster — its key, its region — used
   * only to vary the packing's orientation and texture from one cluster to
   * the next. See `clusterVariation`. Omit and every cluster gets the same
   * canonical spiral, which is the old behaviour.
   */
  variation: ClusterVariation = NO_VARIATION
): { x: number; y: number } {
  if (count <= 1) return { x: region.x, y: region.y };
  const c = vogelScale(spacing);
  // +0.5 so index 0 isn't exactly at the centre, which would leave the
  // centre point with a full ring of neighbours at the same distance.
  const radius = c * Math.sqrt(index + 0.5);
  const angle = index * GOLDEN_ANGLE + variation.rotation;
  // The wobble is applied along the point's own radial/tangential axes and
  // measured in units of `spacing`, so it is the same physical size wherever
  // the point sits — texture, never a closed gap. See JITTER.
  const { radial, tangential } = variation.offset(index);
  const outX = Math.cos(angle);
  const outY = Math.sin(angle);
  return {
    x: region.x + outX * (radius + radial * spacing) - outY * tangential * spacing,
    y: region.y + outY * (radius + radial * spacing) + outX * tangential * spacing,
  };
}

/**
 * Vogel's model is `r = c * sqrt(i)`. Choosing `c = spacing / sqrt(pi)` gives
 * one point per `spacing^2` of area — but area per point is NOT
 * nearest-neighbour distance: a spiral at that density puts its closest pair
 * only 0.872 * spacing apart (measured, and constant for every count above 2).
 *
 * That 13% shortfall is not cosmetic when `spacing` is what forceCollide will
 * insist on, because it means a bulk arrival is seeded ALREADY overlapping and
 * has to be pushed apart by an alpha-scaled force that decays to nothing in
 * ~180 ticks. Dividing it out makes `spacing` mean what the parameter is
 * named for and what every caller wants: the distance between the closest two
 * points the packing produces.
 */
const VOGEL_NEAREST_NEIGHBOUR_RATIO = 0.872;
function vogelScale(spacing: number): number {
  return spacing / Math.sqrt(Math.PI) / VOGEL_NEAREST_NEIGHBOUR_RATIO;
}

/** The radius `packCluster` will actually reach for `count` points at `spacing`. */
export function packedRadius(count: number, spacing: number): number {
  if (count <= 1) return 0;
  return vogelScale(spacing) * Math.sqrt(count - 0.5);
}

/**
 * Seeds every id in `groups` — a map of "cluster key → the ids that need a
 * position" — laying each cluster out around its own region.
 *
 * Ids within a cluster are sorted, so the slot a tab gets depends only on
 * which tabs are in its cluster and not on the order they happened to arrive
 * in. Clusters with no region fall back to the world origin, spread over
 * separate rings by cluster key so two region-less clusters don't land on
 * top of each other.
 */
export function buildBulkSeeds(
  groups: Map<string, { ids: string[]; region: SeedRegion | undefined }>,
  spacing: number
): Map<string, { x: number; y: number }> {
  const seeds = new Map<string, { x: number; y: number }>();

  // Region-less clusters are pushed out onto their own concentric shells
  // around the origin — deterministic in cluster-key order — rather than all
  // packing over the same point.
  const orphanKeys = [...groups.keys()].filter((key) => !groups.get(key)!.region).sort();

  for (const [key, group] of groups) {
    const ids = [...group.ids].sort();
    if (ids.length === 0) continue;
    let region = group.region;
    if (!region) {
      const rank = orphanKeys.indexOf(key);
      const shell = packedRadius(ids.length, spacing) + spacing;
      const angle = rank * GOLDEN_ANGLE;
      const orbit = rank === 0 ? 0 : shell * (1 + rank * 0.6);
      region = { x: Math.cos(angle) * orbit, y: Math.sin(angle) * orbit };
    }
    // Keyed on the cluster, so every cluster's packing has its own orientation
    // and its own texture rather than all of them being the same spiral — see
    // clusterVariation.
    const variation = clusterVariation(key);
    ids.forEach((id, index) => {
      seeds.set(id, packCluster(index, ids.length, region!, spacing, variation));
    });
  }

  return seeds;
}
