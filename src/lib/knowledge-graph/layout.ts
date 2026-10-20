import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { GraphNodeKind, KnowledgeGraph, KnowledgeNode, Point } from "./types";

/**
 * Where everything sits.
 *
 * ## Shape
 *
 * Each project holds a territory — a disc sized by how much it holds — and
 * its items settle inside it, grouped by kind (conversations together,
 * sources together…) and pulled closer the more recently they were touched.
 * Projects are placed on a golden-angle spiral, then relaxed so territories
 * never overlap and projects that share sources drift toward each other. The
 * result reads as neighbourhoods rather than as one hub with spokes.
 *
 * ## Stability
 *
 * Deterministic: initial positions come from a hash of each node's id, never
 * from Math.random, so the same records give the same picture. Positions the
 * person has already seen are passed back in as `previous`; nodes that have
 * one start there and the simulation starts cool, so adding a conversation
 * moves the conversation into place and leaves everything else where it was.
 *
 * ## Cost
 *
 * The simulation is stepped by the caller in slices (`step(ticks)`), so a
 * graph of thousands of nodes never blocks a frame. Many-body repulsion is
 * bounded by distance and dropped entirely past LARGE_GRAPH nodes, where
 * collision alone keeps nodes apart.
 */

export const LARGE_GRAPH = 1500;

type SimNode = SimulationNodeDatum & { id: string; kind: GraphNodeKind; r: number; projectId?: string; home?: Point; territory?: number };
type SimLink = SimulationLinkDatum<SimNode> & { kind: string };

/** A node's drawn radius in world units. Projects grow with what they hold, gently. */
export function nodeRadius(node: Pick<KnowledgeNode, "kind" | "size" | "tabCount">): number {
  switch (node.kind) {
    case "project":
      return 15 + Math.min(17, Math.sqrt(node.size ?? 0) * 2.6);
    case "session":
      return 7;
    case "conversation":
      return 6.2;
    default:
      return 5.6;
  }
}

/** The disc a project's items live in. */
export function territoryRadius(itemCount: number): number {
  return 70 + Math.sqrt(itemCount) * 24;
}

