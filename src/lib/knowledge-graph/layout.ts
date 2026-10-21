import { FAN_WEDGE, fanLength, fanSlot, hashUnit, outwardAngle, reachOf, subFans } from "./galaxy";
import type { FanKind } from "./galaxy";
import type { KnowledgeGraph, KnowledgeNode, Point } from "./types";

export { hashUnit };

/**
 * Where everything sits: a galaxy of project hubs around one core.
 *
 * ## Shape
 *
 * The core sits at the origin. Projects are hubs on a ring around it, each
 * given a share of the circle that its fan needs and pushed out far enough
 * that neighbouring fans do not overlap at their tips. Projects that share
 * sources or sessions are placed side by side. Inside a project nothing is
 * simulated: each item takes a place in its kind's part of the fan (see
 * galaxy.ts), newest nearest the hub. Sessions saved for no project drift on
 * an outer orbit.
 *
 * ## Stability
 *
 * Deterministic: everything derives from ids, counts, dates and the
 * relationships, never from Math.random. Positions the person has already
 * seen are passed back in as `previous` and kept exactly; a new project
 * takes the widest gap between the hubs already there, and a new item the
 * free place in its fan nearest to where its rank would put it. Adding a
 * conversation never moves anything else.
 *
 * ## Cost
 *
 * Closed form throughout. The caller still steps the work in slices
 * (`step(ticks)`) so a large library never blocks a frame.
 */

export const LARGE_GRAPH = 1500;

/** Items placed per tick. */
const ITEMS_PER_TICK = 10;
/** The closest a hub sits to the core. */
const HUB_MIN = 150;
/** Space kept between neighbouring fans at their tips. */
const FAN_GAP = 36;

/** A node's drawn radius in world units. Small and precise; a hub grows gently with what it holds. */
export function nodeRadius(node: Pick<KnowledgeNode, "kind" | "size" | "tabCount">): number {
  switch (node.kind) {
    case "project":
      return 7 + Math.min(9, Math.sqrt(node.size ?? 0) * 1.3);
    case "session":
      return 2.9;
    case "conversation":
      return 2.7;
    default:
      return 2.3;
  }
}

/** The furthest any of a project's `itemCount` items can sit from its hub. */
export function territoryRadius(itemCount: number): number {
  return fanLength(itemCount, FAN_WEDGE / 5) + 26;
}

export type KnowledgeLayout = {
  /** Advances the layout; true once everything is placed. */
  step: (ticks: number) => boolean;
  positions: () => Record<string, Point>;
  /** How many ticks a full layout takes, for progress. */
  totalTicks: number;
};

function byMass(a: KnowledgeNode, b: KnowledgeNode): number {
  return (b.size ?? 0) - (a.size ?? 0) || b.at - a.at || (a.id < b.id ? -1 : 1);
}

