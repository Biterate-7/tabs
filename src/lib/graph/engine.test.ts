import { describe, expect, it } from "vitest";
import { createGraphSimulation, NODE_MIN_EDGE_GAP, nodeCollisionRadius } from "./engine";
import { BASE_NODE_RADIUS, MAX_NODE_RADIUS } from "./node-size";
import type { GraphEdge, GraphNode } from "./types";

function makeGraphNode(id: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com" },
    workspaceId: "ws-1",
    workspaceName: "Workspace",
  };
}

describe("createGraphSimulation collection clustering", () => {
  it("pulls a collection's members closer together over time", () => {
    const sim = createGraphSimulation();
    const nodes = [makeGraphNode("a"), makeGraphNode("b")];
    sim.setNodes(nodes, () => 5, { a: { x: -300, y: 0 }, b: { x: 300, y: 0 } });
    sim.setEdges([], 1);
    sim.setCollections([{ tabIds: ["a", "b"] }]);
    sim.reheat(1);

    const before = Math.hypot(
      sim.findNode("a")!.x! - sim.findNode("b")!.x!,
      sim.findNode("a")!.y! - sim.findNode("b")!.y!
    );

    for (let i = 0; i < 60; i++) sim.tick();

    const after = Math.hypot(
      sim.findNode("a")!.x! - sim.findNode("b")!.x!,
      sim.findNode("a")!.y! - sim.findNode("b")!.y!
    );

    expect(after).toBeLessThan(before);
  });

  it("ignores a single-member collection (nothing to cluster toward)", () => {
    const sim = createGraphSimulation();
    const nodes = [makeGraphNode("a")];
    sim.setNodes(nodes, () => 5, { a: { x: 50, y: 50 } });
    sim.setEdges([], 1);
    // Should not throw, and should not pin the lone node to its own position.
    expect(() => sim.setCollections([{ tabIds: ["a"] }])).not.toThrow();
    sim.reheat(1);
    for (let i = 0; i < 10; i++) sim.tick();
    expect(sim.findNode("a")).toBeDefined();
  });

  it("silently ignores tab ids that aren't currently physics nodes", () => {
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("a")], () => 5, {});
    expect(() => sim.setCollections([{ tabIds: ["a", "ghost"] }])).not.toThrow();
  });
});

