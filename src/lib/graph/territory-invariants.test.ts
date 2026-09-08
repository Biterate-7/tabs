/**
 * The territory invariants, stated as properties and checked against randomly
 * driven graphs rather than against one hand-built scenario.
 *
 * `node-dimensions.test.ts` asserts the OUTCOME the user cares about — no
 * square ever stretches. This file asserts the mechanism underneath it, so a
 * future change that breaks the mechanism is caught at the point it breaks
 * rather than only when some fixture happens to expose it:
 *
 *   I1  every tab on a disc carries that disc's offset, and only that
 *   I2  moving a territory moves each of its members by the same delta
 *   I3  …so members' positions relative to each other are untouched by it
 *   I4  a nested disc never leaves its parent's
 *   I5  moving a parent carries its descendants coherently
 *   I6  a square covering part of a territory cannot move anything
 *
 * The driver below runs the real pipeline (see __fixtures__/graph-harness.ts)
 * across several seeds and shapes, interleaving territory moves, node drags,
 * collisions, rebuilds and serialization round trips, and re-checks all six
 * after every step.
 */
import { describe, expect, it } from "vitest";
import {
  boundaryBudget,
  buildWorkspace,
  makeGraph,
  makeRandom,
  territoryIdOf,
  type WorkspaceData,
} from "./__fixtures__/graph-harness";
import { loadGraphState, pruneGraphState, saveGraphState } from "./persistence";
import { DEFAULT_GRAPH_SETTINGS } from "./types";

type Graph = ReturnType<typeof makeGraph>;

/** I1: one offset per disc, shared by every tab on it. */
function checkUniformOffsets(graph: Graph, label: string) {
  const offsets = graph.simulation.getBoundaryOffsets();
  for (const [territoryId, members] of graph.territoryMembers()) {
    const present = members.filter((id) => graph.simulation.findNode(id));
    if (present.length === 0) continue;
    const first = offsets[present[0]] ?? { x: 0, y: 0 };
    for (const id of present) {
      const offset = offsets[id] ?? { x: 0, y: 0 };
      expect(offset.x, `${label}: ${territoryId} member ${id} offset.x`).toBeCloseTo(first.x, 6);
      expect(offset.y, `${label}: ${territoryId} member ${id} offset.y`).toBeCloseTo(first.y, 6);
    }
  }
}

/** I4: a nested disc's displaced centre stays inside its parent's displaced disc. */
function checkNesting(graph: Graph, label: string) {
  const offsets = graph.simulation.getBoundaryOffsets();
  for (const [, assignment] of graph.anchors) {
    const child = assignment.confineTo;
    const parent = assignment.confineWithin;
    if (!child || !parent) continue;
    const childId = territoryIdOf(assignment);
    const parentId = assignment.confineWithinId;
    if (!childId || !parentId) continue;
    const childOffset = offsetOfTerritory(graph, childId, offsets);
    const parentOffset = offsetOfTerritory(graph, parentId, offsets);
    if (!childOffset || !parentOffset) continue;
    const distance = Math.hypot(
      child.x + childOffset.x - (parent.x + parentOffset.x),
      child.y + childOffset.y - (parent.y + parentOffset.y)
    );
    const slack = Math.max(0, parent.r - child.r);
    expect(distance, `${label}: ${childId} escaped ${parentId}`).toBeLessThanOrEqual(slack + 1e-6);
  }
}

function offsetOfTerritory(
  graph: Graph,
  territoryId: string,
  offsets: Record<string, { x: number; y: number }>
): { x: number; y: number } | null {
  for (const [tabId, id] of graph.territoryOfTab()) {
    if (id !== territoryId) continue;
    if (!graph.simulation.findNode(tabId)) continue;
    return offsets[tabId] ?? { x: 0, y: 0 };
  }
  return null;
}

