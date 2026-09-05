/**
 * Verification for the "packed2d" category layout (see cluster-regions.ts),
 * measured on the canonical real workspace export (tabdump-export.json:
 * 283 tabs, 34 categories, 7 subcategories, distribution 43/42/30/28/14/12/11/...
 * with 17 of 34 categories holding <=3 tabs).
 *
 * Unlike the throwaway audit harnesses, this drives the REAL production
 * pipeline — the actual computeClusterAnchors and createGraphSimulation that
 * ship — and toggles only CLUSTER_LAYOUT_MODE between runs, so the numbers
 * describe shipped behaviour rather than a replica of it.
 *
 * The boundary renderer is FROZEN and only read from here:
 * computeCollectionBoundary / measureBoundaryOccupancy / boundaryPurity /
 * occupancyDelimitsMembers / rectsOverlap and the
 * padding constants are used exactly as graph-canvas.tsx uses them.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "./relations";
import { buildClusterTree, type ClusterNode } from "./clusters";
import { computeNodeRadius } from "./node-size";
import { computeFitCamera, worldToScreen } from "./layout";
import {
  boundaryPurity,
  CATEGORY_BOUNDARY_PADDING,
  computeCollectionBoundary,
  measureBoundaryOccupancy,
  occupancyDelimitsMembers,
  rectContains,
  rectsOverlap,
  SUBCATEGORY_BOUNDARY_PADDING,
  type BoundaryOccupant,
  type CollectionBoundaryRect,
} from "./collection-layout";
import { DEFAULT_CONNECTION_FILTERS } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace } from "@/lib/workspace/types";

const EXPORT_PATH = join(process.cwd(), "tabdump-export.json");
const OUT_DIR = join(process.cwd(), ".layout-audit");
const VIEWPORT_W = 978;
const VIEWPORT_H = 658;

type Mode = "ring" | "packed2d";

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

/**
 * Runs the real pipeline under one layout mode. `computeClusterAnchors` and
 * `createGraphSimulation` are imported fresh per mode so the module-level
 * CLUSTER_LAYOUT_MODE constant can be overridden without changing its source.
 */
async function runPipeline(mode: Mode) {
  vi.resetModules();
  vi.doMock("./cluster-regions", async () => {
    const actual = await vi.importActual<typeof import("./cluster-regions")>("./cluster-regions");
    return { ...actual, CLUSTER_LAYOUT_MODE: mode };
  });
  const { computeClusterAnchors } = await import("./clusters");
  const { createGraphSimulation } = await import("./engine");

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

  const simulation = createGraphSimulation();
  // Mirrors graph-canvas.tsx's physics effect exactly.
  simulation.setNodes(
    nodes,
    (node) => computeNodeRadius("connections", degree.get(node.id) ?? 0, undefined),
    {},
    (node) => anchors.get(node.id)?.categoryAnchor ?? undefined
  );
  simulation.setEdges(edges, 1);
  simulation.setCollections(data.collections);
  simulation.setClusterAnchors(anchors);
  simulation.reheat(1);
  for (let i = 0; i < 8000 && !simulation.isSettled(); i++) simulation.tick();

  const world = nodes.map((n) => {
    const p = simulation.findNode(n.id)!;
    return { id: n.id, x: p.x!, y: p.y!, radius: p.radius };
  });
  return { mode, tree, edges, world, anchors, data, simulation };
}

type Pipeline = Awaited<ReturnType<typeof runPipeline>>;

