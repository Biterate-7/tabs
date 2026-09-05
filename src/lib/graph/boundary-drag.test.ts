import { describe, expect, it } from "vitest";
import { createGraphSimulation } from "./engine";
import { BOUNDARY_MAX_SPEED, BOUNDARY_RELEASE_FACTOR } from "./boundary-physics";
import type { GraphNode } from "./types";

function makeGraphNode(id: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com" },
    workspaceId: "ws-1",
    workspaceName: "Workspace",
  };
}

/**
 * Two single-tab boundary boxes, far enough apart that d3's charge force
 * (distanceMax 600) can't reach across them, so what the assertions below
 * measure is the boundary layer rather than the node layout.
 */
function twoBoxes() {
  const sim = createGraphSimulation();
  sim.setNodes([makeGraphNode("a"), makeGraphNode("b")], () => 10, {
    a: { x: -400, y: 0 },
    b: { x: 400, y: 0 },
  });
  sim.setEdges([], 1);
  sim.setBoundaryBodies([
    { id: "boxA", memberIds: ["a"], padding: 40 },
    { id: "boxB", memberIds: ["b"], padding: 40 },
  ]);
  return sim;
}

function boxesOverlap(sim: ReturnType<typeof createGraphSimulation>): boolean {
  const a = sim.getBoundaryBody("boxA")!;
  const b = sim.getBoundaryBody("boxB")!;
  return Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth - 1 && Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight - 1;
}

describe("boundary bodies", () => {
  it("derives its collider from its members' own bounding box", () => {
    const sim = twoBoxes();
    const body = sim.getBoundaryBody("boxA")!;
    expect(body.x).toBeCloseTo(-400, 5);
    expect(body.y).toBeCloseTo(0, 5);
    // node radius 10 + padding 40
    expect(body.halfWidth).toBeCloseTo(50, 5);
    expect(body.halfHeight).toBeCloseTo(50, 5);
  });

  it("keeps existing bodies (and the live drag) across a membership refresh", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    const before = sim.getBoundaryBody("boxA");
    sim.setBoundaryBodies([
      { id: "boxA", memberIds: ["a"], padding: 40 },
      { id: "boxB", memberIds: ["b"], padding: 40 },
    ]);
    expect(sim.getBoundaryBody("boxA")).toBe(before);
    expect(sim.isBoundaryLayerSettled()).toBe(false);
  });

  it("drops a body the renderer no longer draws", () => {
    const sim = twoBoxes();
    sim.setBoundaryBodies([{ id: "boxA", memberIds: ["a"], padding: 40 }]);
    expect(sim.getBoundaryBody("boxB")).toBeUndefined();
  });
});

