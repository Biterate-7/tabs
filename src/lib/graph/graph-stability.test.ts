/**
 * Behavioural regression suite for graph STABILITY at realistic scale.
 *
 * Drives the real production pipeline end to end — the same
 * buildGraphNodes / buildGraphEdges / buildClusterTree / computeClusterAnchors
 * / createGraphSimulation calls graph-view.tsx and graph-canvas.tsx make, in
 * the same order, with the same arguments — and asserts the properties a user
 * would describe as "the graph feels controlled":
 *
 *   - a bulk dump does not explode outward on its first frame
 *   - no node ever exceeds the simulation's own speed bound
 *   - the layout comes to a genuine, permanent rest
 *   - edges stay short relative to the graph they live in
 *   - a tab stays near the group it belongs to
 *   - dumping into a populated graph does not throw the existing layout
 *   - dragging does not resize the group the dragged tab belongs to
 *
 * All bounds are deliberately loose — they pin the FAILURE MODES that were
 * reported (nodes flying hundreds of pixels between frames, edges spanning
 * the canvas, a graph that never settles), not the exact tuning that happens
 * to satisfy them today, so ordinary re-tuning does not make this suite red.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "./relations";
import { buildClusterTree, computeClusterAnchors, type ClusterTree } from "./clusters";
import { computeNodeRadius } from "./node-size";
import { BULK_ARRIVAL_THRESHOLD, MAX_NODE_SPEED, createGraphSimulation, type GraphSimulation } from "./engine";
import { CATEGORY_BOUNDARY_PADDING, computeCollectionBoundary } from "./collection-layout";
import { DEFAULT_CONNECTION_FILTERS } from "./types";
import { buildSyntheticDump } from "@/lib/tabs/__fixtures__/synthetic-dump";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace } from "@/lib/workspace/types";

type Scene = {
  simulation: GraphSimulation;
  tree: ClusterTree;
  tabIds: string[];
  edgeCount: number;
};

/**
 * Everything graph-canvas.tsx's physics effect does for one tab set, in the
 * same order. Passing an existing `simulation` reproduces "dump into a graph
 * that already has tabs in it"; omitting it reproduces a cold first dump.
 */
function mount(tabs: Tab[], sections: Section[] = [], simulation?: GraphSimulation): Scene {
  const workspaces: Workspace[] = [{ id: "ws-1", name: "Workspace", tabs, sections, createdAt: 0, updatedAt: 0 }];
  const lookup = buildWorkspaceLookup(workspaces);
  const nodes = buildGraphNodes(tabs, lookup);
  const tree = buildClusterTree(tabs, sections, []);
  const anchors = computeClusterAnchors(tree);
  const edges = buildGraphEdges(
    tabs,
    lookup,
    DEFAULT_CONNECTION_FILTERS,
    [],
    sections,
    (tabId) => anchors.get(tabId)?.categoryAnchor ?? undefined
  );

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const sim = simulation ?? createGraphSimulation();
  sim.setNodes(
    nodes,
    (node) => computeNodeRadius("connections", degree.get(node.id) ?? 0, undefined),
    {},
    (node) => {
      const anchor = anchors.get(node.id);
      return anchor?.confineTo ?? anchor?.categoryAnchor ?? undefined;
    }
  );
  sim.setEdges(edges, 1);
  sim.setCollections([]);
  sim.setClusterAnchors(anchors);
  sim.reheat(0.5);

  return { simulation: sim, tree, tabIds: tabs.map((t) => t.id), edgeCount: edges.length };
}

function positions(scene: Scene): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const id of scene.tabIds) {
    const node = scene.simulation.findNode(id);
    if (node?.x === undefined || node?.y === undefined) continue;
    out.set(id, { x: node.x, y: node.y });
  }
  return out;
}

