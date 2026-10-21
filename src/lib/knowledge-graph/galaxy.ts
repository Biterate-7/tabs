import type { GraphNodeKind, KnowledgeNode, Point } from "./types";

/**
 * The galaxy's geometry, shared by the layout (where things sit on the
 * plane) and the renderer (how high above it they float, and how the
 * filaments between them curve).
 *
 * ## Shape
 *
 * At the centre is the core: the scope being looked at (all of the
 * person's projects). Every project is a hub around it, joined to it by a
 * spoke, and everything the project holds fans out from the hub *away* from
 * the core — a cone of filaments, one sub-fan per kind, each as long as
 * what it holds needs (area, not count, so a crowded fan is longer rather
 * than denser). Newest items sit nearest their hub.
 *
 * ## Depth
 *
 * Hubs float at their own heights around the core, and each fan rises (or,
 * for a few, falls) as it reaches outward, so the whole reads as a dome of
 * light over the galactic plane. Nothing here is stored: elevation is
 * derived from ids and positions, so the picture's depth is as stable as
 * its layout.
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

export type FanKind = Exclude<GraphNodeKind, "project">;
/** The order kinds sit in across a fan, so like is always beside like. */
export const FAN_KINDS: readonly FanKind[] = ["conversation", "source", "file", "note", "session"];
/** The whole fan's opening, in radians: a cone, not a disc. */
export const FAN_WEDGE = 1.25;
/** Where a fan's first item sits, clear of its hub. */
export const HUB_INNER = 36;
/** World area each item claims within its fan (≈ 26 units between neighbours). */
const ITEM_AREA = 680;
const GOLDEN = 0.6180339887498949;

/** A fan's reach for `count` items across an opening of `wedge` radians. */
export function fanLength(count: number, wedge = FAN_WEDGE): number {
  return Math.sqrt(HUB_INNER * HUB_INNER + (2 * Math.max(0, count) * ITEM_AREA) / Math.max(0.08, wedge));
}

/** The direction a hub's fan opens: straight out from the core. */
export function outwardAngle(anchor: Point, projectNodeId: string): number {
  if (Math.hypot(anchor.x, anchor.y) < 1) return hashUnit(`${projectNodeId}/out`) * Math.PI * 2;
  return Math.atan2(anchor.y, anchor.x);
}

export type SubFan = { kind: FanKind; start: number; width: number; count: number };

/**
 * How a project's fan is shared between its kinds: in a fixed order, each
 * kind's share growing with the square root of what it holds, so one
 * conversation beside forty sources is still visible as its own ray.
 */
export function subFans(counts: ReadonlyMap<FanKind, number>): SubFan[] {
  const present = FAN_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0);
  const weights = present.map((kind) => Math.sqrt(counts.get(kind)!));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let start = -FAN_WEDGE / 2;
  return present.map((kind, i) => {
    const width = (weights[i]! / total) * FAN_WEDGE;
    const fan = { kind, start, width, count: counts.get(kind)! };
    start += width;
    return fan;
  });
}

/** The reach of a project's whole fan: its longest sub-fan. */
export function reachOf(counts: ReadonlyMap<FanKind, number>): number {
  let longest = HUB_INNER;
  for (const fan of subFans(counts)) longest = Math.max(longest, fanLength(fan.count, fan.width));
  return longest;
}

/**
 * The `index`-th of a sub-fan's places (0 nearest the hub): even by area,
 * swept across the sub-fan by the golden ratio so the rays interleave.
 */
export function fanSlot(anchor: Point, outward: number, fan: SubFan, index: number): Point {
  const reach = fanLength(fan.count, fan.width);
  const t = (index + 0.5) / Math.max(1, fan.count);
  const r = Math.sqrt(HUB_INNER * HUB_INNER + t * (reach * reach - HUB_INNER * HUB_INNER));
  const lateral = (index * GOLDEN) % 1;
  // Narrow at the root, opening outward: the inner items keep near the fan's axis.
  const open = 0.6 + 0.4 * Math.min(1, (r - HUB_INNER) / 140);
  const centre = fan.start + fan.width / 2;
  const angle = outward + centre + (fan.start + lateral * fan.width - centre) * open;
  return { x: anchor.x + Math.cos(angle) * r, y: anchor.y + Math.sin(angle) * r };
}