describe("dragging a boundary square", () => {
  it("carries its member tabs with it, not just the drawn box", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(-400, 500);
    sim.tick();

    expect(sim.getBoundaryBody("boxA")!.y).toBeCloseTo(500, 5);
    // The physics node itself moved — this is the position the graph persists.
    expect(sim.findNode("a")!.y!).toBeGreaterThan(400);
  });

  it("reports every tab a boundary move displaced, then clears them", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(-400, 300);
    sim.tick();

    const moved = sim.takeDisplacedBoundaryMembers();
    expect(moved.map((m) => m.id)).toEqual(["a"]);
    expect(moved[0].y).toBeCloseTo(sim.findNode("a")!.y!, 5);
    expect(sim.takeDisplacedBoundaryMembers()).toEqual([]);
  });

  it("stays where it was dropped instead of springing back to its cluster anchor", () => {
    const sim = twoBoxes();
    sim.setClusterAnchors(
      new Map([
        ["a", { categoryAnchor: { x: -400, y: 0 }, subcategoryAnchor: null, confineTo: { x: -400, y: 0, r: 60 } }],
      ])
    );
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(-400, 600);
    sim.tick();
    sim.endBoundaryDrag();
    for (let i = 0; i < 200; i++) sim.tick();

    // Without the anchor/confinement travelling with the box, confineToRegions
    // would have projected this straight back to y ~ 60.
    expect(sim.findNode("a")!.y!).toBeGreaterThan(400);
  });

  it("reports the cluster-territory offset alongside each moved tab", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(-400, 250);
    sim.tick();

    const [moved] = sim.takeDisplacedBoundaryMembers();
    expect(moved.id).toBe("a");
    expect(moved.offset.y).toBeCloseTo(250, 5);
    // A little x drift is the node forces nudging the member (and so the
    // box's own centre) sideways while the pointer only moved on y.
    expect(Math.abs(moved.offset.x)).toBeLessThan(10);
  });

  it("restores a past session's move from the saved offset instead of springing home", () => {
    const anchors = new Map([
      ["a", { categoryAnchor: { x: -400, y: 0 }, subcategoryAnchor: null, confineTo: { x: -400, y: 0, r: 60 } }],
    ]);

    // A reload: tabs come back at their saved positions, the cluster anchors
    // are recomputed at their canonical points, and the saved offset is what
    // carries the territory back to where the user dropped it.
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("a")], () => 10, { a: { x: -400, y: 600 } });
    sim.seedBoundaryOffsets({ a: { x: 0, y: 600 } });
    sim.setClusterAnchors(anchors);
    for (let i = 0; i < 200; i++) sim.tick();
    expect(sim.findNode("a")!.y!).toBeGreaterThan(400);

    // Without the saved offset the same reload is dragged back to the anchor.
    const bare = createGraphSimulation();
    bare.setNodes([makeGraphNode("a")], () => 10, { a: { x: -400, y: 600 } });
    bare.setClusterAnchors(anchors);
    for (let i = 0; i < 200; i++) bare.tick();
    expect(bare.findNode("a")!.y!).toBeLessThan(200);
  });

  it("never lets seeded offsets overwrite a move made in this session", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(-400, 300);
    sim.tick();
    sim.endBoundaryDrag();

    sim.seedBoundaryOffsets({ a: { x: 0, y: 0 } });
    const [moved] = sim.takeDisplacedBoundaryMembers();
    expect(moved.offset.y).toBeCloseTo(300, 5);
  });

  it("pushes the box it is dragged into apart instead of through", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(380, 0);
    sim.tick();

    expect(boxesOverlap(sim)).toBe(false);
    expect(sim.getBoundaryBody("boxB")!.x).toBeGreaterThan(400);
    // The pushed box's own tab moved with it — the collision is real, not drawn.
    expect(sim.findNode("b")!.x!).toBeGreaterThan(400);
  });

  it("never merges two boxes, however many times they are driven together", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    for (let pass = 0; pass < 30; pass++) {
      sim.moveBoundaryDrag(sim.getBoundaryBody("boxB")!.x - 20, 0);
      sim.tick();
      sim.moveBoundaryDrag(-400, 0);
      sim.tick();
    }
    sim.endBoundaryDrag();

    const a = sim.getBoundaryBody("boxA")!;
    const b = sim.getBoundaryBody("boxB")!;
    expect(a.id).toBe("boxA");
    expect(b.id).toBe("boxB");
    expect(a.memberIds).toEqual(["a"]);
    expect(b.memberIds).toEqual(["b"]);
    expect(a.halfWidth).toBeCloseTo(50, 5);
    expect(b.halfWidth).toBeCloseTo(50, 5);
    expect(boxesOverlap(sim)).toBe(false);
  });

  it("stays inside the sandbox however far the pointer goes", () => {
    const sim = twoBoxes();
    sim.setBoundarySandbox({ minX: -600, minY: -400, maxX: 600, maxY: 400 });
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(-50_000, -50_000);
    sim.tick();

    const body = sim.getBoundaryBody("boxA")!;
    expect(body.x).toBeCloseTo(-550, 5);
    expect(body.y).toBeCloseTo(-350, 5);
  });

  it("hands a fast flick to the physics capped, and settles quickly", () => {
    const sim = twoBoxes();
    sim.beginBoundaryDrag("boxA", -400, 0);
    sim.moveBoundaryDrag(-400, 4000);
    sim.tick();
    sim.endBoundaryDrag();

    const body = sim.getBoundaryBody("boxA")!;
    expect(Math.abs(body.vy)).toBeLessThanOrEqual(BOUNDARY_MAX_SPEED * BOUNDARY_RELEASE_FACTOR);

    let ticks = 0;
    while (!sim.isBoundaryLayerSettled() && ticks < 300) {
      sim.tick();
      ticks++;
    }
    expect(sim.isBoundaryLayerSettled()).toBe(true);
    expect(ticks).toBeLessThan(60);
  });

  it("leaves the boundary layer alone when nothing is being dragged", () => {
    const sim = twoBoxes();
    expect(sim.isBoundaryLayerSettled()).toBe(true);
    for (let i = 0; i < 30; i++) sim.tick();
    expect(sim.takeDisplacedBoundaryMembers()).toEqual([]);
  });

  it("refuses to grab a box that has no body", () => {
    const sim = twoBoxes();
    expect(sim.beginBoundaryDrag("nope", 0, 0)).toBe(false);
    expect(sim.isBoundaryLayerSettled()).toBe(true);
  });
});
