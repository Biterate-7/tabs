/**
 * Adversarial stress test for the boundary-square physics layer (see
 * boundary-physics.ts / engine.ts's boundary layer), run against the real
 * 283-tab workspace export rather than a synthetic two-box fixture — this is
 * the density (dozens of categories, hundreds of tabs) at which the reported
 * "stretched square / giant line" corruption was seen.
 *
 * Unlike boundary-drag.test.ts (unit behaviour on two boxes) or
 * g-verification.test.ts (layout QUALITY metrics), this asks one question
 * only: can a boundary body's rendered rect ever become non-finite or
 * absurdly distorted, under the kind of input a real pointer/animation-frame
 * loop can produce (teleporting targets, simultaneous drags, rapid
 * releases)? It asserts the invariant every frame, not just at the end, so a
 * one-frame glitch that "heals" on the next tick still fails the test.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "./relations";
import { buildClusterTree } from "./clusters";
import { computeClusterAnchors } from "./clusters";
import { computeNodeRadius } from "./node-size";
import { createGraphSimulation } from "./engine";
import { CATEGORY_BOUNDARY_PADDING, SUBCATEGORY_BOUNDARY_PADDING } from "./collection-layout";
import { boundariesShareMembers, BOUNDARY_MAX_COORD } from "./boundary-physics";
import { DEFAULT_CONNECTION_FILTERS } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace } from "@/lib/workspace/types";

const EXPORT_PATH = join(process.cwd(), "tabdump-export.json");
const HAS_FIXTURE = existsSync(EXPORT_PATH);

function loadWorkspace() {
  const raw = JSON.parse(readFileSync(EXPORT_PATH, "utf8"));
  const workspaces: Workspace[] = raw.workspaces ?? [];
  return {
    tabs: workspaces.flatMap((w) => w.tabs ?? []) as Tab[],
    sections: workspaces.flatMap((w) => w.sections ?? []) as Section[],
    collections: raw.collections ?? [],
    workspaces,
  };
}

/** A body's rect, exactly as the renderer would compute worldRectToScreen from — used to check the drawn shape stays a sane square/rect, never a sliver or a sprawl. */
function rectOf(body: { x: number; y: number; halfWidth: number; halfHeight: number }) {
  return { x: body.x - body.halfWidth, y: body.y - body.halfHeight, width: body.halfWidth * 2, height: body.halfHeight * 2 };
}

/**
 * A "clean square boundary" invariant check for one body: finite geometry,
 * a non-negative, reasonably bounded rect, and no runaway velocity. This is
 * a direct translation of the bug report's hard invariants — never NaN,
 * never Infinity, never a rect thousands of pixels across for a handful of
 * ~50px-radius-collided nodes.
 */
function assertCleanBody(body: ReturnType<ReturnType<typeof createGraphSimulation>["getBoundaryBody"]>, label: string) {
  if (!body) return;
  expect(Number.isFinite(body.x), `${label}.x finite`).toBe(true);
  expect(Number.isFinite(body.y), `${label}.y finite`).toBe(true);
  expect(Number.isFinite(body.vx), `${label}.vx finite`).toBe(true);
  expect(Number.isFinite(body.vy), `${label}.vy finite`).toBe(true);
  expect(Number.isFinite(body.halfWidth), `${label}.halfWidth finite`).toBe(true);
  expect(Number.isFinite(body.halfHeight), `${label}.halfHeight finite`).toBe(true);
  expect(body.halfWidth, `${label}.halfWidth >= 0`).toBeGreaterThanOrEqual(0);
  expect(body.halfHeight, `${label}.halfHeight >= 0`).toBeGreaterThanOrEqual(0);
  expect(Math.abs(body.x), `${label}.x within coord ceiling`).toBeLessThanOrEqual(BOUNDARY_MAX_COORD);
  expect(Math.abs(body.y), `${label}.y within coord ceiling`).toBeLessThanOrEqual(BOUNDARY_MAX_COORD);
  const rect = rectOf(body);
  expect(Number.isFinite(rect.width) && Number.isFinite(rect.height), `${label} rect finite`).toBe(true);
}

