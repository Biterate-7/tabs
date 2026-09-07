/**
 * The simulation's own bounds, asserted on the engine directly rather than
 * through the full pipeline (graph-stability.test.ts does that). These are
 * the properties that make the layout a bounded dynamical system instead of
 * one that merely happens not to blow up on the inputs it has been shown.
 *
 * Kept beside engine.test.ts rather than inside it: that file is about what
 * the forces DO (clustering, anchoring, collision spacing), this one is about
 * what they are never allowed to do.
 */
import { describe, expect, it } from "vitest";
import { createGraphSimulation, MAX_NODE_SPEED } from "./engine";
import { MAX_NODE_RADIUS } from "./node-size";
import type { GraphEdge, GraphNode } from "./types";

function makeGraphNode(id: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com" },
    workspaceId: "ws-1",
    workspaceName: "Workspace",
  };
}

describe("bounded motion", () => {
  it("caps node speed however violent the initial condition", () => {
    const sim = createGraphSimulation();
    // 30 max-size nodes at exactly the same point, every pair linked: the
    // worst case for forceManyBody (which diverges as separation approaches
    // zero), for forceCollide, and for the link force at once.
    const nodes = Array.from({ length: 30 }, (_, i) => makeGraphNode(`n${i}`));
    const positions: Record<string, { x: number; y: number }> = {};
    for (const node of nodes) positions[node.id] = { x: 0, y: 0 };
    const edges: GraphEdge[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        edges.push({ id: `${i}-${j}`, source: `n${i}`, target: `n${j}`, reasons: [] });
      }
    }
    sim.setNodes(nodes, () => MAX_NODE_RADIUS, positions);
    sim.setEdges(edges, 1);
    sim.reheat(1);

    for (let tick = 0; tick < 300; tick++) {
      sim.tick();
      for (const node of nodes) {
        const physics = sim.findNode(node.id)!;
        expect(Math.hypot(physics.vx ?? 0, physics.vy ?? 0)).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);
      }
    }
  });

  it("bounds how far any node can move between two frames", () => {
    const sim = createGraphSimulation();
    const nodes = Array.from({ length: 40 }, (_, i) => makeGraphNode(`n${i}`));
    const positions: Record<string, { x: number; y: number }> = {};
    for (const node of nodes) positions[node.id] = { x: 0, y: 0 };
    sim.setNodes(nodes, () => MAX_NODE_RADIUS, positions);
    sim.setEdges([], 1);
    sim.reheat(1);

    let previous = nodes.map((n) => ({ ...sim.findNode(n.id)! }));
    for (let tick = 0; tick < 200; tick++) {
      sim.tick();
      nodes.forEach((node, index) => {
        const now = sim.findNode(node.id)!;
        const before = previous[index];
        // A frame's travel is the capped velocity less the decay d3 applies
        // during integration, so it can never exceed the cap itself. This is
        // the property that makes the cap a simulation bound rather than a
        // cosmetic one: it constrains displacement without touching position.
        expect(Math.hypot(now.x! - before.x!, now.y! - before.y!)).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);
      });
      previous = nodes.map((n) => ({ ...sim.findNode(n.id)! }));
    }
  });

  it("comes to a true rest, leaving no stored momentum to discharge on the next reheat", () => {
    const sim = createGraphSimulation();
    const nodes = Array.from({ length: 20 }, (_, i) => makeGraphNode(`n${i}`));
    sim.setNodes(nodes, () => 6, {});
    sim.setEdges([], 1);
    sim.reheat(1);
    for (let tick = 0; tick < 2000 && !sim.isSettled(); tick++) sim.tick();
    expect(sim.isSettled()).toBe(true);

    // One more tick past the settle: this is the pass that parks whatever
    // velocity d3 froze mid-flight when alpha crossed alphaMin. Measured on
    // the real export before this existed, the fastest node was still
    // carrying 10 world units per tick at the moment the graph was declared
    // settled.
    sim.tick();
    for (const node of nodes) {
      const physics = sim.findNode(node.id)!;
      expect(physics.vx).toBe(0);
      expect(physics.vy).toBe(0);
    }

    // ...so a later reheat starts from rest rather than releasing that stored
    // motion in one lurch.
    const before = nodes.map((n) => ({ ...sim.findNode(n.id)! }));
    sim.reheat(0.4);
    sim.tick();
    nodes.forEach((node, index) => {
      const now = sim.findNode(node.id)!;
      expect(Math.hypot(now.x! - before[index].x!, now.y! - before[index].y!)).toBeLessThan(MAX_NODE_SPEED);
    });
  });
});

