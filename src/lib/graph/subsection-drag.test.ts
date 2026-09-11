/**
 * Dragging a subsection: it must move as one stable object, at any size.
 *
 * The reported failure was that dragging a subsection holding many tabs made
 * the graph "explode" — tabs collapsing together, colliding, and the whole
 * layout rearranging itself continuously. Three separate causes, each measured
 * here rather than described:
 *
 *  1. A subsection's confinement disc was sized from its PARENT's radius
 *     (`min(1.32x what its members need, 0.42x the parent)`) rather than from
 *     its own member count, so any subsection holding a real share of its
 *     category was 2.4-5.3x over-dense — at 60 tabs the closest pair settled
 *     12px inside each other — leaving collide and confineToRegions fighting
 *     every tick forever. See cluster-regions.ts's layoutCategoryGround.
 *  2. The drag target is anchored to the pointer while a body's position is
 *     re-derived from its members every frame, so once the members could not
 *     follow (clampFramesWithinParents holding a sub-disc inside its parent)
 *     the two diverged without limit and the dragged body — infinite mass,
 *     pushing everything it touches — was swept across the graph and snapped
 *     back every single frame. See engine.ts's stepBoundaryLayer.
 *  3. graph-canvas.tsx re-heated the whole force simulation on every
 *     pointermove of the drag, so the layout was being re-solved underneath a
 *     gesture whose members were already being moved rigidly. Covered by
 *     graph-view/canvas tests and by "no reheat" being the harness's default
 *     here — this file drives the simulation the way the canvas now does.
 */
import { describe, expect, it } from "vitest";
import { makeGraph, buildWorkspace } from "./__fixtures__/graph-harness";
import { baseDiscRadius } from "./cluster-regions";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace } from "@/lib/workspace/types";

const now = 1_700_000_000_000;

/**
 * One category holding a dominant subsection, plus sibling categories so the
 * fixture is not a single cluster filling the whole graph.
 */
function workspaceWithSubsection(subCount: number, looseCount = 8, siblingCategories = 4) {
  const sections: Section[] = [
    { id: "cat", parentId: null, name: "Physics", source: "ai", createdAt: now, updatedAt: now },
    { id: "sub", parentId: "cat", name: "Projectile Motion", source: "ai", createdAt: now, updatedAt: now },
  ];
  const tabs: Tab[] = [];
  const add = (id: string, sectionId: string, domain: string, title: string) =>
    tabs.push({ id, url: `https://${domain}/${id}`, normalizedUrl: `https://${domain}/${id}`, domain, title, category: "other", sectionId });

  for (let i = 0; i < subCount; i++) add(`s${i}`, "sub", "example.com", `Sub ${i}`);
  for (let i = 0; i < looseCount; i++) add(`c${i}`, "cat", "other.com", `Cat ${i}`);
  for (let k = 0; k < siblingCategories; k++) {
    const id = `sib${k}`;
    sections.push({ id, parentId: null, name: `Sibling ${k}`, source: "ai", createdAt: now, updatedAt: now });
    for (let i = 0; i < 12; i++) add(`n${k}-${i}`, id, `sib${k}.com`, `Sibling ${k} ${i}`);
  }

  const workspace: Workspace = { id: "ws", name: "W", tabs, sections, createdAt: now, updatedAt: now };
  return { tabs, sections, collections: [], workspaces: [workspace] };
}