/** FNV-1a over the id, as a number in [0, 1). */
export function hashUnit(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** The direction each kind grows out of its project, so like sits with like. */
const KIND_SECTOR: Record<GraphNodeKind, number> = {
  project: 0,
  conversation: -Math.PI / 2,
  source: 0,
  file: Math.PI / 2,
  note: Math.PI,
  session: (-3 * Math.PI) / 4,
};

export type KnowledgeLayout = {
  /** Advances the simulation; true once it has settled. */
  step: (ticks: number) => boolean;
  positions: () => Record<string, Point>;
  /** How many ticks a full settle takes, for progress. */
  totalTicks: number;
};

export function createKnowledgeLayout(graph: KnowledgeGraph, previous: Readonly<Record<string, Point>> = {}): KnowledgeLayout {
  const projects = graph.nodes.filter((node) => node.kind === "project");
  const itemCount = new Map<string, number>();
  for (const node of graph.nodes) if (node.kind !== "project" && node.projectId) itemCount.set(node.projectId, (itemCount.get(node.projectId) ?? 0) + 1);

  // ---- 1. Projects: spiral, then relax so territories never overlap. ----
  const projectHome = placeProjects(projects, graph, itemCount, previous);

  // ---- 2. Everything else starts at its remembered place, or in its project's sector. ----
  const known = graph.nodes.filter((node) => previous[node.id]).length;
  const byProjectKind = new Map<string, KnowledgeNode[]>();
  for (const node of graph.nodes) {
    if (node.kind === "project") continue;
    const key = `${node.projectId ?? "-"}|${node.kind}`;
    byProjectKind.set(key, [...(byProjectKind.get(key) ?? []), node]);
  }
  // Recent first within each group: the newest sits nearest its project.
  for (const list of byProjectKind.values()) list.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));

  const bounds = Object.values(projectHome).reduce((acc, p) => Math.max(acc, Math.hypot(p.x, p.y)), 0);
  const simNodes: SimNode[] = [];
  const simById = new Map<string, SimNode>();
  for (const node of graph.nodes) {
    const r = nodeRadius(node);
    if (node.kind === "project") {
      const home = projectHome[node.id]!;
      const sim: SimNode = { id: node.id, kind: node.kind, r, x: home.x, y: home.y, fx: home.x, fy: home.y, territory: territoryRadius(itemCount.get(node.id.slice(2)) ?? 0) };
      simNodes.push(sim);
      simById.set(node.id, sim);
      continue;
    }
    const projectHomePoint = node.projectId ? projectHome[`p:${node.projectId}`] : undefined;
    const territory = node.projectId ? territoryRadius(itemCount.get(node.projectId) ?? 0) : 0;
    let start = previous[node.id];
    if (!start) {
      const group = byProjectKind.get(`${node.projectId ?? "-"}|${node.kind}`) ?? [node];
      const rank = group.indexOf(node);
      const jitter = hashUnit(node.id);
      if (projectHomePoint) {
        const spread = Math.min(Math.PI / 2.2, 0.35 + group.length * 0.06);
        const angle = KIND_SECTOR[node.kind] + (group.length > 1 ? (rank / (group.length - 1) - 0.5) * spread : 0) + (jitter - 0.5) * 0.25;
        const distance = territory * (0.32 + 0.55 * Math.min(1, rank / Math.max(6, group.length)) + jitter * 0.08);
        start = { x: projectHomePoint.x + Math.cos(angle) * distance, y: projectHomePoint.y + Math.sin(angle) * distance };
      } else {
        // Belongs to no project (a session saved on its own): an outer orbit, in id order.
        const angle = jitter * Math.PI * 2;
        const distance = bounds + 260 + jitter * 80;
        start = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
      }
    }
    const sim: SimNode = { id: node.id, kind: node.kind, r, x: start.x, y: start.y, ...(node.projectId ? { projectId: node.projectId } : {}), ...(projectHomePoint ? { home: projectHomePoint, territory } : {}) };
    simNodes.push(sim);
    simById.set(node.id, sim);
  }

  const links: SimLink[] = graph.edges
    .filter((edge) => simById.has(edge.source) && simById.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind }));

  const large = simNodes.length > LARGE_GRAPH;
  const simulation: Simulation<SimNode, SimLink> = forceSimulation<SimNode>(simNodes)
    .stop()
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((node) => node.id)
        .distance((link) => {
          const source = link.source as SimNode;
          if (link.kind === "contains" || link.kind === "session-project") return (source.territory ?? 120) * 0.5;
          return 140;
        })
        .strength((link) => (link.kind === "contains" ? 0.5 : link.kind === "session-project" ? 0.35 : 0.015))
    )
    .force("collide", forceCollide<SimNode>((node) => (node.kind === "project" ? node.r + 18 : node.r + 7)).iterations(2))
    .force("territory", territoryForce())
    // Unaffiliated nodes drift back toward the picture rather than off into space.
    .force("x", forceX<SimNode>(0).strength((node) => (node.home || node.kind === "project" ? 0 : 0.01)))
    .force("y", forceY<SimNode>(0).strength((node) => (node.home || node.kind === "project" ? 0 : 0.01)));
  if (!large) simulation.force("charge", forceManyBody<SimNode>().strength(-26).distanceMax(110));

  // Mostly-known graphs only need the newcomers to find their place.
  const familiar = graph.nodes.length > 0 && known / graph.nodes.length > 0.6;
  simulation.alpha(familiar ? 0.25 : 1).alphaDecay(familiar ? 0.06 : large ? 0.035 : 0.0228);
  const totalTicks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
  let ticked = 0;

  return {
    totalTicks,
    step(ticks: number) {
      if (simulation.alpha() < simulation.alphaMin()) return true;
      const n = Math.min(ticks, totalTicks - ticked);
      if (n > 0) simulation.tick(n);
      ticked += Math.max(0, n);
      return ticked >= totalTicks || simulation.alpha() < simulation.alphaMin();
    },
    positions() {
      const out: Record<string, Point> = {};
      for (const node of simNodes) out[node.id] = { x: round(node.x ?? 0), y: round(node.y ?? 0) };
      return out;
    },
  };
}