describe("bulk arrival handling", () => {
  it("seeds a bulk arrival without stacking, and reports it as one", () => {
    const sim = createGraphSimulation();
    const nodes = Array.from({ length: 120 }, (_, i) => makeGraphNode(`n${i}`));
    // Every node in one cluster region — the case that used to put 120 nodes
    // inside a single 24px disc.
    sim.setNodes(nodes, () => 6, {}, () => ({ x: 0, y: 0, r: 200 }));
    expect(sim.lastArrivalCount()).toBe(120);
    expect(sim.isBulkSettling()).toBe(true);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = sim.findNode(`n${i}`)!;
        const b = sim.findNode(`n${j}`)!;
        expect(Math.hypot(a.x! - b.x!, a.y! - b.y!)).toBeGreaterThan(1);
      }
    }
  });

  it("counts only genuinely new nodes as arrivals", () => {
    const sim = createGraphSimulation();
    const nodes = Array.from({ length: 5 }, (_, i) => makeGraphNode(`n${i}`));
    sim.setNodes(nodes, () => 6, {});
    expect(sim.lastArrivalCount()).toBe(5);

    // The same set again: nothing new, so nothing is reseeded.
    sim.setNodes(nodes, () => 6, {});
    expect(sim.lastArrivalCount()).toBe(0);

    // A node with a saved position is restored, not seeded.
    sim.setNodes([...nodes, makeGraphNode("saved")], () => 6, { saved: { x: 10, y: 10 } });
    expect(sim.lastArrivalCount()).toBe(0);
    expect(sim.findNode("saved")!.x).toBe(10);
  });

  it("settleBulk stops at its tick ceiling, and finishes early when it can", () => {
    const sim = createGraphSimulation();
    const nodes = Array.from({ length: 60 }, (_, i) => makeGraphNode(`n${i}`));
    sim.setNodes(nodes, () => 6, {}, () => ({ x: 0, y: 0, r: 300 }));
    sim.setEdges([], 1);
    sim.reheat(1);
    expect(sim.settleBulk(10, 10_000)).toBe(10);
    expect(sim.isSettled()).toBe(false);

    const ran = sim.settleBulk(5000, 10_000);
    expect(ran).toBeLessThan(5000);
    expect(sim.isSettled()).toBe(true);
  });

  it("settleBulk on an already-settled simulation does nothing", () => {
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("a")], () => 6, { a: { x: 0, y: 0 } });
    sim.setEdges([], 1);
    for (let i = 0; i < 2000 && !sim.isSettled(); i++) sim.tick();
    expect(sim.settleBulk(100, 1000)).toBe(0);
  });

  it("retires a finished bulk window so a later single addition is not damped as an import", () => {
    const sim = createGraphSimulation();
    const nodes = Array.from({ length: 60 }, (_, i) => makeGraphNode(`n${i}`));
    sim.setNodes(nodes, () => 6, {}, () => ({ x: 0, y: 0, r: 300 }));
    sim.setEdges([], 1);
    sim.reheat(1);
    expect(sim.isBulkSettling()).toBe(true);
    for (let i = 0; i < 3000 && !sim.isSettled(); i++) sim.tick();

    sim.setNodes([...nodes, makeGraphNode("one-more")], () => 6, {});
    expect(sim.lastArrivalCount()).toBe(1);
    expect(sim.isBulkSettling()).toBe(false);
  });
});