/** The frozen boundary pass, applied exactly as graph-canvas.tsx applies it, at a given camera. */
function boundaryPass(run: Pipeline, zoomFactor = 1, selectedClusterId: string | null = null) {
  const fit = computeFitCamera(run.world, VIEWPORT_W, VIEWPORT_H);
  const camera = { ...fit, zoom: fit.zoom * zoomFactor };
  const screen = new Map(
    run.world.map((p) => {
      const s = worldToScreen(camera, p, VIEWPORT_W, VIEWPORT_H);
      return [p.id, { x: s.x, y: s.y, radius: p.radius * camera.zoom }] as const;
    })
  );
  const occupants: BoundaryOccupant[] = [...screen].map(([id, p]) => ({ id, x: p.x, y: p.y }));

  type Cand = {
    id: string;
    label: string;
    kind: string;
    rect: CollectionBoundaryRect;
    weight: number;
    purity: number;
    ok: boolean;
    inside: number;
    ownInside: number;
    members: number;
  };
  const cands: Cand[] = [];
  const push = (node: ClusterNode, padding: number) => {
    const pts = node.totalTabIds.map((id) => screen.get(id)!).filter(Boolean);
    if (pts.length === 0 || (pts.length === 1 && node.id !== selectedClusterId)) return;
    const rect = computeCollectionBoundary(pts, padding);
    if (!rect) return;
    const occ = measureBoundaryOccupancy(rect, new Set(node.totalTabIds), occupants);
    cands.push({
      id: node.id,
      label: node.label,
      kind: node.kind,
      rect,
      weight: node.weight,
      purity: boundaryPurity(occ),
      ok: occupancyDelimitsMembers(occ, occupants.length),
      inside: occ.inside,
      ownInside: occ.ownInside,
      members: pts.length,
    });
  };
  for (const cat of run.tree.roots) {
    push(cat, CATEGORY_BOUNDARY_PADDING);
    for (const sub of cat.children) if (sub.kind === "subcategory") push(sub, SUBCATEGORY_BOUNDARY_PADDING);
  }

  cands.sort((a, b) => b.purity * b.weight - a.purity * a.weight || a.id.localeCompare(b.id));
  const drawn: Cand[] = [];
  let overlapSuppressed = 0;
  let gated = 0;
  for (const c of cands) {
    const always = c.id === selectedClusterId;
    if (!always && !c.ok) {
      gated++;
      continue;
    }
    if (!always && drawn.some((d) => rectsOverlap(d.rect, c.rect))) {
      overlapSuppressed++;
      continue;
    }
    drawn.push(c);
  }
  return { cands, drawn, overlapSuppressed, gated, camera, screen, occupants };
}

