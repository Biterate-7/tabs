/**
 * The "nothing in this graph ever stretches" suite.
 *
 * The reported failure was individual boundary squares blowing up to many
 * times their cluster's size while the rest of the graph looked fine. Its
 * cause was not in any single function — every unit test in
 * collection-layout.test.ts and boundary-drag.test.ts passed the whole time
 * it was on screen — but in the interaction between three things that only
 * meet in a running simulation: boundary squares are bounding boxes over
 * their members, membership OVERLAPS across tiers (a Collection cuts across
 * categories, a Subcategory sits inside one), and the boundary layer moved a
 * body's members rigidly. Any collision between two squares therefore pulled
 * some third cluster in half, and each half kept its own copy of the
 * confinement disc, so the split was permanent and the abandoned cluster's
 * box spanned the gap.
 *
 * So these tests run the real pipeline (see __fixtures__/graph-harness.ts)
 * and assert on what a frame would actually paint. They are deliberately
 * structural rather than pixel-based: the layout is physics-driven, so the
 * assertions are about bounds and invariants, never about exact coordinates.
 *
 * The mechanism underneath — the territory rules themselves — is asserted
 * separately in territory-invariants.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  boundaryBudget,
  buildWorkspace,
  makeGraph,
  type WorkspaceData,
} from "./__fixtures__/graph-harness";
import { nodeCollisionRadius } from "./engine";
import { BASE_NODE_RADIUS, MAX_NODE_RADIUS, clampNodeRadius, computeNodeRadius } from "./node-size";
import { sanitizeBody, type BoundaryBody } from "./boundary-physics";
import { loadGraphState, saveGraphState } from "./persistence";
import { worldToScreen } from "./layout";
import { DEFAULT_GRAPH_SETTINGS, MAX_GRAPH_COORD } from "./types";

type Graph = ReturnType<typeof makeGraph>;

/** Asserts every territory-backed square drawn this frame fits the disc its members live on. */
function expectBoundedSquares(graph: Graph, drawn: ReturnType<Graph["run"]>, label: string) {
  for (const boundary of drawn) {
    expect(Number.isFinite(boundary.rect.width), `${label}: ${boundary.label} width`).toBe(true);
    expect(Number.isFinite(boundary.rect.height), `${label}: ${boundary.label} height`).toBe(true);
    expect(boundary.rect.width, `${label}: ${boundary.label} width`).toBeGreaterThan(0);
    expect(boundary.rect.height, `${label}: ${boundary.label} height`).toBeGreaterThan(0);
    const budget = boundaryBudget(boundary.memberIds, graph.anchors, boundary.padding);
    if (budget === null) continue; // spans several discs by design
    const size = `${Math.round(boundary.rect.width)}x${Math.round(boundary.rect.height)}`;
    expect(
      Math.max(boundary.rect.width, boundary.rect.height),
      `${label}: ${boundary.kind} "${boundary.label}" ${size}`
    ).toBeLessThanOrEqual(budget);
  }
}

function makeBody(overrides: Partial<BoundaryBody> = {}): BoundaryBody {
  return {
    id: "b",
    memberIds: [],
    members: new Set(),
    x: 0,
    y: 0,
    halfWidth: 50,
    halfHeight: 50,
    vx: 0,
    vy: 0,
    // Governed by default: these bodies stand in for ordinary simulated
    // squares. A body is ungoverned only while the pointer holds every
    // member it could otherwise move — see BoundaryBody.governed.
    governed: true,
    asleep: false,
    dragging: false,
    lastGoodX: 0,
    lastGoodY: 0,
    ...overrides,
  };
}