function extentOf(points: Iterable<{ x: number; y: number }>): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** Runs `ticks` frames, reporting the worst single-frame motion seen anywhere. */
function run(scene: Scene, ticks: number) {
  let worstDisplacement = 0;
  let worstSpeed = 0;
  let previous = positions(scene);
  for (let i = 0; i < ticks; i++) {
    scene.simulation.tick();
    const current = positions(scene);
    for (const [id, point] of current) {
      const before = previous.get(id);
      if (before) worstDisplacement = Math.max(worstDisplacement, Math.hypot(point.x - before.x, point.y - before.y));
      const node = scene.simulation.findNode(id)!;
      worstSpeed = Math.max(worstSpeed, Math.hypot(node.vx ?? 0, node.vy ?? 0));
    }
    previous = current;
  }
  return { worstDisplacement, worstSpeed, final: previous };
}

function settle(scene: Scene, maxTicks = 3000): number {
  let ticks = 0;
  while (ticks < maxTicks && !scene.simulation.isSettled()) {
    scene.simulation.tick();
    ticks++;
  }
  return ticks;
}

/** Every tab's distance to the nearest other member of its own top-level cluster. */
function clusterCohesion(scene: Scene, points: Map<string, { x: number; y: number }>) {
  let worst = 0;
  let stranded = 0;
  for (const cluster of scene.tree.roots) {
    if (cluster.totalTabIds.length < 2) continue;
    for (const id of cluster.totalTabIds) {
      const point = points.get(id);
      if (!point) continue;
      let nearest = Infinity;
      for (const other of cluster.totalTabIds) {
        if (other === id) continue;
        const q = points.get(other);
        if (!q) continue;
        nearest = Math.min(nearest, Math.hypot(point.x - q.x, point.y - q.y));
      }
      if (!Number.isFinite(nearest)) continue;
      worst = Math.max(worst, nearest);
      if (nearest > 250) stranded++;
    }
  }
  return { worst, stranded };
}

const SCALES = [10, 25, 50, 100, 250, 500];

