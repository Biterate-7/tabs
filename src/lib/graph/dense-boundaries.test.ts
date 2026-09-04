import { describe, expect, it } from "vitest";
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "./relations";
import { buildClusterTree, computeClusterAnchors, type ClusterNode } from "./clusters";
import { createGraphSimulation } from "./engine";
import { computeNodeRadius } from "./node-size";
import { computeFitCamera, worldToScreen } from "./layout";
import {
  boundaryDelimitsMembers,
  computeCollectionBoundary,
  rectContains,
  rectsOverlap,
  selectNonOverlappingRects,
  type BoundaryOccupant,
  type CollectionBoundaryRect,
} from "./collection-layout";
import { DEFAULT_CONNECTION_FILTERS } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Collection } from "@/lib/collections/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * End-to-end guard for the "dump 500+ tabs and the graph fills up with big
 * faint overlapping rectangles" failure.
 *
 * The unit tests in collection-layout.test.ts pin each piece of the
 * boundary maths against hand-built rects. They could not catch this bug,
 * and still couldn't: every one of those invariants held while the bug was
 * on screen. The failure only exists once a real, settled, several-hundred
 * node layout decides where the nodes actually are — that is what turns a
 * cluster's bounding box from a tight region into a box around the whole
 * graph. So this file runs the real pipeline (relations -> cluster tree ->
 * d3-force simulation -> fit camera -> boundary rects) and asserts on what
 * a frame would actually paint.
 *
 * Kept deliberately close to graph-canvas.tsx's draw(): if the two drift,
 * this stops testing the thing that broke.
 */

const CATEGORY_BOUNDARY_PADDING = 40;
const SUBCATEGORY_BOUNDARY_PADDING = 28;
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

/**
 * Ceiling on how much of the viewport one boundary may cover. Not a
 * constant the renderer enforces — an independent check that no box has
 * gone back to being a rectangle draped over the whole graph. The reported
 * failure drew boxes at 0.36 and 0.19 of the viewport; healthy boundaries
 * measured 0.01-0.15.
 */
const MAX_BOUNDARY_VIEWPORT_SHARE = 0.25;

const CATEGORIES: [string, string[]][] = [
  ["Claude", ["Prompts", "Agents", "Docs", "Skills"]],
  ["9Mod", ["Builds", "Textures", "Forums"]],
  ["Projects", ["TabDump", "Portfolio", "Scratch", "Archive"]],
  ["YouTube", ["Music", "Tutorials", "Gaming"]],
  ["AI Tools", ["LLMs", "Image Gen", "Research"]],
  ["Dev", ["Frontend", "Backend", "DevOps"]],
  ["Docs", ["MDN", "React", "Next"]],
  ["Shopping", ["Electronics", "Books"]],
  ["News", ["Tech", "World"]],
  ["Social", ["X", "Reddit", "Discord"]],
];

const DOMAINS = [
  "claude.ai", "github.com", "youtube.com", "reddit.com", "news.ycombinator.com",
  "developer.mozilla.org", "react.dev", "nextjs.org", "amazon.com", "x.com",
  "discord.com", "stackoverflow.com", "medium.com", "arxiv.org", "figma.com",
];

/** Seeded so a failure is always the same failure — a physics layout reported as flaky is worse than no test. */
function makeRandom(seed: number) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * `separable: false` scatters domains across categories, so the domain
 * edges stitch every category to every other one and the clusters end up
 * maximally interleaved — the worst case, and the one that produced the
 * reported screenshot. `true` gives each category its own domain, the
 * well-clustered case, where real boundaries should survive.
 */
function buildWorkspace(total: number, separable: boolean) {
  const now = 1_700_000_000_000;
  const random = makeRandom(12345);
  const sections: Section[] = [];
  const categoryIds: string[] = [];
  const subcategoriesByCategory: Record<string, string[]> = {};

  CATEGORIES.forEach(([name, subs], i) => {
    const id = `sec-cat-${i}`;
    sections.push({ id, parentId: null, name, source: "ai", createdAt: now, updatedAt: now });
    categoryIds.push(id);
    subcategoriesByCategory[id] = [];
    subs.forEach((subName, j) => {
      const subId = `sec-sub-${i}-${j}`;
      sections.push({ id: subId, parentId: id, name: subName, source: "ai", createdAt: now, updatedAt: now });
      subcategoriesByCategory[id].push(subId);
    });
  });

  const tabs: Tab[] = [];
  for (let i = 0; i < total; i++) {
    const categoryIndex = i % CATEGORIES.length;
    const categoryId = categoryIds[categoryIndex];
    const subs = subcategoriesByCategory[categoryId];
    const sectionId = random() < 0.72 ? subs[Math.floor(random() * subs.length)] : categoryId;
    const domain = separable
      ? DOMAINS[categoryIndex % DOMAINS.length]
      : DOMAINS[Math.floor(random() * DOMAINS.length)];
    tabs.push({
      id: `tab-${i}`,
      url: `https://${domain}/page/${i}`,
      normalizedUrl: `https://${domain}/page/${i}`,
      domain,
      title: `${CATEGORIES[categoryIndex][0]} item ${i}`,
      category: "other",
      sectionId,
    });
  }

  const collections: Collection[] = [];
  for (let c = 0; c < Math.max(2, Math.round(total / 40)); c++) {
    const size = 4 + Math.floor(random() * 12);
    const base = Math.floor(random() * total);
    const ids: string[] = [];
    for (let k = 0; k < size; k++) {
      // Collections deliberately cut across categories in the interleaved
      // case and follow one in the separable case, matching how the two
      // datasets differ everywhere else.
      ids.push(`tab-${separable ? (base + k * CATEGORIES.length) % total : Math.floor(random() * total)}`);
    }
    collections.push({
      id: `col-${c}`,
      workspaceId: "ws",
      name: `Collection ${c}`,
      tabIds: [...new Set(ids)],
      createdAt: now,
      updatedAt: now,
    });
  }

  const workspace: Workspace = { id: "ws", name: "Dense", tabs, sections, createdAt: now, updatedAt: now };
  return { tabs, sections, collections, workspaces: [workspace] };
}

