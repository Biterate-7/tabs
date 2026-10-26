import { describe, expect, it } from "vitest";
import { buildKnowledgeGraph, projectNodeId } from "./build";
import { armPoint, galaxyExtent, worldPoint } from "./galaxy";
import { layoutKnowledgeGraph, territoryRadius } from "./layout";
import { baseLens, cameraOn, fitLens, panLens, project, unproject, zoomAtLens } from "./projection";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

const T = 1_700_000_000_000;
const viewport = { width: 1200, height: 800 };
const lens = baseLens(viewport);

function source(id: string, url: string, kind: "webpage" | "conversation" = "webpage", at = T): Tab {
  return { id, url, normalizedUrl: url, domain: new URL(url).hostname, title: id, resource: { kind, origin: "extension", status: "ready", addedAt: at, updatedAt: at, content: { chars: 10, extractedAt: at } } };
}

function workspace(id: string, count: number): Workspace {
  const tabs = Array.from({ length: count }, (_, i) => source(`${id}-${i}`, `https://${id}.example/${i}`, i % 3 === 0 ? "conversation" : "webpage", T - i * 1000));
  return { id, name: id, tabs, notes: [], createdAt: T, updatedAt: T };
}

describe("projection", () => {
  const camera = { x: 120, y: -40, k: 0.9 };

  it("finds the plane point under a projected point", () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 300, y: 200 },
      { x: -250, y: -330 },
    ]) {
      const at = project({ ...p, z: 0 }, camera, viewport, lens)!;
      const back = unproject(at, camera, viewport, lens);
      expect(back.x).toBeCloseTo(p.x, 3);
      expect(back.y).toBeCloseTo(p.y, 3);
    }
  });

  it("draws nearer things larger, and higher things higher on screen", () => {
    const far = project({ x: 120, y: -400, z: 0 }, camera, viewport, lens)!;
    const near = project({ x: 120, y: 300, z: 0 }, camera, viewport, lens)!;
    expect(near.scale).toBeGreaterThan(far.scale);
    const low = project({ x: 120, y: 0, z: 0 }, camera, viewport, lens)!;
    const high = project({ x: 120, y: 0, z: 100 }, camera, viewport, lens)!;
    expect(high.y).toBeLessThan(low.y);
  });

  it("culls what would fall behind the camera instead of flipping it", () => {
    expect(project({ x: 0, y: 1e6, z: 0 }, camera, viewport, lens)).toBeUndefined();
  });

  it("zooms about the pointer and pans the plane with it", () => {
    const pointer = { x: 900, y: 300 };
    const before = unproject(pointer, camera, viewport, lens);
    const zoomed = zoomAtLens(camera, pointer, 1.8, viewport, lens);
    const after = unproject(pointer, zoomed, viewport, lens);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    const panned = panLens(camera, { x: 600, y: 400 }, { x: 700, y: 450 }, viewport, lens);
    const moved = unproject({ x: 700, y: 450 }, panned, viewport, lens);
    const grabbed = unproject({ x: 600, y: 400 }, camera, viewport, lens);
    expect(moved.x).toBeCloseTo(grabbed.x, 3);
    expect(moved.y).toBeCloseTo(grabbed.y, 3);
  });

  it("centres a raised point exactly", () => {
    const at = project({ x: 50, y: 80, z: 120 }, cameraOn({ x: 50, y: 80, z: 120 }, 1.2, lens), viewport, lens)!;
    expect(at.x).toBeCloseTo(viewport.width / 2, 3);
    expect(at.y).toBeCloseTo(viewport.height / 2, 3);
  });

  it("fits points inside the free part of the viewport", () => {
    const points = [
      { x: -400, y: -300, z: 40 },
      { x: 500, y: 250, z: -20 },
      { x: 100, y: 600, z: 120 },
    ];
    const insets = { right: 360 };
    const fitted = fitLens(points, viewport, lens, { insets, padding: 40 });
    for (const p of points) {
      const at = project(p, fitted, viewport, lens)!;
      expect(at.x).toBeGreaterThanOrEqual(30);
      expect(at.x).toBeLessThanOrEqual(viewport.width - 360 - 30);
      expect(at.y).toBeGreaterThanOrEqual(30);
      expect(at.y).toBeLessThanOrEqual(viewport.height - 30);
    }
  });
});

describe("galaxy layout", () => {
  const graph = buildKnowledgeGraph({ workspaces: [workspace("alpha", 30), workspace("beta", 8), workspace("gamma", 1), workspace("delta", 0), workspace("epsilon", 12)] });
  const positions = layoutKnowledgeGraph(graph);
  const map = new Map(Object.entries(positions));
  const projects = graph.nodes.filter((entry) => entry.kind === "project");

  it("strings every project along one of the two arms, clear of the core", () => {
    for (const node of projects) {
      const at = positions[node.id]!;
      const r = Math.hypot(at.x, at.y);
      expect(r).toBeGreaterThan(100);
      const onArm = [0, 1].some((arm) => {
        const along = armPoint(arm, r);
        return Math.hypot(along.x - at.x, along.y - at.y) < 1;
      });
      expect(onArm).toBe(true);
    }
  });

  it("keeps clusters apart, and every item inside its own", () => {
    const reach = (id: string) => territoryRadius(graph.nodes.filter((node) => node.projectId === id.slice(2) && node.kind !== "project").length);
    for (const a of projects) {
      for (const b of projects) {
        if (a.id >= b.id) continue;
        const pa = positions[a.id]!;
        const pb = positions[b.id]!;
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThan(Math.max(reach(a.id), reach(b.id)));
      }
    }
    for (const node of graph.nodes) {
      if (node.kind === "project" || !node.projectId) continue;
      const hub = positions[projectNodeId(node.projectId)]!;
      const at = positions[node.id]!;
      expect(Math.hypot(at.x - hub.x, at.y - hub.y)).toBeLessThanOrEqual(reach(projectNodeId(node.projectId)));
    }
  });

  it("starts an arm, next to the core, with the largest project", () => {
    const distance = (id: string) => Math.hypot(positions[id]!.x, positions[id]!.y);
    const nearer = projects.filter((node) => distance(node.id) < distance(projectNodeId("alpha")));
    // Only the first cluster on the other arm can sit closer in.
    expect(nearer.length).toBeLessThanOrEqual(1);
  });

  it("gives the same depth to the same records every time, in a thin disc", () => {
    const again = new Map(Object.entries(layoutKnowledgeGraph(graph)));
    for (const node of graph.nodes) {
      expect(worldPoint(node, again)).toEqual(worldPoint(node, map));
      expect(Math.abs(worldPoint(node, map)!.z)).toBeLessThan(60);
    }
  });

  it("reaches past everything laid out", () => {
    const extent = galaxyExtent(Object.values(positions));
    for (const at of Object.values(positions)) expect(Math.hypot(at.x, at.y)).toBeLessThan(extent);
  });
});