describe("bulk dump is a controlled transition, at every realistic scale", () => {
  for (const count of SCALES) {
    describe(`${count} tabs`, () => {
      it("does not explode on the frames right after insertion", () => {
        const scene = mount(buildSyntheticDump(count));
        // The reported failure showed up entirely in the first handful of
        // frames: cold, the old seeding moved one node 424px and the average
        // node 168px on the very first tick of the real 283-tab export.
        const { worstDisplacement } = run(scene, 5);
        expect(worstDisplacement).toBeLessThan(60);
      });

      it("never lets a node exceed the simulation's speed bound", () => {
        const scene = mount(buildSyntheticDump(count));
        const { worstSpeed } = run(scene, 400);
        expect(worstSpeed).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);
      });

      it("settles, and then stays completely still", () => {
        const scene = mount(buildSyntheticDump(count));
        const ticks = settle(scene);
        expect(scene.simulation.isSettled(), `did not settle within ${ticks} ticks`).toBe(true);

        // "Settled" must mean at rest, not frozen mid-flight: d3 stops
        // advancing the moment alpha crosses alphaMin, and whatever velocity
        // a node still carried used to sit there waiting to discharge the
        // next time anything reheated the simulation.
        const before = positions(scene);
        run(scene, 30);
        const after = positions(scene);
        for (const [id, point] of after) {
          const start = before.get(id)!;
          expect(Math.hypot(point.x - start.x, point.y - start.y), `node ${id} moved after settling`).toBeLessThan(1e-6);
        }
      });

      it("keeps every tab near its own group", () => {
        const scene = mount(buildSyntheticDump(count));
        settle(scene);
        const { stranded } = clusterCohesion(scene, positions(scene));
        expect(stranded, "tabs sitting >250px from any sibling in their own cluster").toBe(0);
      });

      it("keeps edges short relative to the graph they live in", () => {
        const scene = mount(buildSyntheticDump(count));
        settle(scene);
        const points = positions(scene);
        const extent = extentOf(points.values());
        const workspaces: Workspace[] = [
          { id: "ws-1", name: "Workspace", tabs: buildSyntheticDump(count), sections: [], createdAt: 0, updatedAt: 0 },
        ];
        const lookup = buildWorkspaceLookup(workspaces);
        const tree = buildClusterTree(workspaces[0].tabs, [], []);
        const anchors = computeClusterAnchors(tree);
        const edges = buildGraphEdges(
          workspaces[0].tabs,
          lookup,
          DEFAULT_CONNECTION_FILTERS,
          [],
          [],
          (tabId) => anchors.get(tabId)?.categoryAnchor ?? undefined
        );
        const lengths = edges
          .map((edge) => {
            const a = points.get(edge.source);
            const b = points.get(edge.target);
            return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
          })
          .filter((length): length is number => length !== null)
          .sort((a, b) => a - b);
        if (lengths.length === 0) return;

        const median = lengths[Math.floor(lengths.length / 2)];
        const p95 = lengths[Math.floor(lengths.length * 0.95)];

        // A typical edge connects neighbours, not opposite corners. This is
        // the assertion that would have caught the original bug outright: the
        // real export's workspace chain averaged 1237px in a 3300px graph,
        // a median of ~0.37 of the extent.
        expect(median).toBeLessThan(Math.max(300, extent * 0.15));

        // The long tail stays a tail. The absolute floor matters at small
        // scales: cluster-regions.ts reserves each category a disc separated
        // from its neighbours by REGION_GAP, so in a 10-tab graph of three
        // one-tab categories the ONLY possible cross-category edge is already
        // most of the (tiny) graph's width. That is the region layout doing
        // its job, not the physics failing to hold; the ratio bound is what
        // does the real work once there is a graph to measure.
        expect(p95).toBeLessThan(Math.max(600, extent * 0.55));

        // Genuinely long edges exist — a domain whose tabs really do live in
        // two distant categories is a real relationship and gets drawn — but
        // they must be the exception. Asserted as a share only once there are
        // enough edges for a share to mean anything.
        const veryLong = lengths.filter((length) => length > extent * 0.5).length;
        if (lengths.length >= 30) expect(veryLong / lengths.length).toBeLessThan(0.1);
        else expect(veryLong).toBeLessThanOrEqual(3);
      });
    });
  }
});

describe("bulk insertion uses controlled initialization", () => {
  it("reports a large arrival and enters the tighter settling regime", () => {
    const scene = mount(buildSyntheticDump(250));
    expect(scene.simulation.lastArrivalCount()).toBe(250);
    expect(scene.simulation.isBulkSettling()).toBe(true);
  });

  it("does not treat a one- or two-tab addition as a bulk arrival", () => {
    const base = buildSyntheticDump(60);
    const scene = mount(base);
    settle(scene);

    const withOneMore = [...base, { ...base[0], id: "brand-new", url: "https://example.com/new" }];
    mount(withOneMore, [], scene.simulation);
    expect(scene.simulation.lastArrivalCount()).toBe(1);
    expect(scene.simulation.isBulkSettling()).toBe(false);
  });

  it("seeds a whole arrival without stacking any two tabs on the same point", () => {
    const scene = mount(buildSyntheticDump(300));
    const points = [...positions(scene).values()];
    let coincident = 0;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < 1) coincident++;
      }
    }
    expect(coincident, "seeded tabs sitting on top of one another before the first tick").toBe(0);
  });

  it("settleBulk converges the layout within its tick budget and never past it", () => {
    const scene = mount(buildSyntheticDump(250));
    const ran = scene.simulation.settleBulk(200, 10_000);
    expect(ran).toBeLessThanOrEqual(200);
    expect(ran).toBeGreaterThan(0);

    // Whatever it managed, the result is a calm graph, not a mid-explosion one.
    const { worstDisplacement } = run(scene, 20);
    expect(worstDisplacement).toBeLessThan(20);
  });

  it("BULK_ARRIVAL_THRESHOLD sits between hand-editing and dumping", () => {
    expect(BULK_ARRIVAL_THRESHOLD).toBeGreaterThan(2);
    expect(BULK_ARRIVAL_THRESHOLD).toBeLessThan(100);
  });
});

