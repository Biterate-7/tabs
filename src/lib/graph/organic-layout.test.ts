/**
 * The layout must not have a SHAPE of its own.
 *
 * A category's members are held on a disc (cluster-regions.ts) and pushed
 * around by charge, collide and links (engine.ts). Everything here asserts the
 * one thing that arrangement must never become: the disc itself. When it does,
 * every category on the canvas turns into the same smooth arc — reported as
 * "groups settle into predetermined curved formations", and reproduced below
 * by every number this file bounds.
 *
 * Two mechanisms produced it, and each has its own guard here:
 *
 *  1. WORLD CENTRING AGAINST A FIXED DISC. `forceCenter` writes positions, not
 *     velocities, and is not scaled by alpha, so it translated the whole node
 *     cloud toward the origin on every tick while `confineToRegions` projected
 *     each node back into a disc that never moved. Two opposed position writes
 *     do not balance the way two forces do: every cluster slid until its wall
 *     stopped it and its members piled along the rim, in the same direction
 *     for every cluster, because the drift was global. Measured on the
 *     300-tab/4-category fixture below: centroids 190px off their disc centres
 *     (disc radius 212), mean member radius 206 of a possible 212, all 75
 *     members inside a 120° sector, 711 pairs crushed past their collide
 *     radius with the worst pair interpenetrating by 48px. Guarded by
 *     "sits on its own ground", "fills its disc instead of lining its rim" and
 *     "keeps its members clear of each other".
 *
 *  2. A HARD WALL AS THE ONLY COHESION. A disc is a hard confining potential,
 *     and charges in a hard box accumulate on the boundary — nothing in the
 *     interior pushes back. A fresh graph hid it (alpha decays in ~180 ticks,
 *     so a cluster seeded compact never reaches that equilibrium), but every
 *     drag reheats and the layout crept toward it a little more each time,
 *     which is why the bug was reported as getting worse the more things were
 *     moved. Measured before the cluster cohesion force existed: after 40 node
 *     drags all four categories had inflated from mean radius 0.55 of their
 *     disc to 0.87-0.89, with 59% of members in the outer rim and aspect
 *     ratios of 0.98-0.99 — four indistinguishable rings. Guarded by "does not
 *     creep toward its disc as the user moves things around".
 *
 * The thresholds are deliberately loose. None of them describes a shape the
 * layout ought to have — a cluster is free to be lopsided, ragged, dense on
 * one side, whatever its contents make it. They only bound the distance
 * between where a cluster is and where its disc is.
 */
import { describe, expect, it } from "vitest";
import { buildWorkspace, makeGraph } from "./__fixtures__/graph-harness";
import { confinementRegion } from "./cluster-regions";

type Graph = ReturnType<typeof makeGraph>;

type ClusterShape = {
  label: string;
  members: number;
  /** Distance from the members' centroid to their disc's centre, over the disc radius. */
  drift: number;
  /** Mean member distance from the centroid, over the disc radius. */
  fill: number;
  /** Share of members in the outer 15% of the cluster's own extent. A filled disc is ~0.28; a rim pile approaches 1. */
  rim: number;
  /** How many of twelve 30° sectors around the centroid hold at least one member. */
  sectors: number;
  /** Smallest edge-to-edge gap between two members, in world units. Negative means the drawn circles overlap. */
  minGap: number;
  /** Minor/major axis ratio: 1 is circular, 0 is a line. */
  aspect: number;
  /** Direction of the major axis, 0-180°. */
  orientation: number;
};