describe("node and boundary dimensions", () => {
  // TEST 1 + TEST 7: nothing about a node's size moves on its own, however
  // long the simulation runs.
  it("keeps every node's radius bit-identical across a full settle", () => {
    const graph = makeGraph(buildWorkspace(220));
    const before = graph.radii();
    graph.run(1200);
    const after = graph.radii();
    expect(after).toEqual(before);
    for (const radius of after.values()) {
      expect(Number.isFinite(radius)).toBe(true);
      expect(radius).toBeGreaterThanOrEqual(BASE_NODE_RADIUS);
      expect(radius).toBeLessThanOrEqual(MAX_NODE_RADIUS);
    }
  });

  // THE REGRESSION. Before the territory rule, this fixture settled with
  // category boxes at 1935x645 against a ~330px budget, and 238 of 300 tabs
  // outside their own confinement disc; the same assertions run against the
  // pre-fix engine report boxes of 638914x3451 and 15686641px.
  it("never lets a cluster's square grow past the disc its members are confined to", () => {
    const graph = makeGraph(buildWorkspace(300));
    const drawn = graph.run(1500);
    expectBoundedSquares(graph, drawn, "settled");

    const { worst, outside } = graph.confinementOvershoot();
    expect(worst, "worst confinement overshoot (px)").toBeLessThan(60);
    // Counted against each tab's OWN disc now, not its category's — see the
    // harness's confinementOvershoot. That is a tighter target, and it counts
    // anything more than 1px out, so the share it reports is dominated by tabs
    // resting a hair past their own rim: confineToRegions is a partial
    // pullback by design (see the next test), and the same fixture with the
    // boundary layer switched off entirely measures 0.413 here with a worst
    // overshoot of 2.8px. The bound is on the stretching bug — which put 238
    // of 300 tabs outside, the worst by 1450px — not on the rim equilibrium.
    expect(outside / graph.nodes.length, "share of tabs outside their own disc").toBeLessThan(0.45);
  });

  /**
   * What the residual overshoot IS, proved by removing the boundary layer.
   *
   * A settled layout rests with some members a little way outside their disc,
   * and the question that matters is whether that is the stretching bug in
   * miniature or an ordinary property of the layout. It is the latter, and
   * this is the control that shows it: the identical pipeline with NO
   * boundary bodies at all — nothing that could translate a member — produces
   * the same residual. One mechanism accounts for it, by design:
   * confineToRegions is a PARTIAL pullback, not a wall. It moves a node half
   * of its overshoot back per tick and cancels only its outward radial
   * velocity, deliberately, so members settle inside the disc rather than
   * piling against its rim (see REGION_DISC_SCALE's note on the crescent
   * artifact). Equilibrium is therefore a few px outside, where the halving
   * balances what charge/collide push out per tick.
   *
   * There used to be a second mechanism, and it was a defect rather than
   * geometry — see the assertion at the end, which is the one that used to
   * document it, inverted.
   */
  it("has a settle equilibrium that does not come from the boundary layer", () => {
    const data = buildWorkspace(300);
    const withBodies = makeGraph(data);
    const withoutBodies = makeGraph(data, {}, { bodies: false });
    withBodies.run(1200);
    withoutBodies.run(1200);

    const bodied = withBodies.confinementOvershoot();
    const bare = withoutBodies.confinementOvershoot();

    // The control has a residual of its own, so the residual is not the
    // boundary layer's doing…
    expect(bare.worst).toBeGreaterThan(0);
    // …and switching the boundary layer on does not materially add to it.
    // The pre-fix engine measured 1450px here against the same control.
    expect(bodied.worst).toBeLessThan(bare.worst + 30);
    expect(bodied.outside).toBeLessThan(bare.outside * 1.5 + 10);

    // The mechanism that is NOT in the list above any more, on the shape that
    // used to exhibit it worst: a two-tab category holding a two-tab
    // subcategory. Its sub-disc was capped at 0.42x its parent's, and the
    // parent's is only ~65px across for two tabs, so the sub-disc came out
    // ~54px wide — narrower than the ~56px two collide-spaced nodes occupy
    // once their own radii are counted. The two members could not both fit
    // inside the disc they were being held in, so they rested outside it, and
    // the same cap made a 60-tab subsection 5.3x over-dense (measured: the
    // closest pair settling 12px inside each other) with charge/collide and
    // confineToRegions then fighting every tick forever.
    //
    // A disc that cannot hold its own members is not geometry to be documented
    // — it is the layout half of the large-subsection drag bug. The smallest
    // sub-disc a workspace can produce now holds its members.
    const tiny = makeGraph(buildWorkspace(2, { categories: 1, subcategoryShare: 1, collections: 0 }));
    const tightestSubDisc = [...tiny.anchors.values()]
      .filter((a) => a.confineWithin && a.confineTo)
      .map((a) => a.confineTo!.r)
      .reduce((min, r) => Math.min(min, r), Infinity);
    expect(Number.isFinite(tightestSubDisc)).toBe(true);
    // Centre-to-centre spacing collide insists on, plus the radius each node
    // adds at either end — the span the two members actually occupy.
    const memberSpan = nodeCollisionRadius(BASE_NODE_RADIUS) * 2 + BASE_NODE_RADIUS * 2;
    expect(
      tightestSubDisc * 2,
      `sub-disc ${(tightestSubDisc * 2).toFixed(1)}px vs member span ${memberSpan}px`
    ).toBeGreaterThanOrEqual(memberSpan);
  });

  // TEST 4: cluster geometry has no channel into a node's own size, and one
  // cluster's square cannot pull another cluster's members apart.
  it("leaves node sizes and neighbouring clusters intact when a boundary square is dragged", () => {
    const graph = makeGraph(buildWorkspace(200));
    const drawn = graph.run(900);
    const before = graph.radii();

    const category = drawn.find((b) => b.kind === "category" && graph.simulation.getBoundaryBody(b.id))!;
    const body = graph.simulation.getBoundaryBody(category.id)!;

    // Haul it right across the graph, in the jumpy way a real pointer does.
    graph.simulation.beginBoundaryDrag(category.id, body.x, body.y);
    for (let i = 1; i <= 60; i++) {
      graph.simulation.moveBoundaryDrag(body.x + i * 90, body.y + i * 55);
      graph.frame();
    }
    graph.simulation.endBoundaryDrag();
    const after = graph.run(600);

    expect(graph.radii()).toEqual(before);
    expectBoundedSquares(graph, after, "after a long drag");
  });

  // TEST 8: the same, under drag input far more violent than a pointer emits.
  it("holds every square inside its disc under teleporting, alternating drags", () => {
    const graph = makeGraph(buildWorkspace(200));
    const drawn = graph.run(700);
    const before = graph.radii();
    const targets = drawn.filter((b) => graph.simulation.getBoundaryBody(b.id)).slice(0, 6);

    for (const target of targets) {
      const body = graph.simulation.getBoundaryBody(target.id);
      if (!body) continue;
      graph.simulation.beginBoundaryDrag(target.id, body.x, body.y);
      for (let i = 0; i < 25; i++) {
        // Alternating extremes: a full-graph jump every single frame.
        graph.simulation.moveBoundaryDrag(i % 2 === 0 ? 6000 : -6000, i % 3 === 0 ? -5000 : 4500);
        graph.frame();
      }
      graph.simulation.endBoundaryDrag();
      graph.run(120);
    }

    expect(graph.radii()).toEqual(before);
    expectBoundedSquares(graph, graph.run(400), "after violent drags");
  });

  // TEST 2: a node drag is a position, never a size.
  it("changes only x/y when a node is dragged", () => {
    const graph = makeGraph(buildWorkspace(80));
    graph.run(400);
    const id = graph.nodes[7].id;
    const before = graph.radii();
    const start = graph.simulation.findNode(id)!;
    const from = { x: start.x!, y: start.y! };

    // Reheating is what a pointerdown does in graph-canvas.tsx; without it a
    // settled simulation never ticks and the pin is never applied.
    graph.simulation.reheat(0.6);
    graph.simulation.pin(id, from.x, from.y);
    for (let i = 1; i <= 40; i++) {
      graph.simulation.pin(id, from.x + i * 45, from.y - i * 30);
      graph.simulation.reheat(0.35);
      graph.frame();
    }

    const dragged = graph.simulation.findNode(id)!;
    expect(Math.hypot(dragged.x! - from.x, dragged.y! - from.y)).toBeGreaterThan(100);
    expect(graph.radii()).toEqual(before);

    graph.simulation.unpin(id);
    graph.run(200);
    expect(graph.radii()).toEqual(before);
  });

  // TEST 3 + TEST 10: the camera is a paint-time projection, and no two nodes
  // share a size.
  it("keeps logical dimensions independent of the camera and of each other", () => {
    const graph = makeGraph(buildWorkspace(60));
    graph.run(300);
    const before = graph.radii();

    for (const zoom of [0.05, 0.5, 1, 4, 20]) {
      for (const node of graph.nodes) {
        const physicsNode = graph.simulation.findNode(node.id)!;
        // Projecting is all the camera ever does — it returns a point and
        // writes nothing back into the node.
        worldToScreen({ x: 120, y: -80, zoom }, { x: physicsNode.x!, y: physicsNode.y! }, 1440, 900);
      }
      graph.frame();
    }
    expect(graph.radii()).toEqual(before);

    // Every node carries its own number, so mutating one cannot reach another.
    const first = graph.simulation.findNode(graph.nodes[0].id)!;
    const second = graph.simulation.findNode(graph.nodes[1].id)!;
    first.radius = 999;
    expect(second.radius).toBe(before.get(graph.nodes[1].id));
    first.radius = before.get(graph.nodes[0].id)!;
  });

  // TEST 5 + TEST 6: bad numbers are refused at every door into the model.
  describe("invalid dimensions", () => {
    it("never lets a malformed signal become a node radius", () => {
      expect(computeNodeRadius("connections", Number.NaN, undefined)).toBe(BASE_NODE_RADIUS);
      // Infinity is "as connected as it gets", which the connection curve
      // already flattens at 12 links — a finite, in-range radius either way.
      const unbounded = computeNodeRadius("connections", Number.POSITIVE_INFINITY, undefined);
      expect(unbounded).toBeGreaterThanOrEqual(BASE_NODE_RADIUS);
      expect(unbounded).toBeLessThanOrEqual(MAX_NODE_RADIUS);
      expect(computeNodeRadius("connections", -50, undefined)).toBe(BASE_NODE_RADIUS);
      expect(computeNodeRadius("relevance", 0, Number.NaN)).toBe(BASE_NODE_RADIUS);
      expect(computeNodeRadius("relevance", 0, Number.POSITIVE_INFINITY)).toBe(BASE_NODE_RADIUS);
      expect(clampNodeRadius(Number.NaN)).toBe(BASE_NODE_RADIUS);
      expect(clampNodeRadius(-1)).toBe(BASE_NODE_RADIUS);
      expect(clampNodeRadius(1e9)).toBe(MAX_NODE_RADIUS);
      // The collision geometry is derived from the same one number, so it is
      // bounded by construction rather than by a second guard.
      expect(Number.isFinite(nodeCollisionRadius(clampNodeRadius(Number.NaN)))).toBe(true);
    });

    it("clamps a radius supplied by the caller before it reaches the physics", () => {
      const graph = makeGraph(buildWorkspace(20));
      graph.simulation.setNodes(graph.nodes, () => Number.NaN, {});
      for (const node of graph.nodes) {
        expect(graph.simulation.findNode(node.id)!.radius).toBe(BASE_NODE_RADIUS);
      }
      graph.simulation.setNodes(graph.nodes, () => 1e12, {});
      for (const node of graph.nodes) {
        expect(graph.simulation.findNode(node.id)!.radius).toBe(MAX_NODE_RADIUS);
      }
    });

    it("repairs a boundary body whose extents have gone bad instead of drawing them", () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
        const body = makeBody({ halfWidth: bad, halfHeight: bad });
        expect(sanitizeBody(body)).toBe(true);
        expect(body.halfWidth).toBe(0);
        expect(body.halfHeight).toBe(0);
      }
      const huge = makeBody({ halfWidth: 1e30, halfHeight: 1e30 });
      sanitizeBody(huge);
      expect(huge.halfWidth).toBeLessThanOrEqual(MAX_GRAPH_COORD);
      expect(huge.halfHeight).toBeLessThanOrEqual(MAX_GRAPH_COORD);
    });

    it("refuses a saved position that could never have been written legitimately", () => {
      saveGraphState({
        version: 1,
        positions: {
          fine: { x: 120, y: -80 },
          nan: { x: Number.NaN, y: 0 } as { x: number; y: number },
          huge: { x: 1e300, y: 0 },
        },
        boundaryOffsets: { fine: { x: 5, y: 5 }, huge: { x: -1e300, y: 0 } },
        manualConnections: [],
        settings: DEFAULT_GRAPH_SETTINGS,
      });
      const loaded = loadGraphState();
      expect(Object.keys(loaded.positions)).toEqual(["fine"]);
      expect(Object.keys(loaded.boundaryOffsets)).toEqual(["fine"]);
    });

    it("keeps a NaN seeded into one node from spreading to the layout", () => {
      const graph = makeGraph(buildWorkspace(60));
      graph.run(300);
      const victim = graph.simulation.findNode(graph.nodes[3].id)!;
      victim.x = Number.NaN;
      victim.y = Number.NaN;
      graph.simulation.reheat(0.8);
      graph.run(120);

      for (const node of graph.nodes) {
        const physicsNode = graph.simulation.findNode(node.id)!;
        expect(Number.isFinite(physicsNode.x), `${node.id}.x`).toBe(true);
        expect(Number.isFinite(physicsNode.y), `${node.id}.y`).toBe(true);
      }
      expectBoundedSquares(graph, graph.boundaryPass(), "after a NaN");
    });
  });

  // TEST 9: there is no DOM measurement in the sizing pipeline at all, so a
  // screen-space rect has no route into a logical dimension. A structural
  // check, because the failure it guards against is an import away.
  it("derives dimensions from the model only, never from a measured element", () => {
    const measurements = [
      "getBoundingClientRect",
      "offsetWidth",
      "offsetHeight",
      "clientWidth",
      "clientHeight",
      "ResizeObserver",
      "devicePixelRatio",
      "innerWidth",
      "innerHeight",
    ];
    const sizingModules = [
      "node-size.ts",
      "collection-layout.ts",
      "boundary-physics.ts",
      "boundary-frames.ts",
      "cluster-regions.ts",
      "clusters.ts",
      "engine.ts",
    ];
    for (const file of sizingModules) {
      const source = readFileSync(join(process.cwd(), "src/lib/graph", file), "utf8");
      for (const api of measurements) {
        expect(source.includes(api), `${file} must not read ${api}`).toBe(false);
      }
    }
  });

  // Content is drawn, never measured into geometry — so it cannot expand a node.
  it("is unaffected by very long titles and urls", () => {
    const plain = makeGraph(buildWorkspace(120));
    const wordy = makeGraph(buildWorkspace(120, { longText: true }));
    plain.run(600);
    wordy.run(600);
    expect([...wordy.radii().values()]).toEqual([...plain.radii().values()]);
  });

  // Tabs arriving and leaving mid-flight must not leave a square spanning
  // where a cluster used to be.
  it("stays bounded while tabs are added and removed", () => {
    const graph = makeGraph(buildWorkspace(180));
    graph.run(500);

    for (let round = 0; round < 4; round++) {
      graph.install(graph.nodes.filter((_, i) => (i + round) % 3 !== 0));
      graph.simulation.reheat(0.6);
      graph.run(150);
      graph.install();
      graph.simulation.reheat(0.6);
      graph.run(150);
    }

    expectBoundedSquares(graph, graph.run(400), "after churn");
  });

  // A workspace already carrying the corruption on disk must come back healed,
  // not restored — the split offsets are what survived reloads.
  it("heals a saved layout whose tabs were displaced one at a time", () => {
    const data: WorkspaceData = buildWorkspace(120);
    const graph = makeGraph(data);
    const torn: Record<string, { x: number; y: number }> = {};
    const category = graph.tree.roots[0];
    category.totalTabIds.forEach((id, i) => {
      // Half the category carried 2500px away, half left behind: exactly the
      // shape the old per-tab offsets wrote.
      torn[id] = i % 2 === 0 ? { x: 2500, y: 1800 } : { x: 0, y: 0 };
    });

    graph.install(graph.nodes, {}, torn);
    expectBoundedSquares(graph, graph.run(900), "after healing a torn record");
  });
});

