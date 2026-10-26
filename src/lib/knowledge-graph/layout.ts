import { armPoint, clusterBound, clusterReach, clusterSlot, hashUnit, subFans } from "./galaxy";
import type { FanKind } from "./galaxy";
import type { KnowledgeGraph, KnowledgeNode, Point } from "./types";

export { hashUnit };

/**
 * Where everything sits: a spiral galaxy of project clusters around one core.
 *
 * ## Shape
 *
 * The core sits at the origin. Projects are star clusters strung along the
 * galaxy's two arms (see galaxy.ts): the largest nearest the core, and each
 * next one on an arm the project most connected to the one before it there
 * (by shared sources and sessions), so related work is neighbours along an
 * arm. Every cluster sits as near the core as its arm allows while staying
 * clear of every cluster already placed. Inside a cluster nothing is
 * simulated: each item takes a place in its kind's lobe, newest nearest the
 * heart. Sessions saved for no project drift in the halo beyond the arms.
 *
 * ## Stability
 *
 * Deterministic: everything derives from ids, counts, dates and the
 * relationships, never from Math.random. Positions the person has already
 * seen are passed back in as `previous` and kept exactly; a new project
 * takes the first clear place on its arm, and a new item the free place in
 * its lobe nearest to where its rank would put it. Adding a conversation
 * never moves anything else.
 *
 * ## Cost
 *
 * Closed form throughout. The caller still steps the work in slices
 * (`step(ticks)`) so a large library never blocks a frame.
 */

export const LARGE_GRAPH = 1500;

/** Items placed per tick. */
const ITEMS_PER_TICK = 10;
/** The closest a cluster's heart sits to the core: clear of the bulge. */
const CORE_CLEAR = 150;
/** Space kept between neighbouring clusters. */
const CLUSTER_GAP = 34;
/** How far a hub is moved out along its arm at a time while looking for a clear place. */
const ARM_STEP = 6;

/** A node's drawn radius in world units. Small and precise; a hub grows gently with what it holds. */
export function nodeRadius(node: Pick<KnowledgeNode, "kind" | "size" | "tabCount">): number {
  switch (node.kind) {
    case "project":
      return 6 + Math.min(8, Math.sqrt(node.size ?? 0) * 1.1);
    case "session":
      return 2.9;
    case "conversation":
      return 2.8;
    default:
      return 2.3;
  }
}

/** The furthest any of a project's `itemCount` items can sit from its hub. */
export function territoryRadius(itemCount: number): number {
  return clusterBound(itemCount) + 12;
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
  const lobes = new Map<string, KnowledgeNode[]>();
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
    lobes.set(key, [...(lobes.get(key) ?? []), node]);
  }
  // Newest first along each lobe: the newest sits nearest its heart.
  for (const list of lobes.values()) list.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));

  const reach = (projectNodeId: string) => clusterReach(kindCounts.get(projectNodeId.slice(2)) ?? new Map());
  const out: Record<string, Point> = {};
  const work = [...lobes.entries()];
  const totalTicks = 1 + Math.ceil((graph.nodes.length - projects.length) / ITEMS_PER_TICK);
  let placedHubs = false;
  let lobeIndex = 0;

  function placeLobe([key, list]: [string, KnowledgeNode[]]) {
    const [projectId, kind] = key.split("|") as [string, FanKind];
    const hub = out[`p:${projectId}`]!;
    const fan = subFans(kindCounts.get(projectId)!).find((entry) => entry.kind === kind)!;
    const slots = list.map((_, index) => clusterSlot(hub, fan, index));
    const taken = new Array<boolean>(slots.length).fill(false);
    const spacing = 11;
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
      // Every slot is crowded by remembered items: one more place just past the lobe's edge.
      const at = best >= 0 ? slots[best]! : clusterSlot(hub, { ...fan, count: list.length + rank + 1 }, list.length + rank);
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
      const distance = Math.max(CORE_CLEAR * 1.6, bounds + 70) + hashUnit(`${node.id}/r`) * 90;
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
      while (lobeIndex < work.length && items > 0) {
        items -= work[lobeIndex]![1].length;
        placeLobe(work[lobeIndex]!);
        lobeIndex += 1;
      }
      if (lobeIndex < work.length) return false;
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

/**
 * Hubs along the arms. Both arms are walked outward together, one cluster
 * on each in turn, every cluster taking the first place along its arm that
 * is clear of every cluster already placed. Known hubs keep their places
 * and newcomers find room around them the same way.
 */
function placeHubs(projects: readonly KnowledgeNode[], graph: KnowledgeGraph, reach: (id: string) => number, previous: Readonly<Record<string, Point>>): Record<string, Point> {
  const out: Record<string, Point> = {};
  if (projects.length === 0) return out;
  const placed: { at: Point; reach: number }[] = [];
  for (const project of projects) {
    const known = previous[project.id];
    if (!known) continue;
    out[project.id] = known;
    placed.push({ at: known, reach: reach(project.id) });
  }
  if (placed.length === projects.length) return out;

  const arms = armOrder(projects, graph);
  const cursor = [CORE_CLEAR, CORE_CLEAR];
  const longest = Math.max(arms[0].length, arms[1].length);
  for (let index = 0; index < longest; index++) {
    for (const arm of [0, 1] as const) {
      const project = arms[arm][index];
      if (!project) continue;
      const known = out[project.id];
      if (known) {
        cursor[arm] = Math.max(cursor[arm]!, Math.hypot(known.x, known.y));
        continue;
      }
      const own = reach(project.id);
      let r = cursor[arm]! + (index === 0 ? own : 0);
      let at = armPoint(arm, r);
      // Out along the arm until nothing already placed is in the way. Bounded: past every cluster there is always room.
      for (let guard = 0; guard < 20_000 && placed.some((other) => Math.hypot(other.at.x - at.x, other.at.y - at.y) < other.reach + own + CLUSTER_GAP); guard++) {
        r += ARM_STEP;
        at = armPoint(arm, r);
      }
      at = { x: round(at.x), y: round(at.y) };
      out[project.id] = at;
      placed.push({ at, reach: own });
      cursor[arm] = r;
    }
  }
  return out;
}

/**
 * Which arm each project goes on, inner to outer. The largest starts the
 * first arm next to the core; then, again and again, the remaining project
 * most connected to the outermost of either arm is placed after it — or,
 * when none is connected, the largest remaining goes on the shorter arm. The
 * second arm starts beside the first's start, across the core, so the two
 * arms read as one path through it.
 */
function armOrder(projects: readonly KnowledgeNode[], graph: KnowledgeGraph): [KnowledgeNode[], KnowledgeNode[]] {
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
  const arms: [KnowledgeNode[], KnowledgeNode[]] = [[left.shift()!], []];
  while (left.length > 0) {
    const ends = [arms[0][arms[0].length - 1]!, arms[1][arms[1].length - 1] ?? arms[0][0]!];
    let best = { arm: -1, index: -1, score: 0 };
    for (let arm = 0; arm < 2; arm++) {
      for (let i = 0; i < left.length; i++) {
        const score = affinity.get(`${ends[arm]!.id}|${left[i]!.id}`) ?? 0;
        if (score > best.score) best = { arm, index: i, score };
      }
    }
    if (best.arm < 0) best = { arm: arms[1].length < arms[0].length ? 1 : 0, index: 0, score: 0 };
    arms[best.arm as 0 | 1].push(left.splice(best.index, 1)[0]!);
  }
  return arms;
}
