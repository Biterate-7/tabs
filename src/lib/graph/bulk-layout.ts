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
 * Everything here is PURE and DETERMINISTIC — index in, point out, no
 * randomness at all. Two dumps of the same tabs produce byte-identical
 * seeds, which is what makes the layout reproducible across reloads and
 * makes these properties testable.
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
  spacing: number
): { x: number; y: number } {
  if (count <= 1) return { x: region.x, y: region.y };
  // Vogel's model: r = c * sqrt(i). Choosing c = spacing / sqrt(pi) gives one
  // point per `spacing^2 * pi` of area, i.e. neighbours about `spacing` apart.
  const c = spacing / Math.sqrt(Math.PI);
  // +0.5 so index 0 isn't exactly at the centre, which would leave the
  // centre point with a full ring of neighbours at the same distance.
  const radius = c * Math.sqrt(index + 0.5);
  const angle = index * GOLDEN_ANGLE;
  return { x: region.x + Math.cos(angle) * radius, y: region.y + Math.sin(angle) * radius };
}

/** The radius `packCluster` will actually reach for `count` points at `spacing`. */
export function packedRadius(count: number, spacing: number): number {
  if (count <= 1) return 0;
  return (spacing / Math.sqrt(Math.PI)) * Math.sqrt(count - 0.5);
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
    ids.forEach((id, index) => {
      seeds.set(id, packCluster(index, ids.length, region!, spacing));
    });
  }

  return seeds;
}