describe.skipIf(!HAS_FIXTURE)("boundary layer under adversarial drag input (real export)", () => {
  function setUp({ withBoxes = true } = {}) {
    const data = loadWorkspace();
    const lookup = buildWorkspaceLookup(data.workspaces);
    const nodes = buildGraphNodes(data.tabs, lookup);
    const edges = buildGraphEdges(data.tabs, lookup, DEFAULT_CONNECTION_FILTERS, [], data.sections);
    const tree = buildClusterTree(data.tabs, data.sections, data.collections);
    const anchors = computeClusterAnchors(tree);

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const sim = createGraphSimulation();
    sim.setNodes(
      nodes,
      (node) => computeNodeRadius("connections", degree.get(node.id) ?? 0, undefined),
      {},
      (node) => anchors.get(node.id)?.categoryAnchor ?? undefined
    );
    sim.setEdges(edges, 1);
    sim.setCollections(data.collections);
    sim.setClusterAnchors(anchors);
    sim.reheat(1);
    for (let i = 0; i < 500; i++) sim.tick();

    const specs: { id: string; memberIds: string[]; padding: number }[] = [];
    for (const cat of tree.roots) {
      specs.push({ id: cat.id, memberIds: cat.totalTabIds, padding: CATEGORY_BOUNDARY_PADDING });
      for (const sub of cat.children) {
        if (sub.kind === "subcategory") specs.push({ id: sub.id, memberIds: sub.totalTabIds, padding: SUBCATEGORY_BOUNDARY_PADDING });
      }
    }
    // `withBoxes: false` is the control for the tab-drag cases below: the
    // identical graph with no boundary layer at all, so "what did the
    // boundary layer add to this drag" is measured rather than guessed.
    if (withBoxes) sim.setBoundaryBodies(specs);
    for (let i = 0; i < 50; i++) sim.tick();

    return { sim, specs, tabIds: nodes.map((n) => n.id) };
  }

  function assertAllClean(sim: ReturnType<typeof createGraphSimulation>, specs: { id: string }[]) {
    for (const spec of specs) assertCleanBody(sim.getBoundaryBody(spec.id), spec.id);
  }

  it(
    "stays finite and bounded while one box is teleport-dragged across the whole world every frame",
    () => {
      const { sim, specs } = setUp();
      const id = specs[0].id;
      let rng = 42;
      const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

      expect(sim.beginBoundaryDrag(id, 0, 0)).toBe(true);
      for (let frame = 0; frame < 600; frame++) {
        // A pointer position that jumps wildly frame to frame — the worst case
        // for a substep/impulse scheme, and exactly what a dropped animation
        // frame or a fast flick produces.
        const target = (rand() - 0.5) * 20000;
        const target2 = (rand() - 0.5) * 20000;
        sim.moveBoundaryDrag(target, target2);
        sim.tick();
        assertAllClean(sim, specs);
      }
      sim.endBoundaryDrag();
      for (let i = 0; i < 100; i++) {
        sim.tick();
        assertAllClean(sim, specs);
      }
    },
    30_000
  );

  /**
   * The initial-overlap lifecycle, on the real export rather than a pair of
   * synthetic boxes. Before bodies were created awake this measured 3
   * unrelated pairs still overlapping after any amount of stepping, the
   * worst at 83% of the smaller box — because a body born asleep inside
   * another one is skipped by resolveOverlaps forever.
   *
   * Peer overlaps must go; the intentional parent/child nestings (boxes that
   * share tabs — a subcategory inside its category) must stay exactly as
   * they are; and every body must still be there afterwards.
   */
  it("resolves the overlaps its bodies are born with, keeping every body and every nesting", () => {
    const { sim, specs } = setUp();

    const bodiesNow = () =>
      specs.map((s2) => sim.getBoundaryBody(s2.id)).filter((b): b is NonNullable<typeof b> => Boolean(b));
    const survey = () => {
      const bodies = bodiesNow();
      let peers = 0;
      let nested = 0;
      let worst = 0;
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i];
          const b = bodies[j];
          const ox = a.halfWidth + b.halfWidth - Math.abs(a.x - b.x);
          const oy = a.halfHeight + b.halfHeight - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0) continue;
          if (boundariesShareMembers(a, b)) {
            nested++;
            continue;
          }
          peers++;
          worst = Math.max(worst, (ox * oy) / (Math.min(a.halfWidth * a.halfHeight, b.halfWidth * b.halfHeight) * 4));
        }
      }
      return { count: bodies.length, peers, nested, worst };
    };

    const before = survey();
    expect(before.count, "expected the real export to produce a body per drawn boundary").toBeGreaterThan(10);

    for (let frame = 0; frame < 600 && !sim.isBoundaryLayerSettled(); frame++) sim.tick();

    const after = survey();
    expect(sim.isBoundaryLayerSettled(), "boundary layer never came to rest").toBe(true);
    expect(after.peers, `${after.peers} peer boundaries still overlapping at rest`).toBe(0);
    // Nesting is not a collision and must be untouched by any of this.
    expect(after.nested).toBe(before.nested);
    // NOT ONE BODY LOST. Resolving a collision moves squares; it never removes them.
    expect(after.count).toBe(before.count);
    assertAllClean(sim, specs);
  }, 60_000);

  it("stays finite and bounded while every box is dragged into the same point simultaneously", () => {
    const { sim, specs } = setUp();
    // Drag every single box toward the exact same origin point one frame at a
    // time (a single BoundaryDrag can only move one body, so this round-robins
    // the drag target across all of them every tick) — the maximal-collision
    // scenario: every body wedged against every other body at once.
    for (let frame = 0; frame < 1000; frame++) {
      const spec = specs[frame % specs.length];
      sim.beginBoundaryDrag(spec.id, 0, 0);
      sim.moveBoundaryDrag(0, 0);
      sim.tick();
      sim.endBoundaryDrag();
      assertAllClean(sim, specs);
    }
  });

  it("stays finite and bounded across rapid grab/fling/release cycles on many boxes", () => {
    const { sim, specs } = setUp();
    let rng = 7;
    const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let cycle = 0; cycle < 300; cycle++) {
      const spec = specs[Math.floor(rand() * specs.length)];
      const body = sim.getBoundaryBody(spec.id);
      if (!body) continue;
      sim.beginBoundaryDrag(spec.id, body.x, body.y);
      // A short, fast fling: a handful of frames with a large per-frame jump,
      // then release — the exact shape of a real "flick and let go" gesture.
      for (let f = 0; f < 3; f++) {
        sim.moveBoundaryDrag(body.x + (rand() - 0.5) * 5000, body.y + (rand() - 0.5) * 5000);
        sim.tick();
        assertAllClean(sim, specs);
      }
      sim.endBoundaryDrag();
      sim.tick();
      assertAllClean(sim, specs);
    }
    for (let i = 0; i < 200; i++) {
      sim.tick();
      assertAllClean(sim, specs);
    }
    // Explicit budget, like the sibling case above. 300 fling cycles over the
    // real export's ~40 bodies, each re-surveying every body, runs ~3.7s alone
    // and ~5s alongside the rest of this file — i.e. it has always sat on top
    // of vitest's 5s default and failed on timing rather than on an assertion.
  }, 30_000);

  it("never lets one box's rect balloon into a stretched sliver relative to its own members' spread", () => {
    const { sim, specs } = setUp();
    const id = specs[0].id;
    expect(sim.beginBoundaryDrag(id, 0, 0)).toBe(true);
    for (let frame = 0; frame < 500; frame++) {
      sim.moveBoundaryDrag(Math.sin(frame) * 3000, Math.cos(frame * 1.3) * 3000);
      sim.tick();
    }
    sim.endBoundaryDrag();
    for (let i = 0; i < 60; i++) sim.tick();

    const body = sim.getBoundaryBody(id)!;
    // A "stretched line/triangle" is, geometrically, an aspect ratio blowing
    // up far beyond what a same-cluster bounding box should ever show. This
    // is deliberately loose (20x) — the point is to catch degenerate slivers
    // (1000s-to-1), not to constrain normal cluster shape.
    const aspect = body.halfWidth > body.halfHeight ? body.halfWidth / Math.max(1, body.halfHeight) : body.halfHeight / Math.max(1, body.halfWidth);
    expect(aspect).toBeLessThan(20);
  });

  /**
   * Dragging a TAB, not a box — the gesture the corruption was actually
   * reported for, at the density it was reported at. Everything above drags
   * boxes, which is the one case where the layer's rigid-translation
   * invariant was never in doubt.
   *
   * See boundary-node-drag.test.ts for the mechanism and the synthetic
   * measurements; this is the same property against the real export, with its
   * real category discs, confinement and ~40 nested boundary bodies.
   */
  function dragTabsAround(sim: ReturnType<typeof createGraphSimulation>, tabIds: string[], onFrame?: () => void) {
    let rng = 1337;
    const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let gesture = 0; gesture < 25; gesture++) {
      const id = tabIds[Math.floor(rand() * tabIds.length)];
      const node = sim.findNode(id);
      if (!node || node.x === undefined || node.y === undefined) continue;
      let x = node.x;
      let y = node.y;
      const dx = (rand() - 0.5) * 60;
      const dy = (rand() - 0.5) * 60;
      // A pointer that only reports every few frames, which is what let the
      // box keep translating underneath a tab that then snapped back.
      const pointerEvery = 1 + Math.floor(rand() * 4);
      for (let frame = 0; frame < 60; frame++) {
        if (frame % pointerEvery === 0) {
          x += dx * pointerEvery;
          y += dy * pointerEvery;
          sim.pin(id, x, y);
        }
        sim.reheat(0.35);
        sim.tick();
        onFrame?.();
      }
      sim.unpin(id);
      for (let i = 0; i < 20; i++) {
        sim.tick();
        onFrame?.();
      }
    }
  }

  function tabExtent(sim: ReturnType<typeof createGraphSimulation>, tabIds: string[]) {
    let reach = 0;
    for (const id of tabIds) {
      const node = sim.findNode(id);
      if (!node || node.x === undefined || node.y === undefined) continue;
      reach = Math.max(reach, Math.abs(node.x), Math.abs(node.y));
    }
    return reach;
  }

  it(
    "keeps every body clean while tabs inside the boxes are dragged around",
    () => {
      const { sim, specs, tabIds } = setUp();
      dragTabsAround(sim, tabIds, () => assertAllClean(sim, specs));
    },
    60_000
  );

  it(
    "does not let tab drags inflate the graph beyond what the node forces alone do",
    () => {
      // The reported failure, stated as a measurement: with the boundary
      // layer in play, the same 25 tab drags used to blow the graph's own
      // extent far past what those drags do with no boxes at all — squares
      // stretched across the canvas, edges dragged with them.
      const control = setUp({ withBoxes: false });
      dragTabsAround(control.sim, control.tabIds);
      const controlExtent = tabExtent(control.sim, control.tabIds);

      const live = setUp();
      dragTabsAround(live.sim, live.tabIds);
      const liveExtent = tabExtent(live.sim, live.tabIds);

      expect(liveExtent).toBeLessThan(controlExtent * 1.25);
    },
    60_000
  );
});