type DrawnBoundary = {
  id: string;
  kind: "category" | "subcategory" | "collection";
  label: string;
  rect: CollectionBoundaryRect;
};

/** Mirrors graph-canvas.tsx's draw(): settle the layout, fit the camera, then build the frame's boundary draw list. */
function boundaryDrawList(total: number, separable: boolean, selectedId: string | null = null) {
  const data = buildWorkspace(total, separable);
  const lookup = buildWorkspaceLookup(data.workspaces);
  const nodes = buildGraphNodes(data.tabs, lookup);
  const edges = buildGraphEdges(data.tabs, lookup, DEFAULT_CONNECTION_FILTERS, [], data.sections);
  const tree = buildClusterTree(data.tabs, data.sections, data.collections);
  const anchors = computeClusterAnchors(tree);

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const simulation = createGraphSimulation();
  simulation.setNodes(
    nodes,
    (node) => computeNodeRadius("connections", degree.get(node.id) ?? 0, undefined),
    {},
    (node) => {
      const anchor = anchors.get(node.id);
      return anchor?.subcategoryAnchor ?? anchor?.categoryAnchor ?? undefined;
    }
  );
  simulation.setEdges(edges, 1);
  simulation.setCollections(data.collections);
  simulation.setClusterAnchors(anchors);
  simulation.reheat(1);
  for (let i = 0; i < 4000 && !simulation.isSettled(); i++) simulation.tick();

  const world = nodes.map((node) => {
    const physicsNode = simulation.findNode(node.id)!;
    return { id: node.id, x: physicsNode.x!, y: physicsNode.y!, radius: physicsNode.radius };
  });
  const camera = computeFitCamera(world, VIEWPORT_W, VIEWPORT_H);
  const screen = new Map(
    world.map((point) => {
      const projected = worldToScreen(camera, point, VIEWPORT_W, VIEWPORT_H);
      return [point.id, { x: projected.x, y: projected.y, radius: point.radius * camera.zoom }] as const;
    })
  );
  const occupants: BoundaryOccupant[] = [...screen].map(([id, p]) => ({ id, x: p.x, y: p.y }));
  const pointsOf = (tabIds: string[]) =>
    tabIds
      .map((id) => screen.get(id))
      .filter((p): p is { x: number; y: number; radius: number } => Boolean(p));

  const candidates: DrawnBoundary[] = [];
  for (const category of tree.roots) {
    const points = pointsOf(category.totalTabIds);
    if (points.length <= 1) continue;
    const rect = computeCollectionBoundary(points, CATEGORY_BOUNDARY_PADDING);
    if (rect) candidates.push({ id: category.id, kind: "category", label: category.label, rect });
  }
  for (const category of tree.roots) {
    for (const sub of category.children) {
      if (sub.kind !== "subcategory") continue;
      const points = pointsOf(sub.totalTabIds);
      if (points.length <= 1) continue;
      const rect = computeCollectionBoundary(points, SUBCATEGORY_BOUNDARY_PADDING);
      if (rect) candidates.push({ id: sub.id, kind: "subcategory", label: sub.label, rect });
    }
  }
  const kindById = new Map(candidates.map((c) => [c.id, c.kind]));
  for (const collection of data.collections) {
    const points = pointsOf(collection.tabIds);
    if (points.length <= 1) continue;
    const rect = computeCollectionBoundary(points);
    if (!rect) continue;
    candidates.push({ id: collection.id, kind: "collection", label: collection.name, rect });
    kindById.set(collection.id, "collection");
  }

  const clusterNodeFor = (id: string): ClusterNode | undefined =>
    tree.byId.get(kindById.get(id) === "collection" ? `col:${id}` : id);

  const gated = candidates.filter(
    (candidate) =>
      selectedId === candidate.id ||
      boundaryDelimitsMembers(candidate.rect, new Set(clusterNodeFor(candidate.id)?.totalTabIds ?? []), occupants)
  );
  const rectById = new Map(gated.map((c) => [c.id, c.rect]));
  const isNestedPair = (a: string, b: string) => {
    const nodeA = clusterNodeFor(a);
    const nodeB = clusterNodeFor(b);
    if (!nodeA || !nodeB) return false;
    if (nodeA.parentId !== b && nodeB.parentId !== a) return false;
    const rectA = rectById.get(a);
    const rectB = rectById.get(b);
    if (!rectA || !rectB) return false;
    return rectContains(rectA, rectB) || rectContains(rectB, rectA);
  };

  const ordered = [...gated].sort(
    (a, b) =>
      (clusterNodeFor(b.id)?.weight ?? 0) - (clusterNodeFor(a.id)?.weight ?? 0) || a.id.localeCompare(b.id)
  );
  const drawableIds = selectNonOverlappingRects(
    ordered.map((c) => ({ id: c.id, rect: c.rect })),
    selectedId === null ? null : new Set([selectedId]),
    isNestedPair
  );

  return {
    nodeCount: nodes.length,
    candidates,
    drawn: ordered.filter((c) => drawableIds.has(c.id)),
    isNestedPair,
  };
}