/** Every territory-owning category's settled shape, measured against the disc it is confined to. */
function clusterShapes(graph: Graph, minMembers = 8): ClusterShape[] {
  const radii = graph.radii();
  const shapes: ClusterShape[] = [];

  for (const category of graph.tree.roots) {
    const reserved = graph.regions.get(category.id);
    if (!reserved) continue;
    const disc = confinementRegion(reserved);
    const points = category.totalTabIds
      .map((id) => {
        const node = graph.simulation.findNode(id);
        if (!node || node.x === undefined || node.y === undefined) return null;
        return { x: node.x, y: node.y, radius: radii.get(id) ?? 0 };
      })
      .filter((point): point is { x: number; y: number; radius: number } => point !== null);
    if (points.length < minMembers) continue;

    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const distances = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const extent = Math.max(...distances);

    let minGap = Infinity;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - cx;
      const dy = points[i].y - cy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
      for (let j = i + 1; j < points.length; j++) {
        const gap =
          Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) - points[i].radius - points[j].radius;
        if (gap < minGap) minGap = gap;
      }
    }
    const trace = (sxx + syy) / points.length;
    const det = (sxx * syy - sxy * sxy) / (points.length * points.length);
    const spread = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
    const major = Math.sqrt(Math.max(0, trace / 2 + spread));
    const minor = Math.sqrt(Math.max(0, trace / 2 - spread));
    const orientation = (Math.atan2(2 * sxy, sxx - syy) / 2) * (180 / Math.PI);

    shapes.push({
      label: category.label,
      members: points.length,
      drift: Math.hypot(cx - disc.x, cy - disc.y) / disc.r,
      fill: distances.reduce((sum, d) => sum + d, 0) / distances.length / disc.r,
      rim: distances.filter((d) => d > extent * 0.85).length / points.length,
      sectors: new Set(
        points.map((p) => Math.floor(((Math.atan2(p.y - cy, p.x - cx) + Math.PI) / (Math.PI * 2)) * 12) % 12)
      ).size,
      minGap,
      aspect: major > 0 ? minor / major : 1,
      orientation: ((orientation % 180) + 180) % 180,
    });
  }

  return shapes;
}

/**
 * Grabs random nodes and hauls them across their neighbourhood the way a
 * pointer does — pin, move, reheat, frame, release — then lets the graph
 * settle. This is the "after you have moved things around a lot" the bug
 * report is about, and it is the only way to observe an attractor the fresh
 * layout is simply too cold to reach.
 */
function dragNodesAround(graph: Graph, rounds: number, seed: number): void {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ids = graph.nodes.map((node) => node.id);

  for (let round = 0; round < rounds; round++) {
    const id = ids[Math.floor(random() * ids.length)];
    const node = graph.simulation.findNode(id);
    if (!node || node.x === undefined || node.y === undefined) continue;
    const fromX = node.x;
    const fromY = node.y;
    const dx = (random() - 0.5) * 700;
    const dy = (random() - 0.5) * 700;

    graph.simulation.setBoundaryExcluded(id);
    for (let step = 1; step <= 12; step++) {
      graph.simulation.pin(id, fromX + (dx * step) / 12, fromY + (dy * step) / 12);
      graph.simulation.reheat(0.12);
      graph.frame();
    }
    graph.simulation.unpin(id);
    graph.simulation.setBoundaryExcluded(null);
    graph.simulation.reheat(0.2);
    graph.run(80);
  }
  graph.run(600);
}

function describeShape(shape: ClusterShape): string {
  return (
    `${shape.label} (${shape.members} tabs): drift ${shape.drift.toFixed(2)} fill ${shape.fill.toFixed(2)} ` +
    `rim ${shape.rim.toFixed(2)} sectors ${shape.sectors}/12 minGap ${shape.minGap.toFixed(0)}px`
  );
}