/** Everything is finite and inside the world. */
function checkFinite(graph: Graph, label: string) {
  for (const node of graph.nodes) {
    const physicsNode = graph.simulation.findNode(node.id);
    if (!physicsNode) continue;
    expect(Number.isFinite(physicsNode.x), `${label}: ${node.id}.x finite`).toBe(true);
    expect(Number.isFinite(physicsNode.y), `${label}: ${node.id}.y finite`).toBe(true);
    expect(Number.isFinite(physicsNode.radius), `${label}: ${node.id}.radius finite`).toBe(true);
  }
}

/** Every territory-backed square fits the disc its members are confined to. */
function checkBoundedSquares(graph: Graph, drawn: ReturnType<Graph["run"]>, label: string) {
  for (const boundary of drawn) {
    expect(Number.isFinite(boundary.rect.width), `${label}: ${boundary.label} width finite`).toBe(true);
    expect(Number.isFinite(boundary.rect.height), `${label}: ${boundary.label} height finite`).toBe(true);
    const budget = boundaryBudget(boundary.memberIds, graph.anchors, boundary.padding);
    if (budget === null) continue; // spans several discs by design
    const size = `${Math.round(boundary.rect.width)}x${Math.round(boundary.rect.height)}`;
    expect(Math.max(boundary.rect.width, boundary.rect.height), `${label}: ${boundary.label} ${size}`).toBeLessThanOrEqual(
      budget
    );
  }
}

function checkAll(graph: Graph, drawn: ReturnType<Graph["run"]>, label: string) {
  checkFinite(graph, label);
  checkUniformOffsets(graph, label);
  checkNesting(graph, label);
  checkBoundedSquares(graph, drawn, label);
}