/** A hub's height above the galactic plane: most float above it, a few below. */
export function hubElevation(projectNodeId: string, anchor: Point): number {
  const distance = Math.hypot(anchor.x, anchor.y);
  return (hashUnit(`${projectNodeId}/z`) * 1.15 - 0.3) * (50 + distance * 0.32);
}

/** How steeply a project's fan climbs as it reaches out (negative: it falls). */
export function fanSlope(projectNodeId: string): number {
  const u = hashUnit(`${projectNodeId}/slope`);
  return u < 0.2 ? -(0.15 + u * 1.2) : 0.18 + (u - 0.2) * 0.75;
}

/** A node's place in 3D: its layout position on the plane, plus its derived elevation. */
export function worldPoint(node: Pick<KnowledgeNode, "id" | "kind" | "projectId">, positions: { get(id: string): Point | undefined }): Point3 | undefined {
  const p = positions.get(node.id);
  if (!p) return undefined;
  if (node.kind === "project") return { x: p.x, y: p.y, z: hubElevation(node.id, p) };
  const anchorId = node.projectId ? `p:${node.projectId}` : undefined;
  const anchor = anchorId ? positions.get(anchorId) : undefined;
  if (!anchor) return { x: p.x, y: p.y, z: (hashUnit(`${node.id}/z`) - 0.5) * 60 };
  const distance = Math.hypot(p.x - anchor.x, p.y - anchor.y);
  // The fan is a cone, not a wedge: items spray above and below its axis, wider toward the tips.
  const drift = (hashUnit(`${node.id}/z`) - 0.5) * (6 + distance * 0.5);
  return { x: p.x, y: p.y, z: hubElevation(anchorId!, anchor) + distance * fanSlope(anchorId!) + drift };
}

/**
 * The inner control points of a filament from a hub to one of its items.
 * Every filament leaves along the fan's axis, so near the hub they run
 * together as one bright stem and only part as they near their items.
 */
export function stemControls(a: Point3, b: Point3, outward: number): [Point3, Point3] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const reach = distance * 0.36;
  const c1 = { x: a.x + Math.cos(outward) * reach, y: a.y + Math.sin(outward) * reach, z: a.z + (b.z - a.z) * 0.2 };
  const arrive = Math.atan2(dy, dx);
  const c2 = { x: b.x - Math.cos(arrive) * distance * 0.34, y: b.y - Math.sin(arrive) * distance * 0.34, z: b.z - (b.z - a.z) * 0.3 };
  return [c1, c2];
}

/** The inner control points of a spoke from the core to a hub: a shallow arc, rising. */
export function spokeControls(a: Point3, b: Point3): [Point3, Point3] {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const lift = distance * 0.06;
  return [
    { x: a.x + (b.x - a.x) * 0.33, y: a.y + (b.y - a.y) * 0.33, z: a.z + (b.z - a.z) * 0.2 + lift },
    { x: a.x + (b.x - a.x) * 0.68, y: a.y + (b.y - a.y) * 0.68, z: a.z + (b.z - a.z) * 0.62 + lift },
  ];
}

/**
 * The inner control points of a bridge — a relationship between two items,
 * usually across projects. Bridges arch up out of the dome and bow to one
 * side (always the same side for the same relationship), so several
 * between the same two places fan instead of stacking.
 */
export function bridgeControls(a: Point3, b: Point3, edgeId: string): [Point3, Point3] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const lift = Math.min(240, distance * 0.22);
  const bow = (hashUnit(edgeId) - 0.5) * 0.5 * distance;
  const nx = -dy / distance;
  const ny = dx / distance;
  return [
    { x: a.x + dx * 0.28 + nx * bow, y: a.y + dy * 0.28 + ny * bow, z: a.z + (b.z - a.z) * 0.28 + lift },
    { x: a.x + dx * 0.72 + nx * bow, y: a.y + dy * 0.72 + ny * bow, z: a.z + (b.z - a.z) * 0.72 + lift },
  ];
}

/** A point on a cubic Bézier. */
export function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