describe("organic cluster layout", () => {
  /**
   * Mechanism 1's most direct symptom, and the cheapest to check: a cluster
   * whose members have collectively slid to one side of their own disc. The
   * pre-fix layout measured 0.90 here on every category at once, always in the
   * same direction.
   */
  it("sits on its own ground rather than sliding against its disc", () => {
    for (const data of [
      buildWorkspace(300, { seed: 5, categories: 4, subcategoryShare: 0 }),
      buildWorkspace(220, { seed: 7 }),
    ]) {
      const graph = makeGraph(data);
      graph.run(1200);
      for (const shape of clusterShapes(graph, 20)) {
        expect(shape.drift, describeShape(shape)).toBeLessThan(0.5);
      }
    }
  }, 60_000);

  /**
   * The crescent itself. A cluster pressed against its wall has almost every
   * member at the same radius (fill approaches 1), most of them inside the
   * outer sliver of its extent, and — because the pile only occupies the side
   * of the rim it drifted toward — spread over a fraction of the circle.
   */
  it("fills its disc instead of lining its rim", () => {
    const graph = makeGraph(buildWorkspace(300, { seed: 5, categories: 4, subcategoryShare: 0 }));
    graph.run(1200);
    const shapes = clusterShapes(graph, 20);
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      // Pre-fix: 0.97. A uniformly filled disc sits near 2/3 of its extent,
      // and the extent itself is well inside the disc.
      expect(shape.fill, describeShape(shape)).toBeLessThan(0.75);
      // Pre-fix: 0.6-0.9 depending on the category. A filled disc is ~0.28.
      expect(shape.rim, describeShape(shape)).toBeLessThan(0.45);
      // Pre-fix: 4 of 12, the 120° sector the pile occupied.
      expect(shape.sectors, describeShape(shape)).toBeGreaterThanOrEqual(10);
    }
  }, 60_000);

  /**
   * Two position writes in opposition crush nodes through each other, because
   * collide is an alpha-scaled velocity force and cannot answer them. The
   * pre-fix layout's worst pair overlapped by 48px — the visible circles
   * genuinely intersecting, not merely a narrowed gap.
   */
  it("keeps its members clear of each other", () => {
    for (const data of [
      buildWorkspace(300, { seed: 5, categories: 4, subcategoryShare: 0 }),
      buildWorkspace(220, { seed: 7 }),
    ]) {
      const graph = makeGraph(data);
      graph.run(1200);
      for (const shape of clusterShapes(graph)) {
        expect(shape.minGap, describeShape(shape)).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  /**
   * Mechanism 2, and the property the bug report is really about: the layout
   * must not have a shape it converges ON. Dragging is what feeds it the
   * energy to get there, so this drags a lot, twice, and checks that the
   * second batch changes nothing the first did not — i.e. that wherever the
   * clusters have got to, it is a resting state and not a slide toward the
   * wall.
   */
  it("does not creep toward its disc as the user moves things around", () => {
    const graph = makeGraph(buildWorkspace(300, { seed: 5, categories: 4, subcategoryShare: 0 }));
    graph.run(1200);
    const fresh = clusterShapes(graph, 20);

    dragNodesAround(graph, 40, 3);
    const dragged = clusterShapes(graph, 20);
    dragNodesAround(graph, 40, 99);
    const draggedMore = clusterShapes(graph, 20);

    expect(fresh.length).toBeGreaterThan(0);
    for (let i = 0; i < fresh.length; i++) {
      // Pre-fix this ran 0.55 -> 0.87 -> 0.89, i.e. straight at the wall.
      expect(draggedMore[i].fill, `${describeShape(fresh[i])} -> ${describeShape(draggedMore[i])}`).toBeLessThan(0.75);
      expect(draggedMore[i].rim, describeShape(draggedMore[i])).toBeLessThan(0.45);
      expect(draggedMore[i].minGap, describeShape(draggedMore[i])).toBeGreaterThan(0);
      // The second batch of drags must not continue what the first started.
      expect(
        Math.abs(draggedMore[i].fill - dragged[i].fill),
        `${dragged[i].label}: fill ${dragged[i].fill.toFixed(2)} -> ${draggedMore[i].fill.toFixed(2)}`
      ).toBeLessThan(0.1);
    }
  }, 120_000);

  /**
   * And the flip side of "no shape of its own": clusters must be ABLE to
   * differ. Four same-sized categories converging on one arrangement is what
   * made the old layout read as drawn rather than grown, so this asserts they
   * do not — before and after a long session of dragging, since the pre-fix
   * layout's shapes converged as the drags went on (aspect ratios 0.78-0.92
   * fresh, 0.98-0.99 after 40 drags).
   */
  it("lets equally-sized clusters settle into different arrangements", () => {
    const graph = makeGraph(buildWorkspace(300, { seed: 5, categories: 4, subcategoryShare: 0 }));
    graph.run(1200);

    const spreadOf = (shapes: ClusterShape[]) => {
      const orientations = shapes.map((s) => s.orientation);
      // Orientation is an axis, not a direction, so the gap across 0/180 is
      // the same size as any other — measure on the circle.
      let widest = 0;
      for (const a of orientations) {
        for (const b of orientations) {
          const raw = Math.abs(a - b);
          widest = Math.max(widest, Math.min(raw, 180 - raw));
        }
      }
      return {
        orientation: widest,
        rim: Math.max(...shapes.map((s) => s.rim)) - Math.min(...shapes.map((s) => s.rim)),
      };
    };

    const fresh = spreadOf(clusterShapes(graph, 20));
    dragNodesAround(graph, 40, 3);
    const dragged = spreadOf(clusterShapes(graph, 20));

    for (const [label, spread] of [
      ["fresh", fresh],
      ["after 40 drags", dragged],
    ] as const) {
      expect(spread.orientation, `${label}: orientation spread ${spread.orientation.toFixed(0)}°`).toBeGreaterThan(25);
      expect(spread.rim, `${label}: rim spread ${spread.rim.toFixed(2)}`).toBeGreaterThan(0.05);
    }
  }, 120_000);
});