/** Runs a layout to rest in one go — for tests and small graphs. */
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

/** Keeps an item inside its project's territory: a soft wall, not a cage. */
function territoryForce() {
  let nodes: SimNode[] = [];
  const force = (alpha: number) => {
    for (const node of nodes) {
      if (!node.home || node.territory === undefined || node.kind === "project") continue;
      const dx = (node.x ?? 0) - node.home.x;
      const dy = (node.y ?? 0) - node.home.y;
      const distance = Math.hypot(dx, dy) || 1;
      const limit = node.territory - node.r;
      if (distance > limit) {
        const pull = ((distance - limit) / distance) * alpha * 0.6;
        node.vx = (node.vx ?? 0) - dx * pull;
        node.vy = (node.vy ?? 0) - dy * pull;
      }
    }
  };
  force.initialize = (next: SimNode[]) => {
    nodes = next;
  };
  return force;
}

/**
 * Projects on a golden-angle spiral, relaxed apart by their territories.
 * Projects that share sources (or sessions) attract a little, so related
 * work ends up side by side.
 */
function placeProjects(projects: readonly KnowledgeNode[], graph: KnowledgeGraph, itemCount: ReadonlyMap<string, number>, previous: Readonly<Record<string, Point>>): Record<string, Point> {
  const out: Record<string, Point> = {};
  if (projects.length === 0) return out;
  type P = SimulationNodeDatum & { id: string; territory: number };
  const territories = projects.map((project) => territoryRadius(itemCount.get(project.id.slice(2)) ?? 0));
  const spacing = (territories.reduce((a, b) => a + b, 0) / territories.length) * 1.7;
  const sims: P[] = projects.map((project, index) => {
    const remembered = previous[project.id];
    const angle = index * GOLDEN_ANGLE;
    const distance = index === 0 ? 0 : spacing * Math.sqrt(index);
    // A project the person has already seen stays exactly where they saw it; only newcomers find a place.
    return { id: project.id, territory: territories[index]!, x: remembered?.x ?? Math.cos(angle) * distance, y: remembered?.y ?? Math.sin(angle) * distance, ...(remembered ? { fx: remembered.x, fy: remembered.y } : {}) };
  });
  if (sims.length === 1) {
    out[sims[0]!.id] = { x: sims[0]!.x!, y: sims[0]!.y! };
    return out;
  }

  // Project-to-project affinity: how many relationships cross between them.
  const projectOf = new Map<string, string>();
  for (const node of graph.nodes) if (node.projectId) projectOf.set(node.id, `p:${node.projectId}`);
  const affinity = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains" || edge.kind === "session-project") continue;
    const a = projectOf.get(edge.source);
    const b = projectOf.get(edge.target);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    affinity.set(key, (affinity.get(key) ?? 0) + 1);
  }
  const links = [...affinity.entries()].map(([key, weight]) => {
    const [source, target] = key.split("|") as [string, string];
    return { source, target, weight };
  });

  const allKnown = projects.every((project) => previous[project.id]);
  if (allKnown) {
    for (const sim of sims) out[sim.id] = { x: sim.x!, y: sim.y! };
    return out;
  }
  const relax = forceSimulation<P>(sims)
    .stop()
    .force("collide", forceCollide<P>((node) => node.territory + 36).iterations(3))
    .force(
      "affinity",
      forceLink<P, { source: string; target: string; weight: number }>(links)
        .id((node) => node.id)
        .distance((link) => ((link.source as unknown as P).territory + (link.target as unknown as P).territory) * 1.05)
        .strength((link) => Math.min(0.4, 0.08 * link.weight))
    )
    .force("x", forceX<P>(0).strength(0.03))
    .force("y", forceY<P>(0).strength(0.03))
    .alpha(1);
  relax.tick(220);
  for (const sim of sims) out[sim.id] = { x: round(sim.x ?? 0), y: round(sim.y ?? 0) };
  return out;
}