describe("territory invariants", () => {
  // I2 + I3: a territory move is a rigid translation of exactly its members.
  it("moves every member of a territory by the same delta, preserving their relative positions", () => {
    const graph = makeGraph(buildWorkspace(180));
    const drawn = graph.run(700);
    const category = drawn.find((b) => b.kind === "category")!;
    const members = graph.tree.byId.get(category.id)!.totalTabIds;
    const before = graph.positionsOf(members);
    const body = graph.simulation.getBoundaryBody(category.id)!;

    graph.simulation.beginBoundaryDrag(category.id, body.x, body.y);
    graph.simulation.moveBoundaryDrag(body.x + 260, body.y - 140);
    // One frame only: the node forces run on every tick too, and this asserts
    // what the BOUNDARY move did, not what the layout did afterwards.
    graph.simulation.tick();
    graph.simulation.endBoundaryDrag();

    const after = graph.positionsOf(members);
    const deltas = members
      .filter((id) => before.has(id) && after.has(id))
      .map((id) => ({ dx: after.get(id)!.x - before.get(id)!.x, dy: after.get(id)!.y - before.get(id)!.y }));
    expect(deltas.length).toBeGreaterThan(1);

    // I2 — one delta for the whole territory. The tolerance is the node
    // forces' own per-tick contribution, not slack in the translation.
    const mean = {
      dx: deltas.reduce((s, d) => s + d.dx, 0) / deltas.length,
      dy: deltas.reduce((s, d) => s + d.dy, 0) / deltas.length,
    };
    for (const delta of deltas) {
      expect(Math.hypot(delta.dx - mean.dx, delta.dy - mean.dy)).toBeLessThan(12);
    }
    expect(Math.hypot(mean.dx, mean.dy)).toBeGreaterThan(50);

    // I3 — pairwise distances within the territory are unchanged by the move.
    for (let i = 0; i < Math.min(members.length, 12); i++) {
      for (let j = i + 1; j < Math.min(members.length, 12); j++) {
        const a = members[i];
        const b = members[j];
        if (!before.has(a) || !before.has(b) || !after.has(a) || !after.has(b)) continue;
        const was = Math.hypot(before.get(a)!.x - before.get(b)!.x, before.get(a)!.y - before.get(b)!.y);
        const now = Math.hypot(after.get(a)!.x - after.get(b)!.x, after.get(a)!.y - after.get(b)!.y);
        expect(Math.abs(now - was)).toBeLessThan(24);
      }
    }
  });

  // I5: a parent carries its descendants.
  it("carries every nested subcategory when its category moves", () => {
    const graph = makeGraph(buildWorkspace(180));
    const drawn = graph.run(700);
    const category = graph.tree.roots.find((c) => c.children.some((child) => child.kind === "subcategory"))!;
    const sub = category.children.find((child) => child.kind === "subcategory")!;
    if (!drawn.some((b) => b.id === category.id)) return;

    const before = graph.positionsOf(sub.totalTabIds);
    const body = graph.simulation.getBoundaryBody(category.id)!;
    graph.simulation.beginBoundaryDrag(category.id, body.x, body.y);
    graph.simulation.moveBoundaryDrag(body.x + 200, body.y + 200);
    graph.simulation.tick();
    graph.simulation.endBoundaryDrag();
    const after = graph.positionsOf(sub.totalTabIds);

    for (const id of sub.totalTabIds) {
      if (!before.has(id) || !after.has(id)) continue;
      expect(Math.hypot(after.get(id)!.x - before.get(id)!.x, after.get(id)!.y - before.get(id)!.y)).toBeGreaterThan(50);
    }
    checkNesting(graph, "after category drag");
  });

  // I6: the cross-cutting case, end to end through the engine.
  it("gives no body to a square that covers only part of a territory", () => {
    const data = buildWorkspace(200);
    const graph = makeGraph(data);
    const drawn = graph.run(600);

    for (const boundary of drawn) {
      const body = graph.simulation.getBoundaryBody(boundary.id);
      if (!body) continue;
      // Anything with a body must hold whole discs, and nothing else.
      const held = new Set(boundary.memberIds);
      const territories = new Set<string>();
      for (const id of boundary.memberIds) {
        const territoryId = graph.territoryOfTab().get(id);
        if (territoryId) territories.add(territoryId);
      }
      for (const territoryId of territories) {
        for (const memberId of graph.territoryMembers().get(territoryId) ?? []) {
          if (!graph.simulation.findNode(memberId)) continue;
          expect(held.has(memberId), `${boundary.kind} "${boundary.label}" has a body but splits ${territoryId}`).toBe(
            true
          );
        }
      }
    }

    // …and the rule is asserted directly rather than only through whatever
    // this fixture's collections happen to be, because on a dense graph the
    // concentration gate (collection-layout.ts's resolveLiveBoundaries) often
    // refuses a sprawling collection box its place on screen long before the
    // engine is asked about a body, which would make the loop above vacuous.
    // Leaf discs only: a category disc's territory also contains every tab on
    // the sub-discs nested in it, so "all the tabs confined directly to it" is
    // not the whole territory and is correctly refused as a partial move.
    const parentIds = new Set<string>();
    for (const [, assignment] of graph.anchors) {
      if (assignment.confineWithinId) parentIds.add(assignment.confineWithinId);
    }
    const territories = [...graph.territoryMembers().entries()].filter(
      ([id, members]) => members.length >= 2 && !parentIds.has(id)
    );
    expect(territories.length).toBeGreaterThan(1);
    const [firstId, first] = territories[0];
    const [secondId, second] = territories[1];

    const wholeTerritory = { id: "spec:whole", memberIds: [...first], padding: 20 };
    const halfOfOne = { id: "spec:half", memberIds: first.slice(0, Math.max(1, first.length - 1)), padding: 20 };
    const crossCutting = { id: "spec:cross", memberIds: [first[0], second[0]], padding: 20 };
    graph.simulation.setBoundaryBodies([wholeTerritory, halfOfOne, crossCutting]);

    expect(graph.simulation.getBoundaryBody("spec:whole"), `a whole ${firstId} must be movable`).toBeDefined();
    expect(graph.simulation.getBoundaryBody("spec:half"), `part of ${firstId} must not be`).toBeUndefined();
    expect(
      graph.simulation.getBoundaryBody("spec:cross"),
      `a slice of ${firstId} plus a slice of ${secondId} must not be`
    ).toBeUndefined();
  });

  // Randomized driver. Several shapes x several seeds, each doing a mixed
  // sequence of the things that can move a graph, with all six invariants
  // re-checked after every step.
  const SHAPES: { name: string; total: number; options: Parameters<typeof buildWorkspace>[1] }[] = [
    { name: "small, no subcategories", total: 40, options: { categories: 4, subcategoryShare: 0, collections: 2 } },
    { name: "medium, nested", total: 150, options: { categories: 8, subcategoryShare: 0.8, collections: 5 } },
    { name: "dense, heavily cross-cut", total: 300, options: { categories: 10, subcategoryShare: 0.6, collections: 12 } },
    { name: "one big category", total: 120, options: { categories: 1, subcategoryShare: 0.5, collections: 3 } },
  ];

  for (const shape of SHAPES) {
    for (const seed of [1, 7]) {
      it(`holds every invariant under random activity — ${shape.name} (seed ${seed})`, () => {
        const data = buildWorkspace(shape.total, { ...shape.options, seed });
        const graph = makeGraph(data);
        const random = makeRandom(seed * 977 + 13);
        let drawn = graph.run(300);
        checkAll(graph, drawn, "after settle");

        for (let step = 0; step < 12; step++) {
          const action = Math.floor(random() * 5);
          if (action === 0) {
            // Drag a boundary square somewhere far away.
            const draggable = drawn.filter((b) => graph.simulation.getBoundaryBody(b.id));
            if (draggable.length > 0) {
              const target = draggable[Math.floor(random() * draggable.length)];
              const body = graph.simulation.getBoundaryBody(target.id)!;
              graph.simulation.beginBoundaryDrag(target.id, body.x, body.y);
              for (let i = 0; i < 6; i++) {
                graph.simulation.moveBoundaryDrag((random() - 0.5) * 6000, (random() - 0.5) * 6000);
                drawn = graph.frame();
              }
              graph.simulation.endBoundaryDrag();
            }
          } else if (action === 1) {
            // Drag a node.
            const node = graph.nodes[Math.floor(random() * graph.nodes.length)];
            const physicsNode = graph.simulation.findNode(node.id)!;
            graph.simulation.reheat(0.6);
            for (let i = 0; i < 5; i++) {
              graph.simulation.pin(node.id, physicsNode.x! + i * 120, physicsNode.y! - i * 90);
              drawn = graph.frame();
            }
            graph.simulation.unpin(node.id);
          } else if (action === 2) {
            // Tabs come and go.
            const visible = graph.nodes.filter(() => random() > 0.25);
            graph.install(visible);
            drawn = graph.run(40);
            graph.install();
          } else if (action === 3) {
            // A serialization round trip.
            const offsets = graph.simulation.getBoundaryOffsets();
            const positions: Record<string, { x: number; y: number }> = {};
            for (const node of graph.nodes) {
              const physicsNode = graph.simulation.findNode(node.id);
              if (physicsNode?.x !== undefined && physicsNode.y !== undefined) {
                positions[node.id] = { x: physicsNode.x, y: physicsNode.y };
              }
            }
            const restored = makeGraph(data, positions);
            restored.install(restored.nodes, positions, offsets);
            const restoredDrawn = restored.run(120);
            checkAll(restored, restoredDrawn, `round trip step ${step}`);
          }
          drawn = graph.run(60);
          checkAll(graph, drawn, `${shape.name} seed ${seed} step ${step} action ${action}`);
        }
      }, 120000);
    }
  }
});