function describeRect(boundary: DrawnBoundary): string {
  const share = (boundary.rect.width * boundary.rect.height) / (VIEWPORT_W * VIEWPORT_H);
  return `${boundary.kind}:${boundary.label} ${Math.round(boundary.rect.width)}x${Math.round(boundary.rect.height)} (${share.toFixed(2)} of viewport)`;
}

describe("boundary rendering on a dense graph", () => {
  // 520 is the reported case; the others bracket it so a regression that
  // only shows up at one density can't slip through.
  for (const total of [250, 520, 750]) {
    describe(`${total} tabs, interleaved clusters`, () => {
      const frame = boundaryDrawList(total, false);

      it("draws no two boundaries that visibly cross each other", () => {
        const crossings: string[] = [];
        for (let i = 0; i < frame.drawn.length; i++) {
          for (let j = i + 1; j < frame.drawn.length; j++) {
            const a = frame.drawn[i];
            const b = frame.drawn[j];
            if (rectsOverlap(a.rect, b.rect) && !frame.isNestedPair(a.id, b.id)) {
              crossings.push(`${describeRect(a)} X ${describeRect(b)}`);
            }
          }
        }
        expect(crossings, `boundaries crossing each other:\n${crossings.join("\n")}`).toEqual([]);
      });

      // The heart of the reported bug: the surviving boxes were viewport
      // sized. Before the fix this measured 0.36 and 0.19 of the viewport
      // at 520 tabs.
      it("draws no boundary that has ballooned across the graph", () => {
        const oversized = frame.drawn
          .filter((b) => (b.rect.width * b.rect.height) / (VIEWPORT_W * VIEWPORT_H) > MAX_BOUNDARY_VIEWPORT_SHARE)
          .map(describeRect);
        expect(oversized, `boundaries covering the whole graph:\n${oversized.join("\n")}`).toEqual([]);
      });

      // Guards the fix from the other side: suppressing everything would
      // pass both assertions above while quietly deleting the feature.
      it("still considers every cluster as a candidate", () => {
        expect(frame.candidates.length).toBeGreaterThan(20);
        expect(frame.nodeCount).toBe(total);
      });
    });
  }

  // Dropping a degenerate box must not extend to one the user explicitly
  // asked to see: clicking a cluster has to show its region even at a
  // density where nothing would be drawn on its own.
  it("still draws an explicitly selected boundary that the gate would otherwise drop", () => {
    const unselected = boundaryDrawList(520, false);
    const dropped = unselected.candidates.find((c) => !unselected.drawn.some((d) => d.id === c.id));
    expect(dropped, "expected the dense frame to drop at least one boundary").toBeDefined();

    const selected = boundaryDrawList(520, false, dropped!.id);
    expect(selected.drawn.map((d) => d.id)).toContain(dropped!.id);
  });

  // Same densities, but with clusters that genuinely occupy distinct
  // regions. Here the boundaries are informative and must keep rendering —
  // the fix must drop degenerate boxes, not boundaries in general.
  for (const total of [250, 520, 750]) {
    it(`keeps drawing boundaries at ${total} tabs when clusters are well separated`, () => {
      const frame = boundaryDrawList(total, true);
      expect(frame.drawn.length).toBeGreaterThan(0);
      for (const boundary of frame.drawn) {
        const share = (boundary.rect.width * boundary.rect.height) / (VIEWPORT_W * VIEWPORT_H);
        expect(share, describeRect(boundary)).toBeLessThanOrEqual(MAX_BOUNDARY_VIEWPORT_SHARE);
      }
    });
  }
});
