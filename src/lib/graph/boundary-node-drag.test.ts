/**
 * Regression suite for dragging a TAB that lives inside a boundary square.
 *
 * The failure these cover: a boundary body's rect is re-derived from its
 * members every tick and the collision layer answers with a per-body delta
 * the engine applies to those same members. That is only sound while every
 * member the rect came from is one the physics may move. The tab under the
 * pointer is not — d3 holds it at `fx`/`fy` and the drag handler rewrites
 * those every pointermove — so counting it made each collision push DEFORM
 * the box rather than translate it: the box grew by the push, the bigger box
 * overlapped its neighbour harder, and the next frame's push grew again.
 *
 * Measured on the 25-box grid below, dragging a single tab ~3400 world units:
 *
 *                            own cluster's other tabs | unrelated clusters
 *   boundary layer off                            64  |               375
 *   before the fix                              1996  |              2442
 *   after the fix                                 83  |               353
 *
 * The "before" numbers are the reported bug — a square that stretches far
 * outside the region its tabs are in, and edges dragged clear across the
 * canvas — so the assertions here are written against the blast radius of a
 * drag, never against how large a box is allowed to look.
 */
import { describe, expect, it } from "vitest";
import { createGraphSimulation, type GraphSimulation } from "./engine";
import { screenToWorld } from "./layout";
import type { GraphNode } from "./types";

function makeGraphNode(id: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com" },
    workspaceId: "ws-1",
    workspaceName: "Workspace",
  };
}

type Scene = {
  sim: GraphSimulation;
  nodeIds: string[];
  boxIds: string[];
  membersOf: (boxId: string) => string[];
};

/**
 * `columns` x `rows` boundary squares of `perBox` tabs each, laid out on a
 * 700-unit pitch — close enough that a box which stretches will reach its
 * neighbours, far enough apart that they start cleanly separated.
 * `withBoxes: false` builds the identical node layout with no boundary layer
 * at all, which is the control every blast-radius assertion is measured
 * against.
 */
function gridScene({ columns = 5, rows = 5, perBox = 6, withBoxes = true } = {}): Scene {
  const sim = createGraphSimulation();
  const nodes: GraphNode[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  const specs: { id: string; memberIds: string[]; padding: number }[] = [];
  const members = new Map<string, string[]>();

  for (let gx = 0; gx < columns; gx++) {
    for (let gy = 0; gy < rows; gy++) {
      const boxId = `box-${gx}-${gy}`;
      const memberIds: string[] = [];
      for (let k = 0; k < perBox; k++) {
        const id = `${boxId}-t${k}`;
        nodes.push(makeGraphNode(id));
        positions[id] = {
          x: (gx - (columns - 1) / 2) * 700 + ((k % 3) - 1) * 70,
          y: (gy - (rows - 1) / 2) * 700 + (Math.floor(k / 3) - 0.5) * 70,
        };
        memberIds.push(id);
      }
      members.set(boxId, memberIds);
      specs.push({ id: boxId, memberIds, padding: 20 });
    }
  }

  sim.setNodes(nodes, () => 10, positions);
  sim.setEdges([], 1);
  if (withBoxes) sim.setBoundaryBodies(specs);
  for (let i = 0; i < 120; i++) sim.tick();

  return {
    sim,
    nodeIds: nodes.map((n) => n.id),
    boxIds: withBoxes ? specs.map((s) => s.id) : [],
    membersOf: (boxId) => members.get(boxId) ?? [],
  };
}

function snapshot(scene: Scene): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const id of scene.nodeIds) {
    const node = scene.sim.findNode(id)!;
    out.set(id, { x: node.x!, y: node.y! });
  }
  return out;
}

/** Furthest any tab moved between two snapshots, split by whether it shares the dragged tab's box. */
function displacement(
  before: Map<string, { x: number; y: number }>,
  after: Map<string, { x: number; y: number }>,
  scene: Scene,
  dragId: string,
  boxOfDragged: string
): { sameBox: number; otherBoxes: number } {
  const siblings = new Set(scene.membersOf(boxOfDragged));
  let sameBox = 0;
  let otherBoxes = 0;
  for (const id of scene.nodeIds) {
    if (id === dragId) continue;
    const a = before.get(id)!;
    const b = after.get(id)!;
    const moved = Math.hypot(b.x - a.x, b.y - a.y);
    if (siblings.has(id)) sameBox = Math.max(sameBox, moved);
    else otherBoxes = Math.max(otherBoxes, moved);
  }
  return { sameBox, otherBoxes };
}