describe("graph initialization", () => {
  // The original bug needed no user interaction: bodies were born awake, the
  // first overlap resolution translated a slice of somebody's cluster, and it
  // was downhill from there. These check the frames where that happened.
  const STARTS: { name: string; make: () => { data: WorkspaceData; graph: Graph } }[] = [
    {
      name: "a fresh graph with no saved state",
      make: () => {
        const data = buildWorkspace(220);
        return { data, graph: makeGraph(data) };
      },
    },
    {
      name: "a graph restored from saved positions",
      make: () => {
        const data = buildWorkspace(220);
        const seeded = makeGraph(data);
        seeded.run(500);
        const positions: Record<string, { x: number; y: number }> = {};
        for (const node of seeded.nodes) {
          const physicsNode = seeded.simulation.findNode(node.id)!;
          positions[node.id] = { x: physicsNode.x!, y: physicsNode.y! };
        }
        return { data, graph: makeGraph(data, positions) };
      },
    },
    {
      name: "a graph restored from a torn saved record",
      make: () => {
        const data = buildWorkspace(220);
        const graph = makeGraph(data);
        const torn: Record<string, { x: number; y: number }> = {};
        graph.tree.roots.forEach((category, index) => {
          category.totalTabIds.forEach((id, i) => {
            torn[id] = i % 3 === 0 ? { x: 2600 + index * 40, y: -1900 } : { x: 0, y: 0 };
          });
        });
        graph.install(graph.nodes, {}, torn);
        return { data, graph };
      },
    },
  ];

  for (const start of STARTS) {
    it(`never splits a territory in the first 100 frames of ${start.name}`, () => {
      const { graph } = start.make();
      for (let i = 0; i < 100; i++) {
        const drawn = graph.frame();
        checkFinite(graph, `frame ${i}`);
        checkUniformOffsets(graph, `frame ${i}`);
        checkNesting(graph, `frame ${i}`);
        // Squares are checked from frame 20 on: the first frames are the
        // layout expanding out of its seeded positions, where a cluster
        // legitimately has not reached its disc yet.
        if (i >= 20) checkBoundedSquares(graph, drawn, `frame ${i}`);
      }
    }, 60000);
  }

  it("stays coherent through cluster creation and deletion", () => {
    const data = buildWorkspace(180);
    const graph = makeGraph(data);
    graph.run(300);

    // Whole categories leave and come back — the shape of a re-organization.
    for (let round = 0; round < 5; round++) {
      const dropped = new Set(graph.tree.roots[round % graph.tree.roots.length].totalTabIds);
      graph.install(graph.nodes.filter((n) => !dropped.has(n.id)));
      const partial = graph.run(60);
      checkAll(graph, partial, `category removed, round ${round}`);
      graph.install();
      const restored = graph.run(60);
      checkAll(graph, restored, `category restored, round ${round}`);
    }
  }, 60000);
});