/**
 * Every shape of drag the graph supports, checked for the same four things
 * each time: the move lands, no dimension moves with it, territory membership
 * is untouched, and members stay coherent relative to one another.
 */
describe("drag safety", () => {
  type Scenario = {
    name: string;
    build: () => Graph;
    /** The boundary to grab, or null to drag a plain node. */
    pick: (graph: Graph, drawn: ReturnType<Graph["run"]>) => string | null;
    settleFirst?: number;
  };

  const scenarios: Scenario[] = [
    {
      name: "an individual tab",
      build: () => makeGraph(buildWorkspace(120)),
      pick: () => null,
    },
    {
      name: "a category",
      build: () => makeGraph(buildWorkspace(180)),
      pick: (graph, drawn) => drawn.find((b) => b.kind === "category" && graph.simulation.getBoundaryBody(b.id))?.id ?? null,
    },
    {
      name: "a subcategory",
      build: () => makeGraph(buildWorkspace(180)),
      pick: (graph, drawn) =>
        drawn.find((b) => b.kind === "subcategory" && graph.simulation.getBoundaryBody(b.id))?.id ?? null,
    },
    {
      name: "a category with no children",
      build: () => makeGraph(buildWorkspace(120, { subcategoryShare: 0 })),
      pick: (graph, drawn) => drawn.find((b) => b.kind === "category" && graph.simulation.getBoundaryBody(b.id))?.id ?? null,
    },
    {
      name: "a category with many members",
      build: () => makeGraph(buildWorkspace(400, { categories: 2 })),
      pick: (graph, drawn) => drawn.find((b) => b.kind === "category" && graph.simulation.getBoundaryBody(b.id))?.id ?? null,
    },
    {
      name: "a square while the layout is still settling",
      build: () => makeGraph(buildWorkspace(180)),
      settleFirst: 20,
      pick: (graph, drawn) => drawn.find((b) => graph.simulation.getBoundaryBody(b.id))?.id ?? null,
    },
    {
      name: "a square in the very first frames after initialization",
      build: () => makeGraph(buildWorkspace(180)),
      settleFirst: 1,
      pick: (graph, drawn) => drawn.find((b) => graph.simulation.getBoundaryBody(b.id))?.id ?? null,
    },
    {
      name: "a square immediately after restoring a saved layout",
      build: () => {
        const data = buildWorkspace(180);
        const seeded = makeGraph(data);
        seeded.run(500);
        const positions: Record<string, { x: number; y: number }> = {};
        for (const node of seeded.nodes) {
          const physicsNode = seeded.simulation.findNode(node.id)!;
          positions[node.id] = { x: physicsNode.x!, y: physicsNode.y! };
        }
        const restored = makeGraph(data, positions);
        restored.install(restored.nodes, positions, seeded.simulation.getBoundaryOffsets());
        return restored;
      },
      settleFirst: 1,
      pick: (graph, drawn) => drawn.find((b) => graph.simulation.getBoundaryBody(b.id))?.id ?? null,
    },
  ];

  for (const scenario of scenarios) {
    it(`drags ${scenario.name} without changing any dimension`, () => {
      const graph = scenario.build();
      const drawn = graph.run(scenario.settleFirst ?? 500);
      const radiiBefore = graph.radii();
      const membershipBefore = graph.territoryOfTab();
      const target = scenario.pick(graph, drawn);

      if (target === null && scenario.pick.length === 0) {
        // Node drag.
        const id = graph.nodes[5].id;
        const physicsNode = graph.simulation.findNode(id)!;
        const from = { x: physicsNode.x!, y: physicsNode.y! };
        graph.simulation.reheat(0.6);
        for (let i = 1; i <= 30; i++) {
          graph.simulation.pin(id, from.x + i * 60, from.y + i * 40);
          graph.simulation.reheat(0.35);
          graph.frame();
        }
        expect(Math.hypot(graph.simulation.findNode(id)!.x! - from.x, graph.simulation.findNode(id)!.y! - from.y)).toBeGreaterThan(
          100
        );
        graph.simulation.unpin(id);
      } else {
        expect(target, `${scenario.name}: nothing draggable to test`).not.toBeNull();
        const body = graph.simulation.getBoundaryBody(target!)!;
        const members = graph.tree.byId.get(target!)?.totalTabIds ?? [];
        const before = graph.positionsOf(members);
        graph.simulation.beginBoundaryDrag(target!, body.x, body.y);
        for (let i = 1; i <= 20; i++) {
          graph.simulation.moveBoundaryDrag(body.x + i * 60, body.y - i * 45);
          graph.frame();
        }
        graph.simulation.endBoundaryDrag();
        const after = graph.positionsOf(members);

        // The move landed on at least some of what was grabbed…
        const moved = members.filter(
          (id) =>
            before.has(id) &&
            after.has(id) &&
            Math.hypot(after.get(id)!.x - before.get(id)!.x, after.get(id)!.y - before.get(id)!.y) > 20
        );
        expect(moved.length, `${scenario.name}: the drag moved nothing`).toBeGreaterThan(0);
      }

      const settled = graph.run(400);
      // …dimensions did not move with it…
      expect(graph.radii(), `${scenario.name}: a radius changed`).toEqual(radiiBefore);
      expectBoundedSquares(graph, settled, scenario.name);
      // …and membership is exactly what it was.
      expect(graph.territoryOfTab()).toEqual(membershipBefore);
    }, 60000);
  }

  it("survives rapid repeated drags of different squares back to back", () => {
    const graph = makeGraph(buildWorkspace(200));
    let drawn = graph.run(500);
    const radiiBefore = graph.radii();

    for (let round = 0; round < 15; round++) {
      const draggable = drawn.filter((b) => graph.simulation.getBoundaryBody(b.id));
      if (draggable.length === 0) break;
      const target = draggable[round % draggable.length];
      const body = graph.simulation.getBoundaryBody(target.id)!;
      graph.simulation.beginBoundaryDrag(target.id, body.x, body.y);
      // Release after a single frame, over and over — the "grab, flick, grab
      // something else" gesture that leaves bodies coasting into each other.
      graph.simulation.moveBoundaryDrag(body.x + 700, body.y - 500);
      drawn = graph.frame();
      graph.simulation.endBoundaryDrag();
      drawn = graph.run(8);
    }

    expect(graph.radii()).toEqual(radiiBefore);
    expectBoundedSquares(graph, graph.run(500), "after rapid drags");
  }, 60000);
});