/**
 * One tab drag, driven the way graph-canvas.tsx drives it: `pin` to an
 * absolute world point per pointermove, then a frame.
 *
 * `pointerEveryNFrames` models the pointer updating more slowly than the
 * render loop — the interleaving that made the original bug intermittent,
 * since the box kept being translated on the frames in between and the next
 * pin snapped the dragged tab back out of that translation.
 */
function dragTab(
  sim: GraphSimulation,
  id: string,
  { frames, dx, dy, pointerEveryNFrames = 1 }: { frames: number; dx: number; dy: number; pointerEveryNFrames?: number }
): void {
  const node = sim.findNode(id)!;
  let x = node.x!;
  let y = node.y!;
  sim.pin(id, x, y);
  for (let frame = 0; frame < frames; frame++) {
    if (frame % pointerEveryNFrames === 0) {
      x += dx * pointerEveryNFrames;
      y += dy * pointerEveryNFrames;
      sim.pin(id, x, y);
    }
    sim.reheat(0.35);
    sim.tick();
  }
  sim.unpin(id);
}

function everyCoordinateIsFinite(scene: Scene): boolean {
  for (const id of scene.nodeIds) {
    const node = scene.sim.findNode(id)!;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return false;
    if (!Number.isFinite(node.vx) || !Number.isFinite(node.vy)) return false;
  }
  for (const boxId of scene.boxIds) {
    const body = scene.sim.getBoundaryBody(boxId)!;
    if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) return false;
    if (!Number.isFinite(body.halfWidth) || !Number.isFinite(body.halfHeight)) return false;
    if (body.halfWidth < 0 || body.halfHeight < 0) return false;
  }
  return true;
}

/** Furthest any tab sits from the world origin — the graph's own extent. */
function graphExtent(scene: Scene): number {
  let reach = 0;
  for (const id of scene.nodeIds) {
    const node = scene.sim.findNode(id)!;
    reach = Math.max(reach, Math.abs(node.x!), Math.abs(node.y!));
  }
  return reach;
}

/**
 * The blast radius the node forces alone produce for the same drag — the
 * honest bar for "did the boundary layer add anything". Recomputed per test
 * rather than hard-coded so a future change to charge/collide moves the
 * control and the assertion together.
 */
function controlDisplacement(drag: (scene: Scene) => void, dragId: string, boxOfDragged: string) {
  const control = gridScene({ withBoxes: false });
  const before = snapshot(control);
  drag(control);
  return displacement(before, snapshot(control), control, dragId, boxOfDragged);
}

