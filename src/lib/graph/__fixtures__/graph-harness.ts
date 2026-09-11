/**
 * A graph driven exactly the way graph-canvas.tsx drives it, for tests that
 * have to observe the whole pipeline rather than one function.
 *
 * The stretched-square bug lived in the interaction between three things that
 * only meet in a running simulation — boundary squares are bounding boxes
 * over their members, membership overlaps across tiers, and the boundary
 * layer translates members — so every unit test of every piece stayed green
 * while it was on screen. Anything asserting that it cannot come back has to
 * run relations → cluster tree → d3-force → boundary layer → the renderer's
 * own boundary pass, in the renderer's own per-frame order.
 *
 * Kept deliberately close to draw(): if the two drift, the tests stop testing
 * the thing that broke.
 */
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup } from "../relations";
import { buildClusterTree, computeClusterAnchors, type ClusterAnchorAssignment } from "../clusters";
import { createGraphSimulation } from "../engine";
import { computeNodeRadius } from "../node-size";
import { computeClusterRegions, confinementRegion } from "../cluster-regions";
import {
  CATEGORY_BOUNDARY_PADDING,
  COLLECTION_BOUNDARY_PADDING,
  SUBCATEGORY_BOUNDARY_PADDING,
  computeCollectionBoundary,
  resolveLiveBoundaries,
  type BoundaryOccupant,
  type CollectionBoundaryRect,
} from "../collection-layout";
import { DEFAULT_CONNECTION_FILTERS, MAX_GRAPH_COORD } from "../types";
import { MAX_NODE_RADIUS } from "../node-size";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Collection } from "@/lib/collections/types";
import type { Workspace } from "@/lib/workspace/types";

/** Seeded, so a failure is always the same failure — a physics test reported as flaky is worse than no test. */
export function makeRandom(seed: number) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const CATEGORY_NAMES: [string, string[]][] = [
  ["Claude", ["Prompts", "Agents", "Docs"]],
  ["9Mod", ["Builds", "Textures"]],
  ["Projects", ["TabDump", "Portfolio", "Scratch"]],
  ["YouTube", ["Music", "Tutorials"]],
  ["AI Tools", ["LLMs", "Research"]],
  ["Dev", ["Frontend", "Backend"]],
  ["Docs", ["MDN", "React"]],
  ["Shopping", ["Electronics"]],
  ["News", ["Tech"]],
  ["Social", ["X", "Reddit"]],
];

const DOMAINS = [
  "claude.ai",
  "github.com",
  "youtube.com",
  "reddit.com",
  "news.ycombinator.com",
  "developer.mozilla.org",
  "react.dev",
  "nextjs.org",
  "amazon.com",
  "x.com",
];

export type WorkspaceOptions = {
  /** How many categories of the fixture's ten to use. */
  categories?: number;
  /** 0 puts every tab directly in its category — the "no children" shape. */
  subcategoryShare?: number;
  /** Collections cut ACROSS categories, which is the membership overlap the bug lived in. */
  collections?: number;
  seed?: number;
  longText?: boolean;
};