/**
 * The numeric guards are a floor under the arithmetic, not a layout rule, and
 * that distinction only holds if a real graph never comes near them. These
 * measure the gap.
 */
describe("defensive limits", () => {
  it("leaves a large graph orders of magnitude inside the coordinate ceiling", () => {
    const graph = makeGraph(buildWorkspace(1000, { categories: 10 }));
    graph.run(1500);

    let farthest = 0;
    for (const node of graph.nodes) {
      const physicsNode = graph.simulation.findNode(node.id)!;
      farthest = Math.max(farthest, Math.abs(physicsNode.x!), Math.abs(physicsNode.y!));
    }
    // A thousand tabs reach a few thousand world units. The ceiling is 1e7,
    // so nothing in a real graph is ever clamped, recovered or snapped toward
    // the origin by it — it only ever catches arithmetic that has already
    // gone wrong.
    expect(farthest).toBeGreaterThan(0);
    expect(farthest, `farthest node at ${Math.round(farthest)}`).toBeLessThan(MAX_GRAPH_COORD / 100);

    // Boundary bodies live in the same world and stay inside it too.
    for (const boundary of graph.boundaryPass()) {
      const body = graph.simulation.getBoundaryBody(boundary.id);
      if (!body) continue;
      expect(Math.abs(body.x)).toBeLessThan(MAX_GRAPH_COORD / 100);
      expect(Math.abs(body.y)).toBeLessThan(MAX_GRAPH_COORD / 100);
      expect(body.halfWidth).toBeLessThan(MAX_GRAPH_COORD / 100);
      expect(body.halfHeight).toBeLessThan(MAX_GRAPH_COORD / 100);
    }
  }, 180000);

  it("never coerces a radius a legitimate caller asks for", () => {
    // Every value computeNodeRadius can produce, across every mode and every
    // plausible input, already sits inside the clamp — so the clamp changes
    // nothing that is not already broken.
    for (const mode of ["uniform", "connections", "relevance"] as const) {
      for (let signal = 0; signal <= 200; signal++) {
        const radius = computeNodeRadius(mode, signal, signal / 10);
        expect(clampNodeRadius(radius)).toBe(radius);
      }
    }
  });
});