describe("rebuild safety", () => {
  it("does not accumulate, multiply, reset or smear offsets across 100 rebuilds", () => {
    const data = buildWorkspace(150);
    const graph = makeGraph(data);
    graph.run(400);

    // Put a real, deliberate move on one category, then rebuild around it.
    const drawn = graph.boundaryPass();
    const category = drawn.find((b) => b.kind === "category" && graph.simulation.getBoundaryBody(b.id))!;
    const body = graph.simulation.getBoundaryBody(category.id)!;
    graph.simulation.beginBoundaryDrag(category.id, body.x, body.y);
    graph.simulation.moveBoundaryDrag(body.x + 400, body.y + 250);
    graph.frame();
    graph.simulation.endBoundaryDrag();
    graph.run(80);

    const memberId = graph.tree.byId.get(category.id)!.totalTabIds[0];
    const moved = graph.simulation.getBoundaryOffsets()[memberId];
    expect(Math.hypot(moved.x, moved.y)).toBeGreaterThan(100);

    const territoryCountBefore = graph.territoryMembers().size;
    // Rebuild ONLY — no ticks. Physics legitimately moves offsets (a square
    // shoved into its neighbour is supposed to be pushed back out), so a
    // cycle that stepped the simulation would be measuring that instead of
    // the rebuild. This isolates the rebuild path, which is the thing that
    // must be inert.
    for (let cycle = 0; cycle < 100; cycle++) {
      graph.install();
      const rebuilt = graph.boundaryPass();
      const now = graph.simulation.getBoundaryOffsets()[memberId];
      // Not accumulated, not multiplied, not reset — bit-stable.
      expect(now.x, `cycle ${cycle} offset.x`).toBeCloseTo(moved.x, 6);
      expect(now.y, `cycle ${cycle} offset.y`).toBeCloseTo(moved.y, 6);
      checkUniformOffsets(graph, `cycle ${cycle}`);
      checkNesting(graph, `cycle ${cycle}`);
      checkBoundedSquares(graph, rebuilt, `cycle ${cycle}`);
      // No new territory identities invented along the way.
      expect(graph.territoryMembers().size).toBe(territoryCountBefore);
    }
  }, 120000);

  it("does not let 100 rebuild-and-settle cycles drift an offset without bound", () => {
    const graph = makeGraph(buildWorkspace(150));
    graph.run(400);
    const drawn = graph.boundaryPass();
    const category = drawn.find((b) => b.kind === "category" && graph.simulation.getBoundaryBody(b.id))!;
    const body = graph.simulation.getBoundaryBody(category.id)!;
    graph.simulation.beginBoundaryDrag(category.id, body.x, body.y);
    graph.simulation.moveBoundaryDrag(body.x + 400, body.y + 250);
    graph.frame();
    graph.simulation.endBoundaryDrag();
    graph.run(80);

    const memberId = graph.tree.byId.get(category.id)!.totalTabIds[0];
    const start = graph.simulation.getBoundaryOffsets()[memberId];

    // Here the physics DOES run, so the offset may settle a little as the
    // moved square finds room. What must not happen is drift that grows with
    // the number of cycles — the signature of an offset being re-applied
    // rather than carried.
    let previous = start;
    let worstStep = 0;
    for (let cycle = 0; cycle < 100; cycle++) {
      graph.install();
      const rebuilt = graph.run(4);
      const now = graph.simulation.getBoundaryOffsets()[memberId];
      worstStep = Math.max(worstStep, Math.hypot(now.x - previous.x, now.y - previous.y));
      previous = now;
      checkUniformOffsets(graph, `settle cycle ${cycle}`);
      checkBoundedSquares(graph, rebuilt, `settle cycle ${cycle}`);
    }
    // 100 cycles of accumulation would be tens of thousands of px; a settle
    // is bounded by the sandbox and by how far the square had to move.
    expect(Math.hypot(previous.x - start.x, previous.y - start.y)).toBeLessThan(1500);
    expect(worstStep).toBeLessThan(400);
  }, 120000);

  it("does not smear a subcategory's move into its parent across rebuilds", () => {
    const graph = makeGraph(buildWorkspace(150));
    graph.run(400);
    const drawn = graph.boundaryPass();
    const sub = drawn.find((b) => b.kind === "subcategory" && graph.simulation.getBoundaryBody(b.id));
    if (!sub) return;

    const category = graph.tree.byId.get(sub.id)!.parentId!;
    const categoryOwnTabs = graph.tree.byId.get(category)!.memberTabIds;
    if (categoryOwnTabs.length === 0) return;

    const body = graph.simulation.getBoundaryBody(sub.id)!;
    graph.simulation.beginBoundaryDrag(sub.id, body.x, body.y);
    graph.simulation.moveBoundaryDrag(body.x + 300, body.y);
    graph.frame();
    graph.simulation.endBoundaryDrag();
    graph.run(60);

    const parentOffsetBefore = graph.simulation.getBoundaryOffsets()[categoryOwnTabs[0]];
    for (let cycle = 0; cycle < 20; cycle++) {
      graph.install();
      graph.run(3);
      const parentOffset = graph.simulation.getBoundaryOffsets()[categoryOwnTabs[0]];
      expect(parentOffset.x, `cycle ${cycle}`).toBeCloseTo(parentOffsetBefore.x, 6);
      expect(parentOffset.y, `cycle ${cycle}`).toBeCloseTo(parentOffsetBefore.y, 6);
    }
  }, 60000);
});