describe("dumping into a graph that already has tabs", () => {
  it("leaves the existing layout broadly where it was", () => {
    const existing = buildSyntheticDump(80);
    const scene = mount(existing);
    settle(scene);
    const before = positions(scene);

    // A second dump of 200 more tabs into the same simulation.
    const extra = buildSyntheticDump(200).map((tab, index) => ({
      ...tab,
      id: `second-${index}`,
      url: `${tab.url}#second-${index}`,
    }));
    const merged = mount([...existing, ...extra], [], scene.simulation);
    settle(merged, 3000);
    const after = positions(merged);

    let worstShift = 0;
    for (const [id, point] of before) {
      const now = after.get(id);
      if (!now) continue;
      worstShift = Math.max(worstShift, Math.hypot(now.x - point.x, now.y - point.y));
    }
    // The graph does re-arrange — 200 new tabs is a real change — but it
    // must be a rearrangement, not a teleport: nothing should end up further
    // from where it was than the graph is wide.
    expect(worstShift).toBeLessThan(extentOf(after.values()));
  });

  it("stays bounded through several dumps in quick succession", () => {
    const scene = createGraphSimulation();
    let tabs: Tab[] = [];
    let worstSpeed = 0;
    for (let round = 0; round < 4; round++) {
      const batch = buildSyntheticDump(80).map((tab, index) => ({
        ...tab,
        id: `r${round}-${index}`,
        url: `${tab.url}#r${round}-${index}`,
      }));
      tabs = [...tabs, ...batch];
      const merged = mount(tabs, [], scene);
      // Only a few frames between dumps — the "user hammers the dump button"
      // case, where the layout never gets to finish settling.
      worstSpeed = Math.max(worstSpeed, run(merged, 10).worstSpeed);
    }
    expect(worstSpeed).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);

    const final = mount(tabs, [], scene);
    settle(final, 4000);
    expect(final.simulation.isSettled()).toBe(true);
    for (const point of positions(final).values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });
});