export function buildWorkspace(total: number, options: WorkspaceOptions = {}) {
  const {
    categories = CATEGORY_NAMES.length,
    subcategoryShare = 0.72,
    collections: collectionCount = Math.max(2, Math.round(total / 40)),
    seed = 12345,
    longText = false,
  } = options;

  const now = 1_700_000_000_000;
  const random = makeRandom(seed);
  const used = CATEGORY_NAMES.slice(0, Math.max(1, Math.min(categories, CATEGORY_NAMES.length)));
  const sections: Section[] = [];
  const categoryIds: string[] = [];
  const subsByCategory: Record<string, string[]> = {};

  used.forEach(([name, subs], i) => {
    const id = `sec-cat-${i}`;
    sections.push({ id, parentId: null, name, source: "ai", createdAt: now, updatedAt: now });
    categoryIds.push(id);
    subsByCategory[id] = [];
    subs.forEach((subName, j) => {
      const subId = `sec-sub-${i}-${j}`;
      sections.push({ id: subId, parentId: id, name: subName, source: "ai", createdAt: now, updatedAt: now });
      subsByCategory[id].push(subId);
    });
  });

  const longTitle = "A ludicrously long tab title ".repeat(12);
  const tabs: Tab[] = [];
  for (let i = 0; i < total; i++) {
    const categoryIndex = i % used.length;
    const categoryId = categoryIds[categoryIndex];
    const subs = subsByCategory[categoryId];
    const sectionId = random() < subcategoryShare ? subs[Math.floor(random() * subs.length)] : categoryId;
    const domain = DOMAINS[categoryIndex % DOMAINS.length];
    const path = longText ? `${"very-long-path-segment/".repeat(20)}${i}` : `p/${i}`;
    tabs.push({
      id: `tab-${i}`,
      url: `https://${domain}/${path}`,
      normalizedUrl: `https://${domain}/${path}`,
      domain,
      title: longText ? `${longTitle}${i}` : `${used[categoryIndex][0]} ${i}`,
      category: "other",
      sectionId,
    });
  }

  const collections: Collection[] = [];
  for (let c = 0; c < collectionCount; c++) {
    const size = 4 + Math.floor(random() * 12);
    const ids: string[] = [];
    for (let k = 0; k < size; k++) ids.push(`tab-${Math.floor(random() * total)}`);
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

export type WorkspaceData = ReturnType<typeof buildWorkspace>;

export type DrawnBoundary = {
  id: string;
  kind: "category" | "subcategory" | "collection";
  label: string;
  rect: CollectionBoundaryRect;
  memberIds: string[];
  padding: number;
};

export type GraphOptions = {
  /**
   * Set false to run the identical pipeline with NO boundary bodies at all.
   *
   * This is the control the "settle equilibrium" measurement needs: it is the
   * only way to separate what the node forces and confineToRegions do on
   * their own from what the boundary layer adds on top.
   */
  bodies?: boolean;
};

export function makeGraph(
  data: WorkspaceData,
  positions: Record<string, { x: number; y: number }> = {},
  options: GraphOptions = {}
) {
  const withBodies = options.bodies ?? true;
  const lookup = buildWorkspaceLookup(data.workspaces);
  const nodes = buildGraphNodes(data.tabs, lookup);
  const edges = buildGraphEdges(data.tabs, lookup, DEFAULT_CONNECTION_FILTERS, [], data.sections);
  const tree = buildClusterTree(data.tabs, data.sections, data.collections);
  const anchors = computeClusterAnchors(tree);
  const regions = computeClusterRegions(tree);

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const simulation = createGraphSimulation();
  const radiusOf = (node: { id: string }) => computeNodeRadius("connections", degree.get(node.id) ?? 0, undefined);
  const anchorFallback = (node: { id: string }) => {
    const anchor = anchors.get(node.id);
    return anchor?.subcategoryAnchor ?? anchor?.categoryAnchor ?? undefined;
  };

  /** graph-canvas.tsx's physics effect, in its own call order. */
  function install(visible = nodes, seedPositions = positions, savedOffsets?: Record<string, { x: number; y: number }>) {
    simulation.setNodes(visible, radiusOf, seedPositions, anchorFallback);
    if (savedOffsets) simulation.seedBoundaryOffsets(savedOffsets);
    simulation.setEdges(edges, 1);
    simulation.setCollections(data.collections);
    simulation.setClusterAnchors(anchors);
    simulation.reheat(0.5);
  }

  const live = new Set<string>();

  /** draw()'s boundary pass: rebuild every rect, resolve the live set, hand it to the physics. */
  function boundaryPass(): DrawnBoundary[] {
    const occupants: BoundaryOccupant[] = [];
    for (const node of nodes) {
      const physicsNode = simulation.findNode(node.id);
      if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue;
      occupants.push({ id: node.id, x: physicsNode.x, y: physicsNode.y });
    }
    const pointsOf = (ids: readonly string[]) => {
      const points: { x: number; y: number; radius: number }[] = [];
      for (const id of ids) {
        const physicsNode = simulation.findNode(id);
        if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue;
        points.push({ x: physicsNode.x, y: physicsNode.y, radius: physicsNode.radius });
      }
      return points;
    };

    const candidates: DrawnBoundary[] = [];
    const add = (id: string, kind: DrawnBoundary["kind"], label: string, memberIds: string[], padding: number) => {
      const points = pointsOf(memberIds);
      if (points.length <= 1) return;
      const rect = computeCollectionBoundary(points, padding);
      if (rect) candidates.push({ id, kind, label, rect, memberIds, padding });
    };

    for (const category of tree.roots) {
      add(category.id, "category", category.label, category.totalTabIds, CATEGORY_BOUNDARY_PADDING);
    }
    for (const category of tree.roots) {
      for (const sub of category.children) {
        if (sub.kind !== "subcategory") continue;
        add(sub.id, "subcategory", sub.label, sub.totalTabIds, SUBCATEGORY_BOUNDARY_PADDING);
      }
    }
    for (const collection of data.collections) {
      add(collection.id, "collection", collection.name, collection.tabIds, COLLECTION_BOUNDARY_PADDING);
    }

    resolveLiveBoundaries(
      candidates.map((c) => ({ id: c.id, rect: c.rect, memberIds: new Set(c.memberIds) })),
      live,
      occupants,
      new Set<string>()
    );
    const drawn = candidates.filter((c) => live.has(c.id));
    simulation.setBoundaryBodies(
      withBodies ? drawn.map((c) => ({ id: c.id, memberIds: c.memberIds, padding: c.padding })) : []
    );
    return drawn;
  }

  /** One animation frame, in loop()'s order: tick, then draw's boundary pass. */
  function frame(): DrawnBoundary[] {
    simulation.tick();
    return boundaryPass();
  }

  function run(frames: number): DrawnBoundary[] {
    let drawn: DrawnBoundary[] = boundaryPass();
    for (let i = 0; i < frames; i++) drawn = frame();
    return drawn;
  }

  /**
   * How far each tab sits outside the disc it is actually confined to —
   * `confineTo`, which is what engine.ts's confineToRegions projects against,
   * so this measures the engine's own rule rather than a proxy for it.
   *
   * It used to measure every tab against its CATEGORY's confinement disc. That
   * was an upper bound only while a subcategory's sub-disc was forced to sit
   * well inside its parent's (the 0.42x cap that made large subsections
   * 2.4-5.3x over-dense — see cluster-regions.ts's layoutCategoryGround). With
   * sub-discs sized to their own members, a category's ground grows with its
   * children, and a tab correctly inside its own sub-disc can sit outside the
   * smaller disc its parent's DIRECT members use — which the old measurement
   * reported as an overshoot of up to 129px on the 300-tab fixture.
   */
  function confinementOvershoot(): { worst: number; outside: number } {
    let worst = 0;
    let outside = 0;
    for (const category of tree.roots) {
      const region = regions.get(category.id);
      if (!region) continue;
      for (const id of category.totalTabIds) {
        const physicsNode = simulation.findNode(id);
        if (!physicsNode || physicsNode.x === undefined || physicsNode.y === undefined) continue;
        const disc = anchors.get(id)?.confineTo ?? confinementRegion(region);
        const distance = Math.hypot(physicsNode.x - disc.x, physicsNode.y - disc.y) - disc.r;
        if (distance > 1) {
          outside++;
          worst = Math.max(worst, distance);
        }
      }
    }
    return { worst, outside };
  }

  function radii(): Map<string, number> {
    const out = new Map<string, number>();
    for (const node of nodes) {
      const physicsNode = simulation.findNode(node.id);
      if (physicsNode) out.set(node.id, physicsNode.radius);
    }
    return out;
  }

  function positionsOf(ids: readonly string[]): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const physicsNode = simulation.findNode(id);
      if (physicsNode?.x !== undefined && physicsNode.y !== undefined) out.set(id, { x: physicsNode.x, y: physicsNode.y });
    }
    return out;
  }

  /** Tab id → the id of the confinement disc it lives on, from the same anchors the engine reads. */
  function territoryOfTab(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [tabId, assignment] of anchors) {
      const id = territoryIdOf(assignment);
      if (id) out.set(tabId, id);
    }
    return out;
  }

  /** Disc id → the tabs on it. */
  function territoryMembers(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [tabId, territoryId] of territoryOfTab()) {
      const list = out.get(territoryId);
      if (list) list.push(tabId);
      else out.set(territoryId, [tabId]);
    }
    return out;
  }

  install();

  return {
    simulation,
    nodes,
    edges,
    tree,
    anchors,
    regions,
    data,
    install,
    frame,
    run,
    boundaryPass,
    confinementOvershoot,
    radii,
    positionsOf,
    territoryOfTab,
    territoryMembers,
  };
}