describe("dragging a tab that lives inside a boundary square", () => {
  const DRAG_ID = "box-2-2-t0";
  const DRAG_BOX = "box-2-2";

  it("leaves the dragged tab's own cluster where it was", () => {
    // The heart of the bug: box-2-2 stretches as its tab is carried away, and
    // used to be pushed off its neighbours as a rigid body while doing so —
    // which moved the five tabs that were NOT being dragged instead, because
    // the sixth was nailed to the pointer and could not follow.
    const drag = (scene: Scene) => dragTab(scene.sim, DRAG_ID, { frames: 400, dx: 8, dy: 3 });
    const control = controlDisplacement(drag, DRAG_ID, DRAG_BOX);

    const scene = gridScene();
    const before = snapshot(scene);
    drag(scene);
    const moved = displacement(before, snapshot(scene), scene, DRAG_ID, DRAG_BOX);

    // Measured: 83 here against a 64 control, and 1996 before the fix.
    expect(moved.sameBox).toBeLessThan(control.sameBox + 100);
  });

  it("does not shove unrelated clusters across the graph", () => {
    const drag = (scene: Scene) => dragTab(scene.sim, DRAG_ID, { frames: 400, dx: 8, dy: 3 });
    const control = controlDisplacement(drag, DRAG_ID, DRAG_BOX);

    const scene = gridScene();
    const before = snapshot(scene);
    drag(scene);
    const moved = displacement(before, snapshot(scene), scene, DRAG_ID, DRAG_BOX);

    // Measured: 353 here against a 375 control, and 2442 before the fix.
    expect(moved.otherBoxes).toBeLessThan(control.otherBoxes + 100);
  });

  it("holds when the pointer updates more slowly than the frame loop", () => {
    // Same total travel, delivered in bigger jumps six frames apart. This is
    // the interleaving that made the original failure intermittent.
    const drag = (scene: Scene) => dragTab(scene.sim, DRAG_ID, { frames: 400, dx: 8, dy: 3, pointerEveryNFrames: 6 });
    const control = controlDisplacement(drag, DRAG_ID, DRAG_BOX);

    const scene = gridScene();
    const before = snapshot(scene);
    drag(scene);
    const moved = displacement(before, snapshot(scene), scene, DRAG_ID, DRAG_BOX);

    expect(moved.sameBox).toBeLessThan(control.sameBox + 100);
    expect(moved.otherBoxes).toBeLessThan(control.otherBoxes + 100);
  });

  it("keeps a body's collider equal to the bounding box of the members it can move", () => {
    // The invariant the fix rests on, asserted directly and every frame: the
    // rect the collision solver works from describes exactly the members the
    // solver is allowed to translate — never the pinned one.
    const scene = gridScene();
    const sim = scene.sim;
    const members = scene.membersOf(DRAG_BOX);
    const node = sim.findNode(DRAG_ID)!;
    let x = node.x!;
    let y = node.y!;

    for (let frame = 0; frame < 300; frame++) {
      x += 10;
      y += 4;
      sim.pin(DRAG_ID, x, y);
      sim.reheat(0.35);
      sim.tick();

      const body = sim.getBoundaryBody(DRAG_BOX)!;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of members) {
        if (id === DRAG_ID) continue;
        const member = sim.findNode(id)!;
        minX = Math.min(minX, member.x! - member.radius);
        maxX = Math.max(maxX, member.x! + member.radius);
        minY = Math.min(minY, member.y! - member.radius);
        maxY = Math.max(maxY, member.y! + member.radius);
      }
      expect(body.halfWidth).toBeCloseTo((maxX - minX) / 2 + 20, 6);
      expect(body.halfHeight).toBeCloseTo((maxY - minY) / 2 + 20, 6);
      expect(body.x).toBeCloseTo((minX + maxX) / 2, 6);
      expect(body.y).toBeCloseTo((minY + maxY) / 2, 6);
    }
    sim.unpin(DRAG_ID);
  });

  it("sits a box out entirely while every one of its tabs is under the pointer", () => {
    // A single-tab collection whose tab is being dragged has no geometry the
    // physics owns: its rect is where the tab WAS. Colliding from there would
    // shove its neighbours off a phantom.
    const build = (withBoxes: boolean) => {
      const sim = createGraphSimulation();
      sim.setNodes([makeGraphNode("solo"), makeGraphNode("n1"), makeGraphNode("n2")], () => 10, {
        solo: { x: 0, y: 0 },
        n1: { x: 300, y: 0 },
        n2: { x: 360, y: 0 },
      });
      sim.setEdges([], 1);
      if (withBoxes) {
        sim.setBoundaryBodies([
          { id: "soloBox", memberIds: ["solo"], padding: 40 },
          { id: "pairBox", memberIds: ["n1", "n2"], padding: 40 },
        ]);
      }
      for (let i = 0; i < 40; i++) sim.tick();
      return sim;
    };
    // Drag the lone tab straight through the pair's box, with and without a
    // boundary layer at all.
    const run = (sim: GraphSimulation) => {
      const before = { x: sim.findNode("n1")!.x!, y: sim.findNode("n1")!.y! };
      dragTab(sim, "solo", { frames: 60, dx: 12, dy: 0 });
      const after = { x: sim.findNode("n1")!.x!, y: sim.findNode("n1")!.y! };
      return Math.hypot(after.x - before.x, after.y - before.y);
    };

    const control = run(build(false));
    const sim = build(true);
    const moved = run(sim);

    expect(sim.getBoundaryBody("soloBox")!.governed).toBe(false);
    // n1 drifts under charge/collide either way; what must not happen is the
    // pair's box being shoved off `soloBox`'s abandoned rect on top of that.
    expect(moved).toBeCloseTo(control, 6);
  });

  it("survives repeated drags of the same tab without the graph creeping outward", () => {
    const scene = gridScene();
    const extents: number[] = [];
    for (let round = 0; round < 6; round++) {
      dragTab(scene.sim, DRAG_ID, { frames: 60, dx: round % 2 === 0 ? 10 : -10, dy: round % 2 === 0 ? 6 : -6 });
      for (let i = 0; i < 60; i++) scene.sim.tick();
      extents.push(graphExtent(scene));
    }
    expect(everyCoordinateIsFinite(scene)).toBe(true);
    // A drag that returns to where it started must not leave the graph
    // permanently wider than it began.
    expect(extents[extents.length - 1]).toBeLessThan(extents[0] * 1.5);
  });

  it("keeps every coordinate finite through a randomized run of many drags", () => {
    // Deterministic PRNG — a stress case that cannot be reproduced is not
    // regression coverage.
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    const scene = gridScene({ columns: 4, rows: 4, perBox: 5 });
    for (let run = 0; run < 40; run++) {
      const gx = Math.floor(random() * 4);
      const gy = Math.floor(random() * 4);
      const k = Math.floor(random() * 5);
      dragTab(scene.sim, `box-${gx}-${gy}-t${k}`, {
        frames: 10 + Math.floor(random() * 40),
        dx: (random() - 0.5) * 40,
        dy: (random() - 0.5) * 40,
        pointerEveryNFrames: 1 + Math.floor(random() * 5),
      });
      for (let i = 0; i < 10; i++) scene.sim.tick();
      expect(everyCoordinateIsFinite(scene)).toBe(true);
    }
  });

  it("moves a tab by the same world delta at every zoom and pan", () => {
    // The engine only ever sees world coordinates; graph-canvas.tsx converts
    // the pointer with screenToWorld before calling pin(). This walks that
    // whole path so a future change on either side of it can't silently make
    // a drag zoom-dependent.
    const viewport = { width: 1200, height: 800 };
    const steps = 40;
    const stepWorldX = 12;
    const stepWorldY = 5;
    const results = [
      { x: 0, y: 0, zoom: 1 },
      { x: 0, y: 0, zoom: 0.25 },
      { x: 0, y: 0, zoom: 3 },
      { x: 1500, y: -900, zoom: 0.4 },
      { x: -2200, y: 700, zoom: 2.5 },
    ].map((camera) => {
      const scene = gridScene();
      const sim = scene.sim;
      const node = sim.findNode(DRAG_ID)!;
      const from = { x: node.x!, y: node.y! };

      // A fixed WORLD-space path, expressed as the screen points this camera
      // would put it under — the pointer positions the browser would report.
      for (let step = 1; step <= steps; step++) {
        const worldTarget = { x: from.x + step * stepWorldX, y: from.y + step * stepWorldY };
        const screen = {
          x: (worldTarget.x - camera.x) * camera.zoom + viewport.width / 2,
          y: (worldTarget.y - camera.y) * camera.zoom + viewport.height / 2,
        };
        const world = screenToWorld(camera, screen, viewport.width, viewport.height);
        sim.pin(DRAG_ID, world.x, world.y);
        sim.reheat(0.35);
        sim.tick();
      }
      const landed = sim.findNode(DRAG_ID)!;
      sim.unpin(DRAG_ID);
      return { dx: landed.x! - from.x, dy: landed.y! - from.y };
    });

    for (const result of results) {
      expect(result.dx).toBeCloseTo(steps * stepWorldX, 6);
      expect(result.dy).toBeCloseTo(steps * stepWorldY, 6);
    }
  });
});