function metrics(run: Pipeline) {
  const pass = boundaryPass(run);
  const { drawn, cands, overlapSuppressed, gated, camera } = pass;

  const catOfTab = new Map<string, string>();
  for (const cat of run.tree.roots) for (const id of cat.totalTabIds) catOfTab.set(id, cat.id);
  const posById = new Map(run.world.map((w) => [w.id, w]));

  // nearest-own: closest category anchor is its own
  const anchorOfCategory = new Map<string, { x: number; y: number }>();
  for (const cat of run.tree.roots) {
    const member = cat.totalTabIds.find((id) => run.anchors.get(id)?.categoryAnchor);
    const a = member ? run.anchors.get(member)!.categoryAnchor! : null;
    if (a) anchorOfCategory.set(cat.id, a);
  }
  let nearestOwn = 0;
  let counted = 0;
  for (const [tabId, catId] of catOfTab) {
    const p = posById.get(tabId);
    if (!p) continue;
    counted++;
    let best = "";
    let bestD = Infinity;
    for (const [cid, a] of anchorOfCategory) {
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      if (d < bestD) {
        bestD = d;
        best = cid;
      }
    }
    if (best === catId) nearestOwn++;
  }

  // kNN locality, k capped at own-category size - 1
  const sizeOf = new Map(run.tree.roots.map((c) => [c.id, c.totalTabIds.length]));
  let knnSum = 0;
  let knnN = 0;
  for (const p of run.world) {
    const own = catOfTab.get(p.id);
    if (!own) continue;
    const k = Math.min(8, (sizeOf.get(own) ?? 1) - 1);
    if (k <= 0) continue;
    const near = run.world
      .filter((q) => q.id !== p.id)
      .map((q) => ({ id: q.id, d: (q.x - p.x) ** 2 + (q.y - p.y) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k);
    knnSum += near.filter((q) => catOfTab.get(q.id) === own).length / near.length;
    knnN++;
  }

  // edges
  let withinSum = 0;
  let withinN = 0;
  let crossSum = 0;
  let crossN = 0;
  for (const e of run.edges) {
    const a = posById.get(e.source);
    const b = posById.get(e.target);
    if (!a || !b) continue;
    const len = Math.hypot(a.x - b.x, a.y - b.y) * camera.zoom;
    if (catOfTab.get(e.source) === catOfTab.get(e.target)) {
      withinSum += len;
      withinN++;
    } else {
      crossSum += len;
      crossN++;
    }
  }

  // per-category gyration + rim artifact
  let rimMembers = 0;
  let rimTotal = 0;
  let crescents = 0;
  let measured = 0;
  let gyrationSum = 0;
  for (const cat of run.tree.roots) {
    const pts = cat.totalTabIds.map((id) => posById.get(id)!).filter(Boolean);
    if (pts.length < 4) continue;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const dists = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b);
    const r95 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.95))] || 1;
    const over = dists.filter((d) => d > 0.8 * r95).length;
    rimMembers += over;
    rimTotal += dists.length;
    if (over / dists.length > 0.5) crescents++;
    measured++;
    gyrationSum += Math.sqrt(dists.reduce((s, d) => s + d * d, 0) / dists.length) * camera.zoom;
  }

  const catCands = cands.filter((c) => c.kind === "category");
  const drawnInside = drawn.reduce((s, d) => s + d.inside, 0);
  const drawnOwn = drawn.reduce((s, d) => s + d.ownInside, 0);
  const worst = drawn.reduce<(typeof drawn)[number] | null>(
    (m, d) => (m === null || d.rect.width * d.rect.height > m.rect.width * m.rect.height ? d : m),
    null
  );

  return {
    mode: run.mode,
    nearestOwnPct: (100 * nearestOwn) / Math.max(1, counted),
    knnPct: (100 * knnSum) / Math.max(1, knnN),
    categoryPurity: catCands.length ? catCands.reduce((s, c) => s + c.purity, 0) / catCands.length : 0,
    foreignInsideDrawnPct: drawnInside ? (100 * (drawnInside - drawnOwn)) / drawnInside : 0,
    boundaryCount: drawn.length,
    candidateCount: cands.length,
    overlapSuppressed,
    gated,
    worstBoxLabel: worst?.label ?? "-",
    worstBoxAreaPct: worst ? (100 * worst.rect.width * worst.rect.height) / (VIEWPORT_W * VIEWPORT_H) : 0,
    worstBoxForeignPct: worst && worst.inside ? (100 * (worst.inside - worst.ownInside)) / worst.inside : 0,
    meanBoxAreaPct: drawn.length
      ? (100 * drawn.reduce((s, d) => s + d.rect.width * d.rect.height, 0)) / drawn.length / (VIEWPORT_W * VIEWPORT_H)
      : 0,
    withinEdgePx: withinN ? withinSum / withinN : 0,
    crossEdgePx: crossN ? crossSum / crossN : 0,
    stretchRatio: withinN && crossN ? crossSum / crossN / (withinSum / withinN) : 0,
    rimPct: rimTotal ? (100 * rimMembers) / rimTotal : 0,
    crescents,
    categoriesMeasured: measured,
    meanCategoryGyrationPx: measured ? gyrationSum / measured : 0,
  };
}

const PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6",
  "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#1ec8b0", "#800000", "#aaffc3",
  "#808000", "#ffd8b1", "#5b7fff", "#a9a9a9", "#00ff7f", "#ff69b4", "#7fffd4", "#dc143c",
  "#ff8c00", "#20b2aa", "#c71585", "#6b8e23", "#4682b4", "#daa520", "#8a2be2", "#00ced1",
  "#ff4500", "#2e8b57",
];

function renderSvg(run: Pipeline, title: string) {
  const pass = boundaryPass(run);
  const colourOf = new Map<string, string>();
  run.tree.roots.forEach((c, i) => colourOf.set(c.id, PALETTE[i % PALETTE.length]));
  const catOfTab = new Map<string, string>();
  for (const cat of run.tree.roots) for (const id of cat.totalTabIds) catOfTab.set(id, cat.id);

  const boxes = pass.drawn
    .map(
      (d) =>
        `<rect x="${d.rect.x.toFixed(1)}" y="${d.rect.y.toFixed(1)}" width="${d.rect.width.toFixed(1)}" height="${d.rect.height.toFixed(1)}" fill="none" stroke="#8ab" stroke-width="1" stroke-opacity="0.75"/>` +
        `<text x="${(d.rect.x + 4).toFixed(1)}" y="${(d.rect.y - 4).toFixed(1)}" fill="#8ab" font-family="monospace" font-size="10">${d.label.toUpperCase().replace(/[<&>]/g, "")}</text>`
    )
    .join("");
  const dots = run.world
    .map((p) => {
      const s = pass.screen.get(p.id)!;
      return `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${Math.max(1.7, s.radius).toFixed(1)}" fill="${colourOf.get(catOfTab.get(p.id) ?? "") ?? "#666"}" fill-opacity="0.92"/>`;
    })
    .join("");
  const m = metrics(run);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT_W}" height="${VIEWPORT_H}" viewBox="0 0 ${VIEWPORT_W} ${VIEWPORT_H}">` +
    `<rect width="100%" height="100%" fill="#0d0d0f"/>${boxes}${dots}` +
    `<text x="12" y="22" fill="#eee" font-family="monospace" font-size="14">${title}</text>` +
    `<text x="12" y="40" fill="#9aa" font-family="monospace" font-size="11">kNN ${m.knnPct.toFixed(0)}% | purity ${m.categoryPurity.toFixed(2)} | boxes ${m.boundaryCount} | foreign-in-boxes ${m.foreignInsideDrawnPct.toFixed(0)}% | worst ${m.worstBoxLabel} ${m.worstBoxAreaPct.toFixed(1)}%vp ${m.worstBoxForeignPct.toFixed(0)}% foreign</text>` +
    `</svg>`
  );
}

