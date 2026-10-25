import type { GraphNodeKind, KnowledgeNode, Point } from "./types";

/**
 * The galaxy's geometry, shared by the layout (where things sit on the
 * plane), the particle field (where the dust of the arms lies) and the
 * renderer (how high above the plane things float, how relationships arc).
 *
 * ## Shape
 *
 * A two-armed spiral galaxy around one bright core: the scope being looked
 * at (all of the person's projects). The arms are logarithmic spirals,
 *
 *     θ(r) = ARM_PHASE + arm·π + WINDING · ln(r / ARM_ORIGIN)
 *
 * and projects are star clusters strung along them — related projects next
 * to each other on the same arm (layout.ts). Everything a project holds is
 * a star inside its cluster: one lobe per kind, like beside like, newest
 * nearest the cluster's heart. Clusters are drawn out a little along their
 * arm, as star-forming regions are.
 *
 * ## Depth
 *
 * The disc is thin. Hubs float a few units above or below it, and a
 * cluster's stars scatter around their hub's height, more the further out
 * they sit. Nothing here is stored: elevation is derived from ids and
 * positions, so the picture's depth is as stable as its layout.
 */

export type Point3 = { x: number; y: number; z: number };

/** FNV-1a over the id, as a number in [0, 1). */
export function hashUnit(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// ---------------------------------------------------------------- arms

/** The radius the arms are measured from: inside it is the core's bulge. */
export const ARM_ORIGIN = 20;
/** How tightly the arms wind: a pitch of about 34°, open like the reference galaxy's. */
export const WINDING = 1.5;
export const ARM_PHASE = 0.45;

/** The angle of arm `arm` (0 or 1) at radius `r`. */
export function armAngle(arm: number, r: number): number {
  return ARM_PHASE + arm * Math.PI + WINDING * Math.log(Math.max(ARM_ORIGIN, r) / ARM_ORIGIN);
}

export function armPoint(arm: number, r: number): Point {
  const angle = armAngle(arm, r);
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

/**
 * The direction a spiral of this galaxy's pitch runs through `at`, outward.
 * Every point lies on such a spiral, so a cluster anywhere is drawn out
 * along the arm it sits on (or would sit on).
 */
export function clusterAxis(at: Point): number {
  return Math.atan2(at.y, at.x) + Math.atan(WINDING);
}

// ---------------------------------------------------------------- clusters

export type FanKind = Exclude<GraphNodeKind, "project">;
/** The order kinds sit in around a cluster, so like is always beside like. */
export const FAN_KINDS: readonly FanKind[] = ["conversation", "source", "file", "note", "session"];
/** Where a cluster's first star sits, clear of its heart. */
export const CLUSTER_INNER = 14;
/** World area each item claims within its cluster (≈ 17 units between neighbours). */
const ITEM_AREA = 300;
/** Clusters are this much longer (along their arm) than wide; area is kept. */
const STRETCH = 1.3;
const ALONG = Math.sqrt(STRETCH);
const ACROSS = 1 / Math.sqrt(STRETCH);
const GOLDEN = 0.6180339887498949;
const PLASTIC = 0.7548776662466927;

export type SubFan = { kind: FanKind; start: number; width: number; count: number };

/** A lobe's reach for `count` items across an opening of `width` radians, before the stretch. */
export function fanLength(count: number, width: number): number {
  return Math.sqrt(CLUSTER_INNER * CLUSTER_INNER + (2 * Math.max(0, count) * ITEM_AREA) / Math.max(0.08, width));
}

/**
 * How a cluster is shared between its kinds: lobes in a fixed order round
 * the whole circle, each kind's share growing with the square root of what
 * it holds, so one conversation beside forty sources is still its own lobe.
 */
export function subFans(counts: ReadonlyMap<FanKind, number>): SubFan[] {
  const present = FAN_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0);
  const weights = present.map((kind) => Math.sqrt(counts.get(kind)!));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let start = -Math.PI;
  return present.map((kind, i) => {
    const width = (weights[i]! / total) * Math.PI * 2;
    const fan = { kind, start, width, count: counts.get(kind)! };
    start += width;
    return fan;
  });
}

/** How far a cluster with these counts reaches from its heart, stretch included. */
export function clusterReach(counts: ReadonlyMap<FanKind, number>): number {
  let longest = CLUSTER_INNER;
  for (const fan of subFans(counts)) longest = Math.max(longest, fanLength(fan.count, fan.width));
  return longest * ALONG;
}

/** The furthest any cluster of `count` items can reach, however its kinds are shared (Cauchy–Schwarz over five lobes). */
export function clusterBound(count: number): number {
  return Math.sqrt(CLUSTER_INNER * CLUSTER_INNER + (Math.sqrt(FAN_KINDS.length) * Math.max(0, count) * ITEM_AREA) / Math.PI) * ALONG;
}

/**
 * The `index`-th place in a lobe (0 nearest the heart): even by area, swept
 * across the lobe by the golden ratio and loosened by a second low-
 * discrepancy sequence, so a cluster reads as stars rather than a grid.
 */
export function clusterSlot(hub: Point, fan: SubFan, index: number): Point {
  const reach = fanLength(fan.count, fan.width);
  const t = (index + 0.5) / Math.max(1, fan.count);
  const loosen = 0.86 + 0.14 * ((index * PLASTIC) % 1);
  const r = Math.sqrt(CLUSTER_INNER * CLUSTER_INNER + t * (reach * reach - CLUSTER_INNER * CLUSTER_INNER)) * loosen;
  const angle = fan.start + ((index * GOLDEN) % 1) * fan.width;
  const lx = Math.cos(angle) * r * ALONG;
  const ly = Math.sin(angle) * r * ACROSS;
  const axis = clusterAxis(hub);
  return { x: hub.x + lx * Math.cos(axis) - ly * Math.sin(axis), y: hub.y + lx * Math.sin(axis) + ly * Math.cos(axis) };
}

// ---------------------------------------------------------------- depth

/** A hub's height above the galactic plane: a few units either side of it. */
export function hubElevation(projectNodeId: string): number {
  return (hashUnit(`${projectNodeId}/z`) - 0.5) * 16;
}

/** A node's place in 3D: its layout position on the plane, plus its derived elevation. */
export function worldPoint(node: Pick<KnowledgeNode, "id" | "kind" | "projectId">, positions: { get(id: string): Point | undefined }): Point3 | undefined {
  const p = positions.get(node.id);
  if (!p) return undefined;
  if (node.kind === "project") return { x: p.x, y: p.y, z: hubElevation(node.id) };
  const anchorId = node.projectId ? `p:${node.projectId}` : undefined;
  const anchor = anchorId ? positions.get(anchorId) : undefined;
  if (!anchor) return { x: p.x, y: p.y, z: (hashUnit(`${node.id}/z`) - 0.5) * 40 };
  const distance = Math.hypot(p.x - anchor.x, p.y - anchor.y);
  // A cluster is a swarm, not a plate: its stars sit above and below its heart, more so toward its edge.
  return { x: p.x, y: p.y, z: hubElevation(anchorId!) + (hashUnit(`${node.id}/z`) - 0.5) * (4 + distance * 0.24) };
}

/** The galaxy's radius: everything placed, with a margin, and never smaller than a galaxy needs to read as one. */
export function galaxyExtent(points: Iterable<Point>): number {
  let furthest = 0;
  for (const p of points) furthest = Math.max(furthest, Math.hypot(p.x, p.y));
  return Math.max(380, furthest * 1.1 + 40);
}

// ---------------------------------------------------------------- relationships

/**
 * The inner control points of a relationship between two stars. It lifts
 * gently out of the disc and bows to one side (always the same side for the
 * same relationship), so several between the same two places fan instead
 * of stacking.
 */
export function bridgeControls(a: Point3, b: Point3, edgeId: string): [Point3, Point3] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const lift = Math.min(140, distance * 0.13);
  const bow = (hashUnit(edgeId) - 0.5) * 0.36 * distance;
  const nx = -dy / distance;
  const ny = dx / distance;
  return [
    { x: a.x + dx * 0.28 + nx * bow, y: a.y + dy * 0.28 + ny * bow, z: a.z + (b.z - a.z) * 0.28 + lift },
    { x: a.x + dx * 0.72 + nx * bow, y: a.y + dy * 0.72 + ny * bow, z: a.z + (b.z - a.z) * 0.72 + lift },
  ];
}

/** The inner control points of a thread from a cluster's heart to one of its stars: nearly straight, a breath of lift. */
export function threadControls(a: Point3, b: Point3): [Point3, Point3] {
  const lift = Math.hypot(b.x - a.x, b.y - a.y) * 0.05;
  return [
    { x: a.x + (b.x - a.x) * 0.33, y: a.y + (b.y - a.y) * 0.33, z: a.z + (b.z - a.z) * 0.33 + lift },
    { x: a.x + (b.x - a.x) * 0.67, y: a.y + (b.y - a.y) * 0.67, z: a.z + (b.z - a.z) * 0.67 + lift },
  ];
}

/** A point on a cubic Bézier. */
export function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
