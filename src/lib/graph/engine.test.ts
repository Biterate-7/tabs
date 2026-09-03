import { describe, expect, it } from "vitest";
import { createGraphSimulation, NODE_MIN_EDGE_GAP, nodeCollisionRadius } from "./engine";
import { MAX_NODE_RADIUS } from "./node-size";
import type { GraphNode } from "./types";

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

  it("nodeCollisionRadius circumscribes the padded visible square (guarantees square-square separation from any angle)", () => {
    // For any radius, a circle of this size, when kept apart from another
    // such circle by forceCollide, guarantees the two nodes' visible
    // 2*radius squares stay at least NODE_MIN_EDGE_GAP apart edge-to-edge —
    // even in the worst-case diagonal approach — because
    // radius * sqrt(2) is exactly the circle that circumscribes a square of
    // that half-width.
    const r = MAX_NODE_RADIUS;
    const halfWidthPadded = r + NODE_MIN_EDGE_GAP / 2;
    expect(nodeCollisionRadius(r)).toBeCloseTo(halfWidthPadded * Math.SQRT2, 5);
  });

  it("settles a dense cluster of max-size nodes with no overlapping visible squares", () => {
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

    let ticks = 0;
    while (!sim.isSettled() && ticks < 5000) {
      sim.tick();
      ticks++;
    }
    expect(sim.isSettled()).toBe(true);

    const side = MAX_NODE_RADIUS * 2;
    let minEdgeGap = Infinity;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = sim.findNode(`n${i}`)!;
        const b = sim.findNode(`n${j}`)!;
        const dx = Math.abs(a.x! - b.x!);
        const dy = Math.abs(a.y! - b.y!);
        // Two axis-aligned squares (side `side`, centered on each node) are
        // separated exactly when they don't overlap on at least one axis.
        const overlapsX = dx < side;
        const overlapsY = dy < side;
        expect(overlapsX && overlapsY).toBe(false);
        const edgeGap = Math.max(dx, dy) - side;
        minEdgeGap = Math.min(minEdgeGap, edgeGap);
      }
    }
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