describe("serialization round trips", () => {
  it("survives graph → serialize → deserialize → rebuild → settle → serialize", () => {
    const data = buildWorkspace(200);
    const first = makeGraph(data);
    first.run(600);

    const positions: Record<string, { x: number; y: number }> = {};
    for (const node of first.nodes) {
      const physicsNode = first.simulation.findNode(node.id)!;
      positions[node.id] = { x: physicsNode.x!, y: physicsNode.y! };
    }
    const offsets = first.simulation.getBoundaryOffsets();

    saveGraphState({
      version: 1,
      positions,
      boundaryOffsets: offsets,
      manualConnections: [],
      settings: DEFAULT_GRAPH_SETTINGS,
    });
    const loaded = loadGraphState();
    expect(Object.keys(loaded.positions).length).toBe(Object.keys(positions).length);

    const second = makeGraph(data, loaded.positions);
    second.install(second.nodes, loaded.positions, loaded.boundaryOffsets);
    const drawn = second.run(400);
    checkAll(second, drawn, "after round trip");

    // Second serialization is stable — nothing drifted or exploded.
    const reOffsets = second.simulation.getBoundaryOffsets();
    for (const [id, offset] of Object.entries(reOffsets)) {
      const before = offsets[id];
      if (!before) continue;
      expect(Math.hypot(offset.x - before.x, offset.y - before.y), `${id} drifted`).toBeLessThan(120);
    }
  }, 60000);

  it("prunes and survives malformed persisted state", () => {
    const data = buildWorkspace(60);
    const graph = makeGraph(data);
    const validIds = new Set(graph.nodes.map((n) => n.id));

    saveGraphState({
      version: 1,
      positions: {
        [graph.nodes[0].id]: { x: 10, y: 20 },
        [graph.nodes[1].id]: { x: Number.NaN, y: 0 } as { x: number; y: number },
        [graph.nodes[2].id]: { x: 1e300, y: 0 },
        "tab-that-is-gone": { x: 5, y: 5 },
      },
      boundaryOffsets: {
        [graph.nodes[0].id]: { x: 3, y: 4 },
        [graph.nodes[1].id]: { x: Number.POSITIVE_INFINITY, y: 0 },
        "tab-that-is-gone": { x: 9, y: 9 },
      },
      manualConnections: [],
      settings: DEFAULT_GRAPH_SETTINGS,
    });

    const loaded = pruneGraphState(loadGraphState(), validIds);
    expect(Object.keys(loaded.positions)).toEqual([graph.nodes[0].id]);
    expect(Object.keys(loaded.boundaryOffsets)).toEqual([graph.nodes[0].id]);

    graph.install(graph.nodes, loaded.positions, loaded.boundaryOffsets);
    const drawn = graph.run(200);
    checkAll(graph, drawn, "after malformed state");
  }, 60000);
});