const memberIdsFor = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`);

/**
 * Drags a boundary body `steps` frames of `perFrame` px, exactly as
 * graph-canvas.tsx now drives it: pointer moves, frames tick, and the force
 * simulation is NOT re-heated mid-gesture.
 */
function dragBoundary(
  graph: ReturnType<typeof makeGraph>,
  boundaryId: string,
  steps: number,
  perFrame: number,
  observe?: (frame: number) => void
) {
  const body = graph.simulation.getBoundaryBody(boundaryId);
  if (!body) throw new Error(`no body for ${boundaryId}`);
  const startX = body.x;
  const startY = body.y;
  graph.simulation.beginBoundaryDrag(boundaryId, startX, startY);
  for (let i = 1; i <= steps; i++) {
    graph.simulation.moveBoundaryDrag(startX + perFrame * i, startY);
    graph.frame();
    observe?.(i);
  }
  graph.simulation.endBoundaryDrag();
  return { startX, startY };
}

function minPairwiseGap(graph: ReturnType<typeof makeGraph>, ids: string[]): number {
  const pos = graph.positionsOf(ids);
  const radii = graph.radii();
  let min = Infinity;
  const present = ids.filter((id) => pos.has(id));
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = pos.get(present[i])!;
      const b = pos.get(present[j])!;
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y) - (radii.get(present[i]) ?? 0) - (radii.get(present[j]) ?? 0));
    }
  }
  return min;
}

/** Worst change in any member-to-member offset — 0 means the group kept its exact shape. */
function worstShapeChange(
  before: Map<string, { x: number; y: number }>,
  after: Map<string, { x: number; y: number }>
): number {
  const ids = [...before.keys()].filter((id) => after.has(id));
  let worst = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const b = { x: before.get(ids[i])!.x - before.get(ids[j])!.x, y: before.get(ids[i])!.y - before.get(ids[j])!.y };
      const a = { x: after.get(ids[i])!.x - after.get(ids[j])!.x, y: after.get(ids[i])!.y - after.get(ids[j])!.y };
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return worst;
}

describe("a subsection's ground is sized to its own members", () => {
  // Pre-fix, these ratios measured 0.64 / 0.52 / 0.46 / 0.43 — i.e. the disc
  // holding a subsection's tabs had between a quarter and a fifth of the AREA
  // those tabs need, and it got worse the more tabs the subsection held.
  for (const size of [1, 5, 20, 60]) {
    it(`holds ${size} tabs at the same density a category holds its own`, () => {
      const data = workspaceWithSubsection(size);
      const graph = makeGraph(data);
      const disc = graph.anchors.get("s0")?.confineTo;
      expect(disc).toBeDefined();
      expect(
        disc!.r / baseDiscRadius(size),
        `granted ${disc!.r.toFixed(1)}px vs ${baseDiscRadius(size).toFixed(1)}px needed`
      ).toBeGreaterThan(0.9);
    });
  }

  it("leaves a lone subsection room to be dragged inside its parent", () => {
    // A sub-disc flush with its parent's has zero slack under
    // clampFramesWithinParents and cannot be moved at all.
    const graph = makeGraph(workspaceWithSubsection(40));
    const assignment = graph.anchors.get("s0")!;
    expect(assignment.confineWithin!.r).toBeGreaterThan(assignment.confineTo!.r);
  });
});

describe("dragging a subsection", () => {
  for (const size of [1, 5, 20, 60]) {
    it(`keeps ${size} tab${size === 1 ? "" : "s"} in formation for the whole gesture`, () => {
      const data = workspaceWithSubsection(size);
      const graph = makeGraph(data);
      graph.run(400);

      const memberIds = memberIdsFor(size);
      const before = graph.positionsOf(memberIds);
      const body = graph.simulation.getBoundaryBody("sub:sub");
      if (!body) {
        // A one-tab subsection draws no square (computeCollectionBoundary
        // needs two points), so there is nothing to drag — asserted rather
        // than skipped, so this stops being true loudly.
        expect(size).toBe(1);
        return;
      }

      dragBoundary(graph, "sub:sub", 60, 10);
      const after = graph.positionsOf(memberIds);
      expect(worstShapeChange(before, after), "relative arrangement during the drag").toBeLessThan(1);
    });
  }

  it("never commands the box further in one frame than the pointer moved", () => {
    // The runaway. stepBoundaryBodies records the dragged body's per-frame
    // travel as its velocity, so this reads exactly what the drag asked for.
    // Pre-fix, with the members held back by the containment clamp, this
    // saturated at BOUNDARY_MAX_SPEED on both axes (36.8) every frame for the
    // rest of the gesture while the box itself advanced 7px in total.
    const graph = makeGraph(workspaceWithSubsection(60));
    graph.run(400);

    let worstCommanded = 0;
    dragBoundary(graph, "sub:sub", 60, 10, () => {
      const body = graph.simulation.getBoundaryBody("sub:sub");
      if (body) worstCommanded = Math.max(worstCommanded, Math.hypot(body.vx, body.vy));
    });
    expect(worstCommanded, "per-frame commanded travel vs 10px of pointer").toBeLessThan(14);
  });

  it("leaves the rest of the graph where it was", () => {
    // Pre-fix, one subsection drag on this fixture moved every non-member tab
    // in the graph — 62 of 62, the worst by 97px — because the runaway above
    // swept the dragged body across the whole layout and back every frame.
    const data = workspaceWithSubsection(60);
    const graph = makeGraph(data);
    graph.run(400);

    const members = new Set(memberIdsFor(60));
    const outsiders = data.tabs.map((t) => t.id).filter((id) => !members.has(id));
    const before = graph.positionsOf(outsiders);

    dragBoundary(graph, "sub:sub", 60, 10);

    const after = graph.positionsOf(outsiders);
    let worst = 0;
    for (const [id, p] of after) worst = Math.max(worst, Math.hypot(p.x - before.get(id)!.x, p.y - before.get(id)!.y));
    expect(worst, "worst non-member displacement").toBeLessThan(1);
  });

  it("keeps its tabs at readable spacing throughout", () => {
    // The "tabs become extremely close together / collide" symptom. Pre-fix
    // this fixture settled with its closest pair 10.9px INSIDE each other
    // before the drag even started.
    const graph = makeGraph(workspaceWithSubsection(60));
    graph.run(400);
    const memberIds = memberIdsFor(60);

    const gapBefore = minPairwiseGap(graph, memberIds);
    expect(gapBefore, "closest pair before the drag").toBeGreaterThan(0);

    dragBoundary(graph, "sub:sub", 60, 10);
    expect(minPairwiseGap(graph, memberIds), "closest pair after the drag").toBeGreaterThan(0);
  });

  it("moves the box a real distance, then behaves like a clamped drag at its limit", () => {
    // A subsection is clamped inside its category by design (a sub-disc may
    // not leave its parent's), so it does not travel the pointer's full 600px.
    // What it must not do is what it used to: fight the pointer in place,
    // advancing 0-7px in total while the target ran away from it.
    const graph = makeGraph(workspaceWithSubsection(60));
    graph.run(400);
    const before = graph.positionsOf(["s0"]);

    const { startX, startY } = dragBoundary(graph, "sub:sub", 60, 10);
    const atLimit = graph.positionsOf(["s0"]).get("s0")!.x;
    expect(atLimit - before.get("s0")!.x, "travel before the containment clamp bites").toBeGreaterThan(100);

    // At the limit, pushing further does nothing…
    graph.simulation.beginBoundaryDrag("sub:sub", startX, startY);
    for (let i = 1; i <= 30; i++) {
      graph.simulation.moveBoundaryDrag(startX + 600 + 10 * i, startY);
      graph.frame();
    }
    expect(Math.abs(graph.positionsOf(["s0"]).get("s0")!.x - atLimit), "further travel past the clamp").toBeLessThan(2);

    // …and pulling back moves it again immediately, rather than having to
    // first work off an accumulated pointer lead. This is the whole point of
    // reconciling the drag target with what the ground actually took.
    const body = graph.simulation.getBoundaryBody("sub:sub")!;
    const held = { x: body.x, y: body.y };
    graph.simulation.moveBoundaryDrag(held.x - 40, held.y);
    graph.frame();
    graph.simulation.endBoundaryDrag();
    expect(graph.positionsOf(["s0"]).get("s0")!.x, "responds to the pointer coming back").toBeLessThan(atLimit - 5);
  });

  it("does not rearrange anything when the box is released", () => {
    const data = workspaceWithSubsection(20);
    const graph = makeGraph(data);
    graph.run(400);
    const memberIds = memberIdsFor(20);

    dragBoundary(graph, "sub:sub", 40, 10);
    const atRelease = graph.positionsOf(memberIds);
    // The canvas gives the layout one gentle top-up on release; the boundary
    // layer's own coast is what runs here. Either way, letting go must not
    // reshuffle the group.
    graph.run(120);
    const settled = graph.positionsOf(memberIds);
    expect(worstShapeChange(atRelease, settled), "rearrangement after release").toBeLessThan(30);
  });

  it("stays coherent on a realistic 300-tab workspace", () => {
    const data = buildWorkspace(300);
    const graph = makeGraph(data);
    graph.run(600);

    let biggest: { id: string; ids: string[] } | null = null;
    for (const root of graph.tree.roots) {
      for (const child of root.children) {
        if (child.kind !== "subcategory") continue;
        if (!biggest || child.totalTabIds.length > biggest.ids.length) biggest = { id: child.id, ids: child.totalTabIds };
      }
    }
    expect(biggest).not.toBeNull();
    if (!graph.simulation.getBoundaryBody(biggest!.id)) return;

    const members = new Set(biggest!.ids);
    const outsiders = data.tabs.map((t) => t.id).filter((id) => !members.has(id));
    const before = graph.positionsOf(biggest!.ids);
    const outsidersBefore = graph.positionsOf(outsiders);

    dragBoundary(graph, biggest!.id, 60, 10);

    expect(worstShapeChange(before, graph.positionsOf(biggest!.ids))).toBeLessThan(1);
    const outsidersAfter = graph.positionsOf(outsiders);
    let movedOutsiders = 0;
    for (const [id, p] of outsidersAfter) {
      if (Math.hypot(p.x - outsidersBefore.get(id)!.x, p.y - outsidersBefore.get(id)!.y) > 1) movedOutsiders++;
    }
    expect(movedOutsiders, `non-member tabs moved (of ${outsiders.length})`).toBe(0);
  });

  it("is exactly why graph-canvas.tsx stopped re-heating mid-gesture", () => {
    // The third cause, isolated. A boundary drag translates its members
    // rigidly and the loop ticks throughout the gesture regardless of alpha,
    // so re-solving the layout underneath it buys nothing — and costs the
    // formation the drag is supposed to preserve. Run identically but for one
    // reheat() per pointermove, which is what handlePointerMove used to do.
    const data = workspaceWithSubsection(60);
    const memberIds = memberIdsFor(60);

    const cold = makeGraph(data);
    cold.run(400);
    const coldBefore = cold.positionsOf(memberIds);
    dragBoundary(cold, "sub:sub", 60, 10);
    const coldShift = worstShapeChange(coldBefore, cold.positionsOf(memberIds));

    const hot = makeGraph(data);
    hot.run(400);
    const hotBefore = hot.positionsOf(memberIds);
    const body = hot.simulation.getBoundaryBody("sub:sub")!;
    hot.simulation.beginBoundaryDrag("sub:sub", body.x, body.y);
    for (let i = 1; i <= 60; i++) {
      hot.simulation.moveBoundaryDrag(body.x + 10 * i, body.y);
      hot.simulation.reheat(0.2);
      hot.frame();
    }
    hot.simulation.endBoundaryDrag();
    const hotShift = worstShapeChange(hotBefore, hot.positionsOf(memberIds));

    expect(coldShift, "the gesture the canvas now produces keeps the group's shape").toBeLessThan(1);
    expect(hotShift, "re-solving the layout mid-drag does not").toBeGreaterThan(coldShift + 20);
  });

  it("still lets a single tab be dragged out on its own", () => {
    // The group-movement fix must not have turned members into passengers:
    // pinning one tab still moves that tab and only that tab.
    const data = workspaceWithSubsection(20);
    const graph = makeGraph(data);
    graph.run(400);

    const others = memberIdsFor(20).filter((id) => id !== "s3");
    const before = graph.positionsOf(["s3", ...others]);

    // graph-canvas.tsx's node-drag path, in its own order: exclude the tab
    // from every box's geometry, pin it to the pointer, and top the layout up
    // on each move (a pinned node's x only follows fx while d3 is running).
    graph.simulation.setBoundaryExcluded("s3");
    const startX = graph.simulation.findNode("s3")!.x!;
    const startY = graph.simulation.findNode("s3")!.y!;
    graph.simulation.reheat(0.35);
    for (let i = 1; i <= 30; i++) {
      graph.simulation.pin("s3", startX + 10 * i, startY);
      graph.simulation.reheat(0.12);
      graph.frame();
    }
    graph.simulation.unpin("s3");
    graph.simulation.setBoundaryExcluded(null);

    const after = graph.positionsOf(["s3", ...others]);
    expect(after.get("s3")!.x - before.get("s3")!.x, "the dragged tab moved").toBeGreaterThan(200);
    // Its neighbours react — the layout is hot for a node drag, deliberately —
    // but the tab under the pointer is the one that goes where it was put.
    let worstOther = 0;
    for (const id of others) {
      worstOther = Math.max(worstOther, Math.hypot(after.get(id)!.x - before.get(id)!.x, after.get(id)!.y - before.get(id)!.y));
    }
    expect(worstOther, "neighbours settle, they do not follow it").toBeLessThan(after.get("s3")!.x - before.get("s3")!.x);
  });
});