/**
 * The territory work runs on every animation frame, so it has to stay cheap.
 * These are shape checks, not benchmarks: they assert that the per-frame cost
 * grows about linearly with the graph, which is what rules out an accidental
 * O(n^2) in the admission or translation path. Thresholds are deliberately
 * loose — this catches an algorithmic regression, not a slow machine.
 */
describe("complexity", () => {
  function measureFrameCost(total: number): number {
    const graph = makeGraph(buildWorkspace(total, { collections: Math.max(2, Math.round(total / 40)) }));
    graph.run(120);
    const started = performance.now();
    for (let i = 0; i < 40; i++) graph.frame();
    return (performance.now() - started) / 40;
  }

  it("costs about linearly per frame from 50 to 500 tabs", () => {
    const small = measureFrameCost(50);
    const large = measureFrameCost(500);
    // 10x the tabs. Linear would be ~10x the cost; the node simulation itself
    // is superlinear (forceCollide/forceManyBody are n log n), so the bar is
    // set at 40x — comfortably above that, and far below the ~100x a
    // quadratic territory pass would show.
    const ratio = large / Math.max(small, 0.01);
    expect(ratio, `50 tabs ${small.toFixed(2)}ms vs 500 tabs ${large.toFixed(2)}ms`).toBeLessThan(40);
  }, 120000);

  it("admits and moves boundaries in time proportional to their membership", () => {
    const graph = makeGraph(buildWorkspace(500));
    graph.run(200);
    const drawn = graph.boundaryPass();
    const specs = drawn.map((b) => ({ id: b.id, memberIds: b.memberIds, padding: b.padding }));

    const started = performance.now();
    for (let i = 0; i < 200; i++) graph.simulation.setBoundaryBodies(specs);
    const perCall = (performance.now() - started) / 200;

    // One pass over each square's members, on a 500-tab graph with dozens of
    // squares. A per-square scan of every territory would be orders of
    // magnitude slower than this.
    expect(perCall, `${perCall.toFixed(3)}ms per setBoundaryBodies`).toBeLessThan(15);
  }, 120000);
});