export function territoryIdOf(assignment: ClusterAnchorAssignment | undefined): string | null {
  const region = assignment?.confineTo;
  if (!region) return null;
  return assignment?.confineToId ?? `@${region.x}:${region.y}:${region.r}`;
}

/**
 * Confinement is a PARTIAL pullback, not a wall — see engine.ts's
 * confineToRegions, and the "settle equilibrium" test in
 * node-dimensions.test.ts, which measures this number with the boundary layer
 * switched off entirely to show it is not the boundary layer's doing. 30px per
 * side sits comfortably above the ~20px these fixtures actually produce, and
 * an order of magnitude below the failure being guarded against.
 */
export const CONFINEMENT_SETTLE_SLACK = 30;

/**
 * The size a boundary square over ONE confinement disc may legitimately
 * reach: the disc's diameter, its padding on both sides, the node radius that
 * pushes the members' bounding box out at each edge, and the settle slack.
 */
export function budgetFor(radius: number, padding: number): number {
  return radius * 2 + padding * 2 + MAX_NODE_RADIUS * 2 + CONFINEMENT_SETTLE_SLACK * 2;
}

/**
 * The budget for one drawn square, or null when its members span more than
 * one disc (a Collection cutting across categories genuinely encloses ground
 * that wide, and no ceiling on the square itself would be honest about it).
 *
 * The radius is the OUTERMOST disc its members sit inside, which is the bound
 * the architecture actually guarantees: a subcategory's sub-disc is only ever
 * clamped to stay within its parent category's (see
 * boundary-frames.ts's clampFramesWithinParents), and a category whose every
 * tab happens to live in one subcategory would otherwise be measured against
 * that subcategory's much smaller disc. Same rule as the runtime guard in
 * dimension-guard.ts, deliberately — the test and the shipped assertion must
 * not disagree about what "too big" means.
 */
export function boundaryBudget(
  memberIds: readonly string[],
  anchors: ReadonlyMap<string, ClusterAnchorAssignment>,
  padding: number
): number | null {
  let discId: string | null = null;
  let radius = 0;
  for (const id of memberIds) {
    const assignment = anchors.get(id);
    if (!assignment?.confineTo) return null;
    const regionId = territoryIdOf(assignment);
    if (discId === null) discId = regionId;
    else if (discId !== regionId) return null;
    radius = Math.max(radius, assignment.confineWithin?.r ?? assignment.confineTo.r);
  }
  if (discId === null) return null;
  return budgetFor(radius, padding);
}

export { MAX_GRAPH_COORD };