describe("dragging does not mutate group geometry", () => {
  /** The AABB graph-canvas.tsx draws for a cluster, honouring the drag exclusion. */
  function categoryRect(scene: Scene, clusterId: string) {
    const cluster = scene.tree.byId.get(clusterId)!;
    const excluded = scene.simulation.getBoundaryExcluded();
    const points = cluster.totalTabIds
      .filter((id) => id !== excluded)
      .map((id) => scene.simulation.findNode(id))
      .filter((node): node is NonNullable<typeof node> => Boolean(node && node.x !== undefined && node.y !== undefined))
      .map((node) => ({ x: node.x!, y: node.y!, radius: node.radius }));
    return computeCollectionBoundary(points, CATEGORY_BOUNDARY_PADDING);
  }

  it("keeps a group's box the same size while one of its tabs is dragged far away", () => {
    const scene = mount(buildSyntheticDump(120));
    settle(scene);

    const cluster = scene.tree.roots.find((root) => root.totalTabIds.length >= 5)!;
    const before = categoryRect(scene, cluster.id)!;
    const draggedId = cluster.totalTabIds[0];

    // Exactly what handlePointerDown does, then a long drag.
    scene.simulation.setBoundaryExcluded(draggedId);
    for (let i = 1; i <= 40; i++) {
      scene.simulation.pin(draggedId, 4000 + i * 20, 4000 + i * 20);
      scene.simulation.reheat(0.12);
      scene.simulation.tick();
    }

    const during = categoryRect(scene, cluster.id)!;
    // Without the exclusion the box would have grown to reach the pointer —
    // thousands of units. It is allowed to breathe as its remaining members
    // settle, but not to follow the drag.
    expect(during.width).toBeLessThan(before.width * 1.5 + 100);
    expect(during.height).toBeLessThan(before.height * 1.5 + 100);
    expect(Math.abs(during.x - before.x)).toBeLessThan(before.width);
  });

  it("brings a released tab back to its own group", () => {
    const scene = mount(buildSyntheticDump(120));
    settle(scene);

    const cluster = scene.tree.roots.find((root) => root.totalTabIds.length >= 5)!;
    const draggedId = cluster.totalTabIds[0];

    scene.simulation.setBoundaryExcluded(draggedId);
    for (let i = 0; i < 20; i++) {
      scene.simulation.pin(draggedId, 4000, 4000);
      scene.simulation.tick();
    }
    scene.simulation.unpin(draggedId);
    scene.simulation.setBoundaryExcluded(null);
    scene.simulation.reheat(0.5);
    settle(scene, 3000);

    const points = positions(scene);
    const dragged = points.get(draggedId)!;
    let nearestSibling = Infinity;
    for (const id of cluster.totalTabIds) {
      if (id === draggedId) continue;
      const sibling = points.get(id);
      if (!sibling) continue;
      nearestSibling = Math.min(nearestSibling, Math.hypot(dragged.x - sibling.x, dragged.y - sibling.y));
    }
    expect(nearestSibling).toBeLessThan(250);
  });

  it("a released tab rejoins the simulation at rest rather than carrying the flick", () => {
    const scene = mount(buildSyntheticDump(60));
    settle(scene);
    const id = scene.tabIds[0];

    scene.simulation.setBoundaryExcluded(id);
    // A very fast flick: 500 world units per frame.
    for (let i = 1; i <= 10; i++) {
      scene.simulation.pin(id, i * 500, 0);
      scene.simulation.tick();
    }
    const node = scene.simulation.findNode(id)!;
    expect(Math.hypot(node.vx ?? 0, node.vy ?? 0)).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);

    scene.simulation.unpin(id);
    scene.simulation.setBoundaryExcluded(null);
    const { worstSpeed } = run(scene, 60);
    expect(worstSpeed).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);
  });
});

describe("the real 283-tab export", () => {
  function loadExport() {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "tabdump-export.json"), "utf8"));
    const workspaces: Workspace[] = raw.workspaces ?? [];
    return {
      tabs: workspaces.flatMap((w) => w.tabs ?? []) as Tab[],
      sections: workspaces.flatMap((w) => w.sections ?? []) as Section[],
    };
  }

  it("settles into a compact, quiet layout with no runaway edges", () => {
    const data = loadExport();
    const scene = mount(data.tabs, data.sections);
    const { worstDisplacement, worstSpeed } = run(scene, 20);
    expect(worstDisplacement).toBeLessThan(60);
    expect(worstSpeed).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);

    settle(scene);
    expect(scene.simulation.isSettled()).toBe(true);
    const { stranded } = clusterCohesion(scene, positions(scene));
    expect(stranded).toBe(0);
  });
});

describe("performance at high node counts", () => {
  it("keeps a 500-node tick cheap enough for a 60fps frame budget", () => {
    const scene = mount(buildSyntheticDump(500));
    // Warm up past the seeded frame so the measurement covers steady-state
    // ticking rather than one-off setup.
    run(scene, 20);

    const start = Date.now();
    const ticks = 60;
    for (let i = 0; i < ticks; i++) scene.simulation.tick();
    const perTick = (Date.now() - start) / ticks;

    // Very loose: this is a smoke alarm for accidentally reintroducing an
    // O(n^2) pass into the tick path (d3's charge and collide are both
    // quadtree-backed), not a benchmark. A 16ms frame has to fit a tick plus
    // a full canvas repaint.
    expect(perTick).toBeLessThan(8);
  });

  it("builds a 500-tab edge set without a quadratic blowup in edge count", () => {
    const scene = mount(buildSyntheticDump(500));
    // Chained groups are O(n) per group; pairwise would be ~125,000 here.
    expect(scene.edgeCount).toBeLessThan(500 * 4);
  });
});