export function createKnowledgeLayout(graph: KnowledgeGraph, previous: Readonly<Record<string, Point>> = {}): KnowledgeLayout {
  const projects = graph.nodes.filter((node) => node.kind === "project").sort(byMass);
  const kindCounts = new Map<string, Map<FanKind, number>>();
  const fans = new Map<string, KnowledgeNode[]>();
  const drifting: KnowledgeNode[] = [];
  for (const node of graph.nodes) {
    if (node.kind === "project") continue;
    if (!node.projectId) {
      drifting.push(node);
      continue;
    }
    const counts = kindCounts.get(node.projectId) ?? new Map<FanKind, number>();
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    kindCounts.set(node.projectId, counts);
    const key = `${node.projectId}|${node.kind}`;
    fans.set(key, [...(fans.get(key) ?? []), node]);
  }
  // Newest first along each fan: the newest sits nearest its hub.
  for (const list of fans.values()) list.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));

  const reach = (projectNodeId: string) => reachOf(kindCounts.get(projectNodeId.slice(2)) ?? new Map());
  const out: Record<string, Point> = {};
  const work = [...fans.entries()];
  const totalTicks = 1 + Math.ceil((graph.nodes.length - projects.length) / ITEMS_PER_TICK);
  let placedHubs = false;
  let fanIndex = 0;

  function placeFan([key, list]: [string, KnowledgeNode[]]) {
    const [projectId, kind] = key.split("|") as [string, FanKind];
    const anchor = out[`p:${projectId}`]!;
    const outward = outwardAngle(anchor, `p:${projectId}`);
    const fan = subFans(kindCounts.get(projectId)!).find((entry) => entry.kind === kind)!;
    const slots = list.map((_, index) => fanSlot(anchor, outward, fan, index));
    const taken = new Array<boolean>(slots.length).fill(false);
    const spacing = 12;
    // Remembered items stay exactly where they were and claim the slot they sit on.
    for (const node of list) {
      const remembered = previous[node.id];
      if (!remembered) continue;
      out[node.id] = remembered;
      let best = -1;
      let bestDistance = spacing;
      for (let i = 0; i < slots.length; i++) {
        const distance = Math.hypot(slots[i]!.x - remembered.x, slots[i]!.y - remembered.y);
        if (!taken[i] && distance < bestDistance) {
          best = i;
          bestDistance = distance;
        }
      }
      if (best >= 0) taken[best] = true;
    }
    // Newcomers take the free slot nearest the one their rank asks for.
    list.forEach((node, rank) => {
      if (out[node.id]) return;
      let best = -1;
      for (let offset = 0; offset < slots.length && best < 0; offset++) {
        for (const i of [rank - offset, rank + offset]) {
          if (i >= 0 && i < slots.length && !taken[i] && clearOf(slots[i]!, list, out, spacing)) {
            best = i;
            break;
          }
        }
      }
      // Every slot is crowded by remembered items: one more place just past the fan's tip.
      const at = best >= 0 ? slots[best]! : fanSlot(anchor, outward, { ...fan, count: list.length + rank + 1 }, list.length + rank);
      if (best >= 0) taken[best] = true;
      out[node.id] = at;
    });
  }

  function placeDrifting() {
    let bounds = 0;
    for (const project of projects) {
      const at = out[project.id]!;
      bounds = Math.max(bounds, Math.hypot(at.x, at.y) + reach(project.id));
    }
    for (const node of drifting) {
      if (previous[node.id]) {
        out[node.id] = previous[node.id]!;
        continue;
      }
      const unit = hashUnit(node.id);
      const angle = unit * Math.PI * 2;
      const distance = Math.max(HUB_MIN * 1.6, bounds + 90) + unit * 80;
      out[node.id] = { x: round(Math.cos(angle) * distance), y: round(Math.sin(angle) * distance) };
    }
  }

  return {
    totalTicks,
    step(ticks: number) {
      let budget = Math.max(1, ticks);
      if (!placedHubs) {
        Object.assign(out, placeHubs(projects, graph, reach, previous));
        placedHubs = true;
        budget -= 1;
      }
      let items = budget * ITEMS_PER_TICK;
      while (fanIndex < work.length && items > 0) {
        items -= work[fanIndex]![1].length;
        placeFan(work[fanIndex]!);
        fanIndex += 1;
      }
      if (fanIndex < work.length) return false;
      placeDrifting();
      return true;
    },
    positions() {
      const positions: Record<string, Point> = {};
      for (const node of graph.nodes) {
        const at = out[node.id];
        positions[node.id] = at ? { x: round(at.x), y: round(at.y) } : { x: 0, y: 0 };
      }
      return positions;
    },
  };
}