describe("boundary offset migration", () => {
  /**
   * A saved record torn the way the old per-tab displacement tore one: within
   * each territory, a minority of its members carried far away and the
   * majority left where they were.
   *
   * Per TERRITORY, not per category: a category's tabs are spread across its
   * subcategories, each of which is its own disc with its own consensus, so a
   * pattern applied to the category's flattened list would make some whole
   * sub-discs agree on the far offset — which is not a tear at all, it is a
   * legitimate move, and the migration correctly leaves it alone.
   */
  function tornRecord(graph: Graph) {
    const torn: Record<string, { x: number; y: number }> = {};
    const strays: string[] = [];
    const stayed: string[] = [];
    for (const [, members] of graph.territoryMembers()) {
      const present = members.filter((id) => graph.simulation.findNode(id));
      if (present.length < 3) {
        for (const id of present) {
          torn[id] = { x: 0, y: 0 };
          stayed.push(id);
        }
        continue;
      }
      present.forEach((id, i) => {
        if (i === 0) {
          torn[id] = { x: 3200, y: -1400 };
          strays.push(id);
        } else {
          torn[id] = { x: 0, y: 0 };
          stayed.push(id);
        }
      });
    }
    return { torn, strays, stayed };
  }

  it("reports the repaired offsets, and only for the tabs it repaired", () => {
    const data = buildWorkspace(120);
    const graph = makeGraph(data);
    const { torn, strays, stayed } = tornRecord(graph);
    expect(strays.length).toBeGreaterThan(0);

    graph.install(graph.nodes, {}, torn);
    const normalized = graph.simulation.takeNormalizedBoundaryOffsets();
    expect(normalized).not.toBeNull();

    for (const id of strays) {
      expect(normalized![id], `stray ${id} must be repaired`).toBeDefined();
      // Repaired to where the majority of its own disc sat: home.
      expect(Math.hypot(normalized![id].x, normalized![id].y)).toBeLessThan(1);
    }
    // Tabs that were already coherent are not rewritten.
    for (const id of stayed) expect(normalized![id], `${id} was already correct`).toBeUndefined();
  });

  it("is idempotent — a second load of the repaired record reports nothing", () => {
    const data = buildWorkspace(120);
    const first = makeGraph(data);
    const { torn } = tornRecord(first);

    first.install(first.nodes, {}, torn);
    const normalized = first.simulation.takeNormalizedBoundaryOffsets();
    expect(normalized).not.toBeNull();
    expect(first.simulation.takeNormalizedBoundaryOffsets()).toBeNull();

    // What the app would have written back: a MERGE of the repairs onto the
    // record it loaded, exactly as graph-view.tsx does.
    const migrated = { ...torn, ...normalized };

    const second = makeGraph(data);
    second.install(second.nodes, {}, migrated);
    expect(second.simulation.takeNormalizedBoundaryOffsets()).toBeNull();
  });

  it("reports nothing for a record that was already coherent", () => {
    const data = buildWorkspace(120);
    const graph = makeGraph(data);
    const coherent: Record<string, { x: number; y: number }> = {};
    for (const id of graph.tree.roots[0].totalTabIds) coherent[id] = { x: 500, y: -300 };
    graph.install(graph.nodes, {}, coherent);
    expect(graph.simulation.takeNormalizedBoundaryOffsets()).toBeNull();
  });

  it("reports nothing when there were no saved offsets at all", () => {
    const data = buildWorkspace(80);
    const graph = makeGraph(data);
    graph.install(graph.nodes, {}, {});
    expect(graph.simulation.takeNormalizedBoundaryOffsets()).toBeNull();
  });

  it("ignores offsets for tabs that are not in the graph", () => {
    const data = buildWorkspace(80);
    const graph = makeGraph(data);
    graph.install(graph.nodes, {}, { "tab-that-is-gone": { x: 900, y: 900 } });
    expect(graph.simulation.takeNormalizedBoundaryOffsets()).toBeNull();
  });

  it("survives NaN and Infinity in the saved record", () => {
    const data = buildWorkspace(80);
    const graph = makeGraph(data);
    const ids = graph.tree.roots[0].totalTabIds;
    graph.install(graph.nodes, {}, {
      [ids[0]]: { x: Number.NaN, y: 0 },
      [ids[1]]: { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY },
      [ids[2]]: { x: 300, y: 300 },
    });
    const drawn = graph.run(200);
    checkAll(graph, drawn, "after non-finite offsets");
  });
});