// tabdump-export.json is the user's real personal workspace export - it is
// gitignored (see .gitignore) rather than committed, so this fixture is only
// present on machines that have it locally. This suite is a real-data
// verification harness, not a correctness gate other contributors' CI must
// pass: skip entirely (not fail) when the fixture is absent, and only assert
// its exact shape when it IS present, so an unrelated PR from a fresh clone
// never breaks on a file that was never meant to travel with the repo.
const HAS_FIXTURE = existsSync(EXPORT_PATH);

describe.skipIf(!HAS_FIXTURE)("packed2d category layout, on the real export", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("has the canonical fixture in the expected shape", () => {
    const data = loadWorkspace();
    expect(data.tabs.length).toBe(283);
    const tree = buildClusterTree(data.tabs, data.sections, data.collections);
    expect(tree.roots.length).toBe(34);
  });

  it("measures ring vs packed2d through the real pipeline", async () => {
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    const ring = await runPipeline("ring");
    const packed = await runPipeline("packed2d");
    const a = metrics(ring);
    const g = metrics(packed);

    const row = (m: typeof a) =>
      [
        m.mode.padEnd(9),
        `nearest-own ${m.nearestOwnPct.toFixed(0).padStart(3)}%`,
        `kNN ${m.knnPct.toFixed(0).padStart(3)}%`,
        `purity ${m.categoryPurity.toFixed(2)}`,
        `boxes ${String(m.boundaryCount).padStart(2)}/${m.candidateCount}`,
        `ovlp ${String(m.overlapSuppressed).padStart(2)}`,
        `gated ${String(m.gated).padStart(2)}`,
        `foreign-in ${m.foreignInsideDrawnPct.toFixed(0).padStart(3)}%`,
        `box% ${m.meanBoxAreaPct.toFixed(1)}/${m.worstBoxAreaPct.toFixed(1)}`,
        `within ${m.withinEdgePx.toFixed(0).padStart(3)}px`,
        `cross ${m.crossEdgePx.toFixed(0).padStart(3)}px`,
        `stretch ${m.stretchRatio.toFixed(2).padStart(5)}`,
        `gyr ${m.meanCategoryGyrationPx.toFixed(0).padStart(3)}px`,
        `rim ${m.rimPct.toFixed(0)}%`,
        `crescents ${m.crescents}/${m.categoriesMeasured}`,
        `worst: ${m.worstBoxLabel} ${m.worstBoxAreaPct.toFixed(1)}%vp ${m.worstBoxForeignPct.toFixed(0)}% foreign`,
      ].join(" | ");

    console.log("\n########## REAL EXPORT — PRODUCTION PIPELINE ##########");
    console.log(row(a));
    console.log(row(g));
    console.log(
      `\ncross-category edge stretch vs baseline: ${(g.crossEdgePx / a.crossEdgePx).toFixed(2)}x ` +
        `(${a.crossEdgePx.toFixed(0)}px -> ${g.crossEdgePx.toFixed(0)}px)`
    );

    writeFileSync(join(OUT_DIR, "FINAL-A-baseline.svg"), renderSvg(ring, "A — production (ring anchors)"));
    writeFileSync(join(OUT_DIR, "FINAL-G-packed2d.svg"), renderSvg(packed, "G — packed2d category regions"));

    // The improvements this change exists to deliver.
    expect(g.knnPct).toBeGreaterThan(90);
    expect(g.categoryPurity).toBeGreaterThan(0.9);
    expect(g.foreignInsideDrawnPct).toBeLessThan(10);
    expect(g.boundaryCount).toBeGreaterThan(a.boundaryCount);
    // The screenshot failure: no drawn box may be both large and mostly foreign.
    expect(g.worstBoxForeignPct).toBeLessThan(25);
    expect(g.worstBoxAreaPct).toBeLessThan(6);
    // The accepted cost, pinned so it cannot silently grow. Raised from 2.6
    // to 3.0 when REGION_CONFINE_DISC_SCALE was introduced: holding a
    // category's members inside a disc sized to what they need, rather than
    // letting them spread across the whole 2.2x territory reserved for it,
    // necessarily moves every member further from its neighbours across the
    // gap. Measured on this export, that is the entire cost of the fix —
    // 186px -> 207px of mean cross-category edge, ~11% — and it buys 0 of 33
    // categories split (from 15 of 33) plus kNN 99% -> 100% and purity
    // 0.99 -> 1.00. See "keeps every category's members in one spatial group".
    expect(g.crossEdgePx / a.crossEdgePx).toBeLessThan(3);
  }, 600_000);

  /**
   * The invariant the reported bug violated: same category assignment =>
   * same coherent spatial cluster. Deliberately measured member-to-member
   * (single linkage at COHESION_LINK_PX, plus the worst member's distance to
   * its own nearest same-category member) rather than member-to-anchor,
   * because the failure mode was a member sitting comfortably inside its own
   * region while being hundreds of pixels from every tab it shares that
   * region with — every anchor/region-based metric read as healthy while a
   * tab was visibly adrift on screen.
   *
   * A chain/arc-shaped category passes this: single linkage only asks that
   * consecutive members be close, not that the cluster be a blob.
   */
  it("keeps every category's members in one spatial group", async () => {
    const packed = await runPipeline("packed2d");
    // 140px ~ 3x the ~48px collide spacing two adjacent members settle at.
    // Deliberately not tighter: the physics seeds new nodes with Math.random(),
    // so the worst member moves a few px run to run (measured 97-104px on this
    // export). Deliberately not looser either — before
    // REGION_CONFINE_DISC_SCALE the same measurement was 316px with 15 of 33
    // categories split, and this guard fails at 140px on that layout.
    const COHESION_LINK_PX = 140;
    const pos = new Map(packed.world.map((w) => [w.id, w]));

    const split: string[] = [];
    let worstPx = 0;
    let worstLabel = "-";
    for (const cat of packed.tree.roots) {
      const pts = cat.totalTabIds.map((id) => pos.get(id)!).filter(Boolean);
      if (pts.length < 2) continue;

      const parent = new Map(pts.map((p) => [p.id, p.id]));
      const find = (id: string): string => {
        let root = id;
        while (parent.get(root) !== root) root = parent.get(root)!;
        return root;
      };
      for (let i = 0; i < pts.length; i++) {
        let nearest = Infinity;
        for (let j = 0; j < pts.length; j++) {
          if (i === j) continue;
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          nearest = Math.min(nearest, d);
          if (j > i && d <= COHESION_LINK_PX) {
            const a = find(pts[i].id);
            const b = find(pts[j].id);
            if (a !== b) parent.set(a, b);
          }
        }
        if (nearest > worstPx) {
          worstPx = nearest;
          worstLabel = cat.label;
        }
      }
      const groups = new Set(pts.map((p) => find(p.id))).size;
      if (groups > 1) split.push(`${cat.label} (${pts.length} tabs) -> ${groups} separate groups`);
    }

    console.log(
      `\ncategory cohesion: ${split.length} split categories | ` +
        `worst member ${worstPx.toFixed(0)}px from its own nearest sibling (${worstLabel})`
    );
    expect(split, `categories whose members are not one spatial group:\n${split.join("\n")}`).toEqual([]);
    expect(worstPx).toBeLessThan(COHESION_LINK_PX);
  }, 600_000);

  /**
   * The other half of the reported failure: categories that plainly exist on
   * screen with no box around them. Nothing here asks for a box per category
   * unconditionally — a box still has to clear the concentration gate and not
   * cross a box already drawn — only that a clean, well-separated category is
   * not dropped for a reason unrelated to its own geometry, which is what the
   * old MAX_AMBIENT_BOUNDARIES ceiling did (8 of 39 candidates drawn).
   */
  it("draws a boundary for the large majority of eligible category candidates", async () => {
    const packed = await runPipeline("packed2d");
    const { cands, drawn, gated } = boundaryPass(packed);
    expect(gated).toBe(0);
    expect(drawn.length).toBeGreaterThanOrEqual(cands.length * 0.75);
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i];
        const b = drawn[j];
        const nested = rectContains(a.rect, b.rect) || rectContains(b.rect, a.rect);
        expect(rectsOverlap(a.rect, b.rect) && !nested, `${a.label} X ${b.label}`).toBe(false);
      }
    }
    console.log(`\nboundaries: ${drawn.length}/${cands.length} candidates drawn, 0 gated, 0 crossings`);
  }, 600_000);

  it("keeps every drawn boundary tied to its own members, not merely non-overlapping", async () => {
    const packed = await runPipeline("packed2d");
    const { drawn } = boundaryPass(packed);
    for (const box of drawn) {
      expect(box.purity).toBeGreaterThan(0.7);
      expect(box.ownInside).toBe(box.members);
    }
  }, 600_000);

  it("nests School/Reference/Projects/Research subcategory boxes inside their parent category box", async () => {
    const packed = await runPipeline("packed2d");
    const { cands } = boundaryPass(packed);
    const byId = new Map(cands.map((c) => [c.id, c]));
    const pairs: [string, string][] = [];
    for (const cat of packed.tree.roots) {
      for (const sub of cat.children) {
        if (sub.kind !== "subcategory") continue;
        if (byId.has(cat.id) && byId.has(sub.id)) pairs.push([cat.id, sub.id]);
      }
    }
    expect(pairs.length).toBeGreaterThanOrEqual(6);
    const labels: string[] = [];
    for (const [catId, subId] of pairs) {
      const parent = byId.get(catId)!;
      const child = byId.get(subId)!;
      labels.push(`${parent.label} > ${child.label}: ${rectContains(parent.rect, child.rect) ? "NESTED" : "ESCAPES"}`);
      expect(rectContains(parent.rect, child.rect)).toBe(true);
    }
    console.log("\nsubcategory nesting:\n  " + labels.join("\n  "));
  }, 600_000);

  it("does not produce pathological boxes for the 17 tiny (<=3 tab) categories", async () => {
    const packed = await runPipeline("packed2d");
    const { cands } = boundaryPass(packed);
    const tiny = cands.filter((c) => c.kind === "category" && c.weight <= 3);
    expect(tiny.length).toBeGreaterThanOrEqual(15);
    for (const box of tiny) {
      // A 2-3 tab category must never claim a large slice of the viewport...
      expect((100 * box.rect.width * box.rect.height) / (VIEWPORT_W * VIEWPORT_H)).toBeLessThan(3);
      // ...nor be mostly other people's nodes.
      expect(box.purity).toBeGreaterThan(0.5);
    }
    const worst = tiny.reduce((m, c) => Math.max(m, (100 * c.rect.width * c.rect.height) / (VIEWPORT_W * VIEWPORT_H)), 0);
    console.log(
      `\ntiny categories (<=3 tabs): ${tiny.length} | max box ${worst.toFixed(2)}% viewport | ` +
        `min purity ${Math.min(...tiny.map((c) => c.purity)).toFixed(2)}`
    );
  }, 600_000);

  it("keeps boundaries correct under zoom and pan", async () => {
    const packed = await runPipeline("packed2d");
    for (const zoom of [0.5, 0.7, 1, 1.6, 2.5]) {
      const { drawn } = boundaryPass(packed, zoom);
      expect(drawn.length).toBeGreaterThan(0);
      for (const box of drawn) {
        // Every member still inside its own box at every zoom level.
        expect(box.ownInside).toBe(box.members);
      }
    }
  }, 600_000);

  it("still draws a selected cluster's boundary even when it would otherwise be suppressed", async () => {
    const packed = await runPipeline("packed2d");
    const smallest = [...packed.tree.roots].sort((a, b) => a.weight - b.weight)[0];
    const { drawn } = boundaryPass(packed, 1, smallest.id);
    expect(drawn.some((d) => d.id === smallest.id)).toBe(true);
  }, 600_000);
});