describe("createGraphSimulation cluster anchor forces", () => {
  it("pulls a node with a category anchor closer to that anchor over time", () => {
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("a")], () => 5, { a: { x: 0, y: 0 } });
    sim.setEdges([], 1);
    sim.setClusterAnchors(new Map([["a", { categoryAnchor: { x: 500, y: 0 }, subcategoryAnchor: null }]]));
    sim.reheat(1);

    const before = Math.abs(sim.findNode("a")!.x! - 500);
    for (let i = 0; i < 60; i++) sim.tick();
    const after = Math.abs(sim.findNode("a")!.x! - 500);

    expect(after).toBeLessThan(before);
  });

  it("pulls a node toward its subcategory anchor more strongly than a category-only node moves toward its category anchor", () => {
    const simA = createGraphSimulation();
    simA.setNodes([makeGraphNode("a")], () => 5, { a: { x: 0, y: 0 } });
    simA.setEdges([], 1);
    simA.setClusterAnchors(new Map([["a", { categoryAnchor: { x: 500, y: 0 }, subcategoryAnchor: null }]]));
    simA.reheat(1);
    for (let i = 0; i < 30; i++) simA.tick();
    const categoryOnlyDistance = Math.abs(simA.findNode("a")!.x! - 500);

    const simB = createGraphSimulation();
    simB.setNodes([makeGraphNode("b")], () => 5, { b: { x: 0, y: 0 } });
    simB.setEdges([], 1);
    simB.setClusterAnchors(
      new Map([["b", { categoryAnchor: { x: 500, y: 0 }, subcategoryAnchor: { x: 500, y: 0 } }]])
    );
    simB.reheat(1);
    for (let i = 0; i < 30; i++) simB.tick();
    const subcategoryDistance = Math.abs(simB.findNode("b")!.x! - 500);

    expect(subcategoryDistance).toBeLessThan(categoryOnlyDistance);
  });

  it("setClusterAnchors with an empty map is a no-op and never throws", () => {
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("a")], () => 5, { a: { x: 10, y: 10 } });
    sim.setEdges([], 1);
    expect(() => sim.setClusterAnchors(new Map())).not.toThrow();
    sim.reheat(1);
    for (let i = 0; i < 10; i++) sim.tick();
    expect(sim.findNode("a")).toBeDefined();
  });

  it("nodeCollisionRadius pads the node's real (circular) footprint by half the desired edge gap", () => {
    // node-renderer.ts always paints the node body through a circular clip
    // of exactly `radius` (see node-renderer.test.ts) — the footprint is a
    // circle, not a square, so no square-to-circle padding (e.g. sqrt(2))
    // belongs here. Two nodes whose collision radii (r + GAP/2 each) don't
    // overlap are, by construction, at least GAP apart center-to-center in
    // excess of r1 + r2 — i.e. their visible circle edges have >= GAP of
    // clear space, from any angle, since circles are radially symmetric.
    const r = MAX_NODE_RADIUS;
    expect(nodeCollisionRadius(r)).toBeCloseTo(r + NODE_MIN_EDGE_GAP / 2, 10);
  });

  /** Every settled pair of nodes must clear this edge-to-edge gap between their *circular* visible bodies (see node-renderer.test.ts for why the body is a circle). Radially symmetric, so this is angle-independent — no separate diagonal-vs-axis-aligned case is needed for the circle itself, but the tests below still exercise diagonal center offsets since that's the natural resting configuration for a symmetric radial force. */
  function assertNoCircleOverlap(nodes: { x: number; y: number; radius: number }[]) {
    let minEdgeGap = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const centerDist = Math.hypot(a.x - b.x, a.y - b.y);
        const edgeGap = centerDist - a.radius - b.radius;
        expect(edgeGap).toBeGreaterThan(0);
        minEdgeGap = Math.min(minEdgeGap, edgeGap);
      }
    }
    return minEdgeGap;
  }

  function settle(sim: ReturnType<typeof createGraphSimulation>, maxTicks = 5000) {
    let ticks = 0;
    while (!sim.isSettled() && ticks < maxTicks) {
      sim.tick();
      ticks++;
    }
    expect(sim.isSettled()).toBe(true);
  }

  it("settles two max-size nodes stacked at the same point with a positive edge gap", () => {
    const sim = createGraphSimulation();
    const nodes = [makeGraphNode("a"), makeGraphNode("b")];
    sim.setNodes(nodes, () => MAX_NODE_RADIUS, { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } });
    sim.setEdges([], 1);
    sim.reheat(1);
    settle(sim);

    const a = sim.findNode("a")!;
    const b = sim.findNode("b")!;
    const minEdgeGap = assertNoCircleOverlap([
      { x: a.x!, y: a.y!, radius: MAX_NODE_RADIUS },
      { x: b.x!, y: b.y!, radius: MAX_NODE_RADIUS },
    ]);
    expect(minEdgeGap).toBeGreaterThanOrEqual(NODE_MIN_EDGE_GAP - 1);
  });

  it("settles two max-size nodes approaching diagonally with a positive edge gap", () => {
    // Diagonal approach is the case where a square-based collision model
    // would need extra (sqrt(2)) padding; verify the plain circular model
    // still holds up here even though it isn't a special case for circles.
    const sim = createGraphSimulation();
    const nodes = [makeGraphNode("a"), makeGraphNode("b")];
    sim.setNodes(nodes, () => MAX_NODE_RADIUS, {
      a: { x: -5, y: -5 },
      b: { x: 5, y: 5 },
    });
    sim.setEdges([], 1);
    sim.reheat(1);
    settle(sim);

    const a = sim.findNode("a")!;
    const b = sim.findNode("b")!;
    const minEdgeGap = assertNoCircleOverlap([
      { x: a.x!, y: a.y!, radius: MAX_NODE_RADIUS },
      { x: b.x!, y: b.y!, radius: MAX_NODE_RADIUS },
    ]);
    expect(minEdgeGap).toBeGreaterThanOrEqual(NODE_MIN_EDGE_GAP - 1);
  });

  it("settles two different-size nodes (min and max radius) stacked together with the correct edge gap", () => {
    // The collision formula pads each node independently by GAP/2, so the
    // guaranteed gap shouldn't depend on whether the two radii match.
    const sim = createGraphSimulation();
    const nodes = [makeGraphNode("small"), makeGraphNode("big")];
    sim.setNodes(nodes, (n) => (n.id === "small" ? BASE_NODE_RADIUS : MAX_NODE_RADIUS), {
      small: { x: 0, y: 0 },
      big: { x: 0, y: 0 },
    });
    sim.setEdges([], 1);
    sim.reheat(1);
    settle(sim);

    const a = sim.findNode("small")!;
    const b = sim.findNode("big")!;
    const minEdgeGap = assertNoCircleOverlap([
      { x: a.x!, y: a.y!, radius: BASE_NODE_RADIUS },
      { x: b.x!, y: b.y!, radius: MAX_NODE_RADIUS },
    ]);
    expect(minEdgeGap).toBeGreaterThanOrEqual(NODE_MIN_EDGE_GAP - 1);
  });

  it("settles a dense, edge-connected cluster of mixed-size nodes (realistic graph shape) with no overlapping circles", () => {
    // Unlike the uniform-max-radius stress test above, this exercises
    // forceLink alongside collide/anchors with nodes of differing radii —
    // closer to what a real cluster of tabs actually looks like.
    const sim = createGraphSimulation();
    const N = 40;
    const nodes: GraphNode[] = [];
    const positions: Record<string, { x: number; y: number }> = {};
    const radiusById = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const id = `m${i}`;
      nodes.push(makeGraphNode(id));
      positions[id] = { x: 0, y: 0 };
      radiusById.set(id, i % 2 === 0 ? BASE_NODE_RADIUS : MAX_NODE_RADIUS);
    }
    sim.setNodes(nodes, (n) => radiusById.get(n.id)!, positions);
    const edges: GraphEdge[] = [];
    for (let i = 0; i < N - 1; i++) {
      edges.push({ id: `e${i}`, source: `m${i}`, target: `m${i + 1}`, reasons: ["domain"] });
    }
    sim.setEdges(edges, 1);
    sim.setClusterAnchors(
      new Map(nodes.map((n) => [n.id, { categoryAnchor: { x: 0, y: 0 }, subcategoryAnchor: { x: 0, y: 0 } }]))
    );
    sim.reheat(1);
    settle(sim);

    const settledNodes = nodes.map((n) => {
      const p = sim.findNode(n.id)!;
      return { x: p.x!, y: p.y!, radius: radiusById.get(n.id)! };
    });
    const minEdgeGap = assertNoCircleOverlap(settledNodes);
    expect(minEdgeGap).toBeGreaterThan(0);
  });

  it("settles a dense cluster of max-size nodes with no overlapping visible circles", () => {
    const sim = createGraphSimulation();
    const N = 60;
    const nodes: GraphNode[] = [];
    const positions: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < N; i++) {
      const id = `n${i}`;
      nodes.push(makeGraphNode(id));
      // Seed every node on top of each other (worst case for the collide
      // force to untangle) rather than pre-spread them.
      positions[id] = { x: 0, y: 0 };
    }
    sim.setNodes(nodes, () => MAX_NODE_RADIUS, positions);
    sim.setEdges([], 1);
    // All nodes share one subcategory anchor, like a single dense cluster in
    // the real graph — the anchor pull keeps trying to collapse them back
    // together while collide has to hold them apart.
    sim.setClusterAnchors(
      new Map(nodes.map((n) => [n.id, { categoryAnchor: { x: 0, y: 0 }, subcategoryAnchor: { x: 0, y: 0 } }]))
    );
    sim.reheat(1);
    settle(sim);

    const settledNodes = nodes.map((n) => {
      const p = sim.findNode(n.id)!;
      return { x: p.x!, y: p.y!, radius: MAX_NODE_RADIUS };
    });
    const minEdgeGap = assertNoCircleOverlap(settledNodes);
    expect(minEdgeGap).toBeGreaterThan(0);
  });

  it("leaves a node absent from the assignment map unaffected by the anchor forces", () => {
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("a")], () => 5, { a: { x: 40, y: 0 } });
    sim.setEdges([], 1);
    sim.setClusterAnchors(new Map());
    sim.reheat(1);
    for (let i = 0; i < 30; i++) sim.tick();
    // With no anchor assigned, only charge/collide/center/x/y act on a lone
    // node — it should drift toward the origin (the existing weak global
    // pull), not toward some arbitrary anchor point.
    expect(Math.abs(sim.findNode("a")!.x!)).toBeLessThan(40);
  });
});