/** Runs a layout to the end in one go — for tests and small graphs. */
export function layoutKnowledgeGraph(graph: KnowledgeGraph, previous: Readonly<Record<string, Point>> = {}): Record<string, Point> {
  const layout = createKnowledgeLayout(graph, previous);
  while (!layout.step(50)) {
    // stepping
  }
  return layout.positions();
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

function clearOf(point: Point, list: readonly KnowledgeNode[], placed: Readonly<Record<string, Point>>, spacing: number): boolean {
  for (const node of list) {
    const at = placed[node.id];
    if (at && Math.hypot(at.x - point.x, at.y - point.y) < spacing) return false;
  }
  return true;
}

/** How far out a hub must sit for a fan of `reach` to fit a share of the circle `sector` radians wide. */
function hubDistance(reach: number, sector: number): number {
  const half = Math.min(Math.PI * 0.45, sector / 2);
  const tipHalfWidth = reach * Math.sin(FAN_WEDGE / 2) + FAN_GAP / 2;
  return Math.max(HUB_MIN, tipHalfWidth / Math.tan(half) - reach * Math.cos(FAN_WEDGE / 2) * 0.5);
}

/**
 * Hubs on a ring around the core. Seen for the first time, the ring is
 * shared out: projects go round in an order that keeps related ones
 * together, each taking an arc that grows with its fan, and sit as far out
 * as that arc needs. With some already placed, each newcomer takes the
 * middle of the widest gap left.
 */
function placeHubs(projects: readonly KnowledgeNode[], graph: KnowledgeGraph, reach: (id: string) => number, previous: Readonly<Record<string, Point>>): Record<string, Point> {
  const out: Record<string, Point> = {};
  if (projects.length === 0) return out;
  const known = projects.filter((project) => previous[project.id]);
  for (const project of known) out[project.id] = previous[project.id]!;
  const fresh = projects.filter((project) => !previous[project.id]);
  if (fresh.length === 0) return out;

  if (known.length === 0) {
    const order = ringOrder(projects, graph);
    const weights = order.map((project) => 0.35 + Math.sqrt(reach(project.id)) / 10);
    const total = weights.reduce((a, b) => a + b, 0);
    let angle = hashUnit(projects[0]!.id) * Math.PI * 2;
    order.forEach((project, index) => {
      const sector = (weights[index]! / total) * Math.PI * 2;
      const centre = angle + sector / 2;
      // Alternate neighbours in and out a little, so fans side by side sit at different depths.
      const distance = hubDistance(reach(project.id), sector) * (index % 2 === 0 ? 1 : 1.18);
      out[project.id] = { x: round(Math.cos(centre) * distance), y: round(Math.sin(centre) * distance) };
      angle += sector;
    });
    return out;
  }

  for (const project of fresh) {
    const angles = Object.values(out)
      .map((at) => Math.atan2(at.y, at.x))
      .sort((a, b) => a - b);
    let gapStart = angles[angles.length - 1]! - Math.PI * 2;
    let gap = angles[0]! - gapStart;
    for (let i = 1; i < angles.length; i++) {
      if (angles[i]! - angles[i - 1]! > gap) {
        gap = angles[i]! - angles[i - 1]!;
        gapStart = angles[i - 1]!;
      }
    }
    const centre = gapStart + gap / 2;
    const distance = hubDistance(reach(project.id), gap * 0.7);
    out[project.id] = { x: round(Math.cos(centre) * distance), y: round(Math.sin(centre) * distance) };
  }
  return out;
}

/**
 * The order projects go round the ring: from the largest, each next one the
 * project most connected to the last (by shared sources and sessions), the
 * largest remaining when none is.
 */
function ringOrder(projects: readonly KnowledgeNode[], graph: KnowledgeGraph): KnowledgeNode[] {
  const projectOf = new Map<string, string>();
  for (const node of graph.nodes) if (node.projectId) projectOf.set(node.id, `p:${node.projectId}`);
  const affinity = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains" || edge.kind === "session-project") continue;
    const a = projectOf.get(edge.source);
    const b = projectOf.get(edge.target);
    if (!a || !b || a === b) continue;
    for (const key of [`${a}|${b}`, `${b}|${a}`]) affinity.set(key, (affinity.get(key) ?? 0) + 1);
  }
  const left = [...projects];
  const order = [left.shift()!];
  while (left.length > 0) {
    const last = order[order.length - 1]!.id;
    let best = 0;
    for (let i = 1; i < left.length; i++) if ((affinity.get(`${last}|${left[i]!.id}`) ?? 0) > (affinity.get(`${last}|${left[best]!.id}`) ?? 0)) best = i;
    // Unrelated: alternate large and small round the ring, so the big fans spread out.
    if ((affinity.get(`${last}|${left[best]!.id}`) ?? 0) === 0) best = order.length % 2 === 1 ? left.length - 1 : 0;
    order.push(left.splice(best, 1)[0]!);
  }
  return order;
}