describe("boundary geometry during a drag", () => {
  it("leaves the excluded node out of a boundary body's rect, and puts it back on release", () => {
    const sim = createGraphSimulation();
    const nodes = ["a", "b", "c"].map(makeGraphNode);
    sim.setNodes(nodes, () => 5, { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 50, y: 50 } });
    sim.setEdges([], 1);
    sim.setBoundaryBodies([{ id: "box", memberIds: ["a", "b", "c"], padding: 10 }]);
    const width = sim.getBoundaryBody("box")!.halfWidth;

    // Drag "b" a long way out, exactly as handlePointerDown / handlePointerMove
    // do — the pin only takes effect once the simulation actually ticks, so
    // the gesture is simulated frame by frame rather than as one assignment.
    sim.setBoundaryExcluded("b");
    sim.reheat(0.5);
    for (let frame = 0; frame < 10; frame++) {
      sim.pin("b", 5000, 0);
      sim.tick();
    }
    expect(sim.findNode("b")!.x).toBe(5000);
    // The box did NOT follow the drag: without the exclusion its half-width
    // would have grown past 2400 to reach the pointer.
    expect(sim.getBoundaryBody("box")!.halfWidth).toBeLessThan(width + 50);

    // Release: the box is allowed to reach it again, which is what makes this
    // a transient exclusion rather than a permanent change to what the group
    // contains.
    sim.setBoundaryExcluded(null);
    sim.setBoundaryBodies([{ id: "box", memberIds: ["a", "b", "c"], padding: 10 }]);
    expect(sim.getBoundaryBody("box")!.halfWidth).toBeGreaterThan(1000);
  });

  it("keeps a box's previous rect when every member is excluded, rather than collapsing it", () => {
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("only")], () => 5, { only: { x: 40, y: 40 } });
    sim.setBoundaryBodies([{ id: "box", memberIds: ["only"], padding: 10 }]);
    const before = { ...sim.getBoundaryBody("box")! };

    sim.setBoundaryExcluded("only");
    sim.setBoundaryBodies([{ id: "box", memberIds: ["only"], padding: 10 }]);
    const after = sim.getBoundaryBody("box")!;
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.halfWidth).toBe(before.halfWidth);
  });

  it("reports which node is excluded, so the renderer and the collider agree", () => {
    const sim = createGraphSimulation();
    expect(sim.getBoundaryExcluded()).toBeNull();
    sim.setBoundaryExcluded("x");
    expect(sim.getBoundaryExcluded()).toBe("x");
    sim.setBoundaryExcluded(null);
    expect(sim.getBoundaryExcluded()).toBeNull();
  });
});

describe("link force", () => {
  it("normalises link strength by degree, so a hub is not torn apart by its own neighbours", () => {
    // One hub linked to 40 leaves, all starting far from it. Under a flat
    // link strength the hub accumulates 40 full-strength springs and is
    // thrown around by whichever leaves are furthest; normalised, it holds
    // its place and the leaves come to it.
    const sim = createGraphSimulation();
    const hub = makeGraphNode("hub");
    const leaves = Array.from({ length: 40 }, (_, i) => makeGraphNode(`leaf${i}`));
    const positions: Record<string, { x: number; y: number }> = { hub: { x: 0, y: 0 } };
    leaves.forEach((leaf, i) => {
      const angle = (i / leaves.length) * Math.PI * 2;
      positions[leaf.id] = { x: Math.cos(angle) * 900, y: Math.sin(angle) * 900 };
    });
    sim.setNodes([hub, ...leaves], () => 6, positions);
    sim.setEdges(
      leaves.map((leaf) => ({ id: `hub-${leaf.id}`, source: "hub", target: leaf.id, reasons: [] })),
      1
    );
    sim.reheat(1);

    let worstHubSpeed = 0;
    for (let tick = 0; tick < 400; tick++) {
      sim.tick();
      const physics = sim.findNode("hub")!;
      worstHubSpeed = Math.max(worstHubSpeed, Math.hypot(physics.vx ?? 0, physics.vy ?? 0));
    }
    expect(worstHubSpeed).toBeLessThanOrEqual(MAX_NODE_SPEED + 1e-6);
    // The hub belongs in the middle of its own neighbourhood, not flung out of it.
    const hubNode = sim.findNode("hub")!;
    expect(Math.hypot(hubNode.x!, hubNode.y!)).toBeLessThan(400);
  });

  it("still lets the edge-strength setting scale the pull", () => {
    const distanceAfter = (strength: number) => {
      const sim = createGraphSimulation();
      const nodes = [makeGraphNode("a"), makeGraphNode("b")];
      sim.setNodes(nodes, () => 5, { a: { x: -600, y: 0 }, b: { x: 600, y: 0 } });
      sim.setEdges([{ id: "a-b", source: "a", target: "b", reasons: [] }], strength);
      sim.reheat(1);
      for (let i = 0; i < 60; i++) sim.tick();
      const a = sim.findNode("a")!;
      const b = sim.findNode("b")!;
      return Math.hypot(a.x! - b.x!, a.y! - b.y!);
    };
    expect(distanceAfter(1)).toBeLessThan(distanceAfter(0.05));
  });
});
