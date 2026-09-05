import { describe, expect, it } from "vitest";
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "./relations";
import { buildClusterTree, computeClusterAnchors, type ClusterNode } from "./clusters";
import { createGraphSimulation } from "./engine";
import { computeNodeRadius } from "./node-size";
import { computeFitCamera, worldToScreen } from "./layout";
import {
  boundaryDrawPriority,
  boundaryPurity,
  CATEGORY_BOUNDARY_PADDING,
  computeCollectionBoundary,
  measureBoundaryOccupancy,
  occupancyDelimitsMembers,
  rectContains,
  rectsOverlap,
  selectNonOverlappingRects,
  SUBCATEGORY_BOUNDARY_PADDING,
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

/**
 * A second, more realistic dataset shape: MANY flat, single-domain root
 * categories rather than `buildWorkspace`'s fixed 10. This is what a real
 * dense workspace actually produces — sections/ai/pipeline.ts's collective
 * clustering promotes any confident domain cluster (>=2 tabs) straight to
 * its own root category, with no cap — so a 500+ tab dump easily produces
 * 20-50 categories (one per AI tool/site the user visited), not 10 broad
 * buckets. `buildWorkspace`'s fixed 10 categories never stressed category
 * *count*, only tab count, which is why the crossing/ballooning fixes
 * verified against it didn't catch the failure this file's newer describe
 * block guards: at realistic category counts, almost every legitimate
 * candidate boundary gets suppressed as an "overlap," not because the data
 * is poorly separated (confirmed at `separable: false` below too) but
 * because dozens of ring-adjacent AABBs mutually overlap near the ring's
 * center as a geometry artifact, independent of separation quality.
 */
function buildFineGrainedWorkspace(total: number, categoryCount: number) {
  const now = 1_700_000_000_000;
  const random = makeRandom(54321);
  const sections: Section[] = [];
  const categoryIds: string[] = [];
  const names = [
    "Perplexity", "Higgsfield", "Projects", "Claude", "ChatGPT", "Midjourney", "Runway",
    "ElevenLabs", "Suno", "GitHub", "Figma", "Notion", "Linear", "Vercel", "YouTube", "Reddit",
    "Twitter", "Discord", "Gmail", "Docs", "Sheets", "Amazon", "Stripe", "Cursor", "Replit",
    "HuggingFace", "OpenAI", "Anthropic", "Gemini", "Grok", "Leonardo", "Kling", "Pika", "Ideogram",
    "Perchance", "CapCut", "Canva", "Framer", "Webflow", "Zapier", "n8n", "Airtable", "Slack",
    "Miro", "Loom", "Descript", "Krea", "Freepik", "Civitai", "Substack",
  ];
  for (let i = 0; i < categoryCount; i++) {
    const id = `sec-cat-${i}`;
    const name = names[i % names.length] + (i >= names.length ? `${Math.floor(i / names.length)}` : "");
    sections.push({ id, parentId: null, name, source: "ai", createdAt: now, updatedAt: now });
    categoryIds.push(id);
  }

  // Each category gets its own domain — the well-clustered case, matching
  // `buildWorkspace`'s `separable: true`. Even here, real per-category boxes
  // still overlap each other purely from ring-adjacency (see doc comment
  // above), so this is the harder case to defend, not an easier one.
  const domains = names.map((n) => `${n.toLowerCase()}.com`);
  const tabs: Tab[] = [];
  for (let i = 0; i < total; i++) {
    const categoryIndex = i % categoryCount;
    const domain = domains[categoryIndex % domains.length];
    tabs.push({
      id: `tab-${i}`,
      url: `https://${domain}/page/${i}`,
      normalizedUrl: `https://${domain}/page/${i}`,
      domain,
      title: `item ${i}`,
      category: "other",
      sectionId: categoryIds[categoryIndex],
    });
  }

  const collections: Collection[] = [];
  for (let c = 0; c < Math.max(2, Math.round(total / 40)); c++) {
    const size = 4 + Math.floor(random() * 12);
    const base = Math.floor(random() * total);
    const ids: string[] = [];
    for (let k = 0; k < size; k++) ids.push(`tab-${(base + k * 7) % total}`);
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

type WorkspaceData = ReturnType<typeof buildWorkspace>;

/** Mirrors graph-canvas.tsx's draw(): settle the layout, fit the camera, then build the frame's boundary draw list. Shared by every dataset builder in this file so a fixture change can't accidentally diverge from the real draw() path in only one of them. */
function runBoundaryPipeline(data: WorkspaceData, selectedId: string | null) {
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

  // Mirrors draw()'s single measure-once pass: the same occupancy feeds both
  // the concentration gate and the draw-priority ranking.
  const occupancyById = new Map(
    candidates.map((c) => [
      c.id,
      measureBoundaryOccupancy(c.rect, new Set(clusterNodeFor(c.id)?.totalTabIds ?? []), occupants),
    ])
  );
  const priorityOf = (id: string) =>
    boundaryDrawPriority(occupancyById.get(id)!, clusterNodeFor(id)?.weight ?? 0);
  const purityOf = (id: string) => boundaryPurity(occupancyById.get(id)!);

  const gated = candidates.filter(
    (candidate) =>
      selectedId === candidate.id ||
      occupancyDelimitsMembers(occupancyById.get(candidate.id)!, occupants.length)
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
    (a, b) => priorityOf(b.id) - priorityOf(a.id) || a.id.localeCompare(b.id)
  );
  const drawableIds = selectNonOverlappingRects(
    ordered.map((c) => ({ id: c.id, rect: c.rect })),
    selectedId === null ? null : new Set([selectedId]),
    isNestedPair
  );

  return {
    nodeCount: nodes.length,
    candidates,
    gated,
    drawn: ordered.filter((c) => drawableIds.has(c.id)),
    isNestedPair,
    purityOf,
    priorityOf,
    weightOf: (id: string) => clusterNodeFor(id)?.weight ?? 0,
  };
}

function boundaryDrawList(total: number, separable: boolean, selectedId: string | null = null) {
  return runBoundaryPipeline(buildWorkspace(total, separable), selectedId);
}

function fineGrainedBoundaryDrawList(total: number, categoryCount: number, selectedId: string | null = null) {
  return runBoundaryPipeline(buildFineGrainedWorkspace(total, categoryCount), selectedId);
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

/**
 * End-to-end guard for the follow-up failure found while investigating a
 * live "570 tabs, still shows a mess of boundary boxes" report: the
 * crossing/ballooning fixes above hold (verified again below), but at
 * realistic category *counts* — not just tab counts — overlap suppression
 * alone silently keeps only a handful of dozens of legitimate,
 * concentration-passing candidates, because the ring layout packs that many
 * candidate boxes into mutually-overlapping territory near its center
 * regardless of how well-separated the underlying data is. The fix that
 * actually held was ordering (boundaryDrawPriority) plus, ultimately, the
 * packed2d layout that gives every category its own disjoint territory — not
 * the count cap that was briefly tried here. This suite is the one that would
 * have caught it:
 * dense-boundaries.test.ts's original describe block never varies category
 * *count* (buildWorkspace always uses the same fixed 10), only tab count.
 */
describe("boundary rendering with realistic (many, fine-grained) categories", () => {
  for (const categoryCount of [20, 35, 50]) {
    describe(`570 tabs, ${categoryCount} single-domain categories`, () => {
      const frame = fineGrainedBoundaryDrawList(570, categoryCount);

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

      it("draws no boundary that has ballooned across the graph", () => {
        const oversized = frame.drawn
          .filter((b) => (b.rect.width * b.rect.height) / (VIEWPORT_W * VIEWPORT_H) > MAX_BOUNDARY_VIEWPORT_SHARE)
          .map(describeRect);
        expect(oversized, `boundaries covering the whole graph:\n${oversized.join("\n")}`).toEqual([]);
      });

      // What bounds the ambient set is overlap suppression, not a count:
      // whatever survives here must not visibly cross anything (asserted
      // above) and must not have ballooned (asserted above). There used to
      // be a MAX_AMBIENT_BOUNDARIES ceiling asserted here too; it was
      // removed once the packed2d layout made every category's box small and
      // disjoint, at which point a count cap only hid clean boxes — see
      // collection-layout.ts. This scenario's own numbers said as much all
      // along: measured here, the frame drew the same handful with or
      // without the cap, because overlap suppression was always the binding
      // constraint. What overlap suppression keeps depends entirely on the
      // ORDER it sees — see "priority ordering recovers boundaries weight
      // ordering erased" below.
    });
  }

  // Selecting a category the ambient pass excluded must still show it —
  // suppression is about ambient clutter, not about what a deliberate click
  // can bring on screen.
  it("still draws an explicitly selected boundary the ambient pass would otherwise exclude", () => {
    const unselected = fineGrainedBoundaryDrawList(570, 50);
    const excluded = unselected.candidates.find((c) => !unselected.drawn.some((d) => d.id === c.id));
    expect(excluded, "expected the ambient pass to exclude at least one candidate").toBeDefined();

    const selected = fineGrainedBoundaryDrawList(570, 50, excluded!.id);
    expect(selected.drawn.map((d) => d.id)).toContain(excluded!.id);
  });
});

/**
 * The dataset shape that actually produced the reported screenshot, and that
 * neither builder above covers: a few dominant categories plus a long tail of
 * small ones. `buildWorkspace` splits tabs evenly across a fixed 10 and
 * `buildFineGrainedWorkspace` splits them evenly across N, so in both every
 * category ends up roughly the same size — and the failure needs the opposite.
 * Weight-descending suppression only misbehaves badly when one candidate is
 * far heavier than the rest: that box goes first, sprawls across the centre of
 * the ring, and erases the compact neighbours behind it. With uniform sizes
 * there is no runaway first pick, which is why the even-split fixtures stayed
 * green while a real workspace (one huge "Perplexity", a tail of 2-10 tab
 * per-domain categories) showed a handful of big faint rectangles and nothing
 * else.
 */
function buildSkewedWorkspace(total: number, categoryCount: number) {
  const now = 1_700_000_000_000;
  const random = makeRandom(24680);
  const names = [
    "Perplexity", "Claude", "School", "Free", "Greenwood", "Reddit", "Google Docs", "DaFont",
    "Vercel Tabs", "9Mod", "Projects", "ChatGPT", "YouTube", "GitHub", "Figma", "Notion",
    "Gmail", "Amazon", "Discord", "Canva", "Spotify", "Twitch", "Steam", "Roblox", "Pinterest",
    "Quizlet", "Desmos", "Scratch", "Khan", "Wikipedia",
  ];
  const sections: Section[] = [];
  const categoryIds: string[] = [];
  for (let i = 0; i < categoryCount; i++) {
    const id = `sec-cat-${i}`;
    sections.push({ id, parentId: null, name: names[i % names.length], source: "ai", createdAt: now, updatedAt: now });
    categoryIds.push(id);
  }
  // Zipf-ish sizes: category i gets ~1/(i+1) of the mass, so the largest is an
  // order of magnitude bigger than the tail — the real "collective clustering"
  // output shape (see sections/ai/pipeline.ts).
  const shares = categoryIds.map((_, i) => 1 / (i + 1));
  const shareTotal = shares.reduce((a, b) => a + b, 0);
  const counts = shares.map((s) => Math.max(2, Math.round((s / shareTotal) * total)));

  const tabs: Tab[] = [];
  let n = 0;
  counts.forEach((count, categoryIndex) => {
    const domain = `${names[categoryIndex % names.length].toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
    for (let k = 0; k < count && n < total; k++, n++) {
      tabs.push({
        id: `tab-${n}`,
        url: `https://${domain}/page/${n}`,
        normalizedUrl: `https://${domain}/page/${n}`,
        domain,
        title: `item ${n}`,
        category: "other",
        sectionId: categoryIds[categoryIndex],
      });
    }
  });

  const collections: Collection[] = [];
  for (let c = 0; c < Math.max(2, Math.round(tabs.length / 60)); c++) {
    const ids: string[] = [];
    const base = Math.floor(random() * tabs.length);
    for (let k = 0; k < 6; k++) ids.push(tabs[(base + k * 5) % tabs.length].id);
    collections.push({
      id: `col-${c}`,
      workspaceId: "ws",
      name: `Collection ${c}`,
      tabIds: [...new Set(ids)],
      createdAt: now,
      updatedAt: now,
    });
  }

  const workspace: Workspace = { id: "ws", name: "Skewed", tabs, sections, createdAt: now, updatedAt: now };
  return { tabs, sections, collections, workspaces: [workspace] };
}

function skewedBoundaryDrawList(total: number, categoryCount: number, selectedId: string | null = null) {
  return runBoundaryPipeline(buildSkewedWorkspace(total, categoryCount), selectedId);
}

/**
 * The reported failure, stated as properties rather than as a screenshot: on a
 * dense workspace with skewed category sizes the graph showed a few large
 * faint rectangles draped over unrelated nodes while most legitimate
 * categories had no boundary at all.
 */
describe("boundary rendering on a realistically skewed dense workspace", () => {
  for (const [total, categoryCount] of [
    [281, 25],
    [281, 12],
    [500, 30],
    [570, 40],
    [750, 30],
  ] as [number, number][]) {
    describe(`${total} tabs, ${categoryCount} skewed categories`, () => {
      const frame = skewedBoundaryDrawList(total, categoryCount);

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

      it("draws no boundary that has ballooned across the graph", () => {
        const oversized = frame.drawn
          .filter((b) => (b.rect.width * b.rect.height) / (VIEWPORT_W * VIEWPORT_H) > MAX_BOUNDARY_VIEWPORT_SHARE)
          .map(describeRect);
        expect(oversized, `boundaries covering the whole graph:\n${oversized.join("\n")}`).toEqual([]);
      });

      // The feature must not silently switch itself off: plenty of clusters
      // clear the concentration gate, and the frame has to keep showing the
      // reader some of them. Deliberately a floor, not a target — see
      // boundaryDrawPriority for why ~6 boxes out of 30-50 eligible ones is
      // what non-overlapping axis-aligned packing allows at these densities.
      it("keeps drawing boundaries rather than suppressing the feature away", () => {
        expect(frame.gated.length).toBeGreaterThan(10);
        expect(
          frame.drawn.length,
          `only ${frame.drawn.length} of ${frame.gated.length} eligible boundaries survived`
        ).toBeGreaterThanOrEqual(2);
      });

      // The reported symptom, stated as the shape that actually reads as
      // broken: a box big enough to dominate the picture whose contents are
      // overwhelmingly somebody else's nodes. A SMALL box with low purity is
      // a known, accepted consequence of boundaryDelimitsMembers being a
      // relative test (a 5-tab cluster in a 570-tab graph can never reach
      // high absolute purity, and demanding it would delete every small
      // category — the over-suppression this file's other tests guard).
      // Harm scales with area, so the assertion does too.
      it("draws no large boundary whose contents are mostly foreign nodes", () => {
        const misleading = frame.drawn
          .filter(
            (b) =>
              (b.rect.width * b.rect.height) / (VIEWPORT_W * VIEWPORT_H) > 0.1 && frame.purityOf(b.id) < 0.3
          )
          .map((b) => `${describeRect(b)} purity=${frame.purityOf(b.id).toFixed(2)}`);
        expect(misleading, `large boundaries enclosing mostly unrelated nodes:\n${misleading.join("\n")}`).toEqual(
          []
        );
      });

      it("draws each boundary once, in priority order", () => {
        const ids = frame.drawn.map((b) => b.id);
        expect(ids).toEqual([...new Set(ids)]);
        const expected = [...frame.gated]
          .sort((a, b) => frame.priorityOf(b.id) - frame.priorityOf(a.id) || a.id.localeCompare(b.id))
          .filter((c) => ids.includes(c.id))
          .map((c) => c.id);
        expect(ids).toEqual(expected);
      });
    });
  }

  /**
   * The direct A/B for the fix, and the test that would have failed before
   * it. Same settled layout, same geometry, same gate, same cap — the ONLY
   * difference is the order handed to selectNonOverlappingRects.
   *
   * The claim under test is specifically about boundary QUALITY, not count:
   * measured over 35 layouts of this fixture family, reordering lifts the
   * mean purity of the drawn set from 0.40 to 0.46 while leaving the drawn
   * count flat at 6.23. Asserted in aggregate rather than per scenario
   * because the physics seeds new nodes with Math.random(), so any single
   * settled layout is noisy (purity came out worse in 2 of those 35 runs,
   * and the count lower in 3, never by more than one box).
   */
  it("priority ordering draws more honest boundaries than weight ordering", () => {
    let priorityDrawn = 0;
    let weightDrawn = 0;
    let priorityPurity = 0;
    let weightPurity = 0;
    let samples = 0;

    for (const [total, categoryCount] of [
      [281, 25],
      [281, 12],
      [500, 30],
      [570, 40],
      [750, 30],
    ] as [number, number][]) {
      const frame = skewedBoundaryDrawList(total, categoryCount);

      const byWeight = selectNonOverlappingRects(
        [...frame.gated]
          .sort((a, b) => frame.weightOf(b.id) - frame.weightOf(a.id) || a.id.localeCompare(b.id))
          .map((c) => ({ id: c.id, rect: c.rect })),
        null,
        frame.isNestedPair
      );

      const meanPurity = (ids: string[]) =>
        ids.length === 0 ? 0 : ids.reduce((sum, id) => sum + frame.purityOf(id), 0) / ids.length;

      priorityDrawn += frame.drawn.length;
      weightDrawn += byWeight.size;
      priorityPurity += meanPurity(frame.drawn.map((b) => b.id));
      weightPurity += meanPurity([...byWeight]);
      samples++;

      // Reordering trades a box only at the margin: it must never cost the
      // frame a meaningful number of boundaries to buy that quality.
      expect(
        frame.drawn.length,
        `${total}t/${categoryCount}c: priority drew ${frame.drawn.length}, weight drew ${byWeight.size}`
      ).toBeGreaterThanOrEqual(byWeight.size - 1);
    }

    expect(priorityPurity / samples).toBeGreaterThan(weightPurity / samples);
    expect(priorityDrawn / samples).toBeGreaterThanOrEqual(weightDrawn / samples - 0.5);
  });

  // Selection must still win over both the gate and the cap, and must not
  // resurrect a box by trampling bystanders it visibly crosses.
  it("still draws an explicitly selected boundary the ambient pass excluded, without crossing anything", () => {
    const unselected = skewedBoundaryDrawList(281, 25);
    const excluded = unselected.candidates.find((c) => !unselected.drawn.some((d) => d.id === c.id));
    expect(excluded, "expected the ambient pass to exclude at least one candidate").toBeDefined();

    const selected = skewedBoundaryDrawList(281, 25, excluded!.id);
    expect(selected.drawn.map((d) => d.id)).toContain(excluded!.id);

    const crossings: string[] = [];
    for (let i = 0; i < selected.drawn.length; i++) {
      for (let j = i + 1; j < selected.drawn.length; j++) {
        const a = selected.drawn[i];
        const b = selected.drawn[j];
        if (rectsOverlap(a.rect, b.rect) && !selected.isNestedPair(a.id, b.id)) {
          crossings.push(`${describeRect(a)} X ${describeRect(b)}`);
        }
      }
    }
    expect(crossings, `selection introduced crossings:\n${crossings.join("\n")}`).toEqual([]);
  });

  // A Collection is ambient like any other tier — it competes in the same
  // single suppression pass and cannot claim territory that visibly crosses
  // another tier's box by being a different kind of cluster.
  it("does not let collections bypass ambient overlap suppression", () => {
    const frame = skewedBoundaryDrawList(570, 40);
    expect(frame.candidates.some((c) => c.kind === "collection")).toBe(true);
    for (let i = 0; i < frame.drawn.length; i++) {
      for (let j = i + 1; j < frame.drawn.length; j++) {
        const a = frame.drawn[i];
        const b = frame.drawn[j];
        if (a.kind !== "collection" && b.kind !== "collection") continue;
        expect(
          rectsOverlap(a.rect, b.rect) && !frame.isNestedPair(a.id, b.id),
          `${describeRect(a)} X ${describeRect(b)}`
        ).toBe(false);
      }
    }
  });

  // Nesting must remain a geometric fact, not a hierarchy claim: any pair
  // exempted from suppression has to actually contain one another.
  it("only exempts parent/child pairs that geometrically contain each other", () => {
    for (const [total, categoryCount] of [
      [281, 25],
      [570, 40],
    ] as [number, number][]) {
      const frame = skewedBoundaryDrawList(total, categoryCount);
      for (let i = 0; i < frame.drawn.length; i++) {
        for (let j = i + 1; j < frame.drawn.length; j++) {
          const a = frame.drawn[i];
          const b = frame.drawn[j];
          if (!frame.isNestedPair(a.id, b.id)) continue;
          expect(
            rectContains(a.rect, b.rect) || rectContains(b.rect, a.rect),
            `${describeRect(a)} and ${describeRect(b)} were exempted without containment`
          ).toBe(true);
        }
      }
    }
  });
});
