/**
 * Verifies the headless settle that runs BEFORE the Graph View is allowed to
 * open — the "physics settling is part of readiness" half of the gate.
 *
 * Measured on the canonical real workspace export (tabdump-export.json: 283
 * tabs), the same fixture g-verification.test.ts uses, so the numbers here
 * describe a realistic dump rather than a toy one.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeLayoutKey, createLayoutPrecompute, precomputeGraphLayout, resolveGraphLayoutInput } from "./precompute";
import { createGraphSimulation } from "./engine";
import { buildClusterTree, computeClusterAnchors } from "./clusters";
import { buildGraphNodes, buildWorkspaceLookup } from "./relations";
import { computeNodeRadius } from "./node-size";
import { defaultGraphState } from "./persistence";
import type { GraphPersistedState } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace } from "@/lib/workspace/types";

const EXPORT_PATH = join(process.cwd(), "tabdump-export.json");

function loadRealWorkspaces(): Workspace[] {
  const raw = JSON.parse(readFileSync(EXPORT_PATH, "utf8"));
  return (raw.workspaces ?? []) as Workspace[];
}

function graphState(): GraphPersistedState {
  return defaultGraphState();
}

/** A synthetic dump big enough to exercise clustering, without depending on the export fixture being present. */
function syntheticWorkspaces(tabCount: number): Workspace[] {
  const categories = ["work", "school", "shopping", "social", "other"] as Tab["category"][];
  const sections: Section[] = categories.map((c, i) => ({
    id: `s${i}`,
    name: String(c),
    parentId: null,
    depth: 0 as const,
    createdAt: 0,
    updatedAt: 0,
    source: "ai" as const,
  }));
  const tabs: Tab[] = Array.from({ length: tabCount }, (_, i) => {
    const bucket = i % categories.length;
    return {
      id: `t${i}`,
      url: `https://site${bucket}.example.com/page/${i}`,
      normalizedUrl: `https://site${bucket}.example.com/page/${i}`,
      domain: `site${bucket}.example.com`,
      title: `Page ${i}`,
      category: categories[bucket],
      sectionId: `s${bucket}`,
    };
  });
  return [{ id: "w1", name: "General", tabs, sections, createdAt: 0, updatedAt: 0 }];
}

describe("layout precompute", () => {
  it("settles a realistic-scale dump before the graph is ever mounted", () => {
    const workspaces = existsSync(EXPORT_PATH) ? loadRealWorkspaces() : syntheticWorkspaces(283);
    const tabCount = workspaces.flatMap((w) => w.tabs).length;
    expect(tabCount).toBeGreaterThan(200);

    const result = precomputeGraphLayout(resolveGraphLayoutInput(workspaces, [], [], graphState()));

    expect(result.settled).toBe(true);
    expect(result.ticks).toBeGreaterThan(0);
    expect(Object.keys(result.positions)).toHaveLength(tabCount);
    for (const position of Object.values(result.positions)) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
  });

  /** Mounts a simulation the way GraphCanvas's physics effect does, seeded from `settled`. */
  function mountLikeCanvas(workspaces: Workspace[], settled: { positions: Record<string, { x: number; y: number }>; boundaryOffsets: Record<string, { x: number; y: number }> }, edges: ReturnType<typeof resolveGraphLayoutInput>["edges"]) {
    const tabs = workspaces.flatMap((w) => w.tabs);
    const sections = workspaces.flatMap((w) => w.sections ?? []);
    const nodes = buildGraphNodes(tabs, buildWorkspaceLookup(workspaces));
    const anchors = computeClusterAnchors(buildClusterTree(tabs, sections, []));

    const simulation = createGraphSimulation();
    simulation.setNodes(nodes, () => computeNodeRadius("connections", 0, undefined), settled.positions, (node) =>
      anchors.get(node.id)?.categoryAnchor ?? undefined
    );
    // Both halves of what the canvas restores, in the canvas's own order:
    // without the anchor offsets a boundary square's accumulated push is lost
    // and confineToRegions drags every one of its members back to the
    // canonical anchor — which is a re-layout, not a settle.
    simulation.seedBoundaryOffsets(settled.boundaryOffsets);
    simulation.setEdges(edges, 1);
    simulation.setClusterAnchors(anchors);
    return { simulation, nodes };
  }

  function maxDriftFrom(
    simulation: ReturnType<typeof createGraphSimulation>,
    nodes: ReturnType<typeof buildGraphNodes>,
    positions: Record<string, { x: number; y: number }>
  ): number {
    let max = 0;
    for (const node of nodes) {
      const after = simulation.findNode(node.id)!;
      const before = positions[node.id];
      max = Math.max(max, Math.hypot(after.x! - before.x, after.y! - before.y));
    }
    return max;
  }

  it("opens static: the settled layout, mounted and cooled the way the canvas mounts it, does not move at all", () => {
    const workspaces = syntheticWorkspaces(160);
    const input = resolveGraphLayoutInput(workspaces, [], [], graphState());
    const settled = precomputeGraphLayout(input);

    const { simulation, nodes } = mountLikeCanvas(workspaces, settled, input.edges);
    // The branch GraphCanvas takes when every node already has a position.
    simulation.cool();

    expect(simulation.isSettled()).toBe(true);
    for (let i = 0; i < 200; i++) simulation.tick();
    expect(maxDriftFrom(simulation, nodes, settled.positions)).toBe(0);
  });

  it("shows why cooling is required: reheating the SAME settled positions restructures the layout again", () => {
    const workspaces = syntheticWorkspaces(160);
    const input = resolveGraphLayoutInput(workspaces, [], [], graphState());
    const settled = precomputeGraphLayout(input);

    const { simulation, nodes } = mountLikeCanvas(workspaces, settled, input.edges);
    // What the canvas used to do unconditionally. A d3 simulation stops
    // because alpha decayed, not because its forces balanced — so raising
    // alpha moves an already-settled layout all over again, which is exactly
    // the "graph opens and everything rearranges" this whole change removes.
    simulation.reheat(0.5);
    for (let i = 0; i < 300 && !simulation.isSettled(); i++) simulation.tick();

    expect(maxDriftFrom(simulation, nodes, settled.positions)).toBeGreaterThan(50);
  });

  it("is deterministic for tabs that already have persisted positions", () => {
    const workspaces = syntheticWorkspaces(60);
    const seeded = precomputeGraphLayout(resolveGraphLayoutInput(workspaces, [], [], graphState()));

    const state: GraphPersistedState = { ...graphState(), positions: seeded.positions };
    const first = precomputeGraphLayout(resolveGraphLayoutInput(workspaces, [], [], state));
    const second = precomputeGraphLayout(resolveGraphLayoutInput(workspaces, [], [], state));

    for (const id of Object.keys(first.positions)) {
      expect(second.positions[id].x).toBeCloseTo(first.positions[id].x, 6);
      expect(second.positions[id].y).toBeCloseTo(first.positions[id].y, 6);
    }
  });

  it("can be driven in bounded slices, reporting done only once it has actually settled", () => {
    const workspaces = syntheticWorkspaces(80);
    const precompute = createLayoutPrecompute(resolveGraphLayoutInput(workspaces, [], [], graphState()));

    expect(precompute.step(1)).toBe(false);
    expect(precompute.settled()).toBe(false);

    let slices = 0;
    while (!precompute.step(40) && slices < 500) slices++;

    expect(precompute.settled()).toBe(true);
    expect(precompute.ticks()).toBeGreaterThan(1);
    expect(Object.keys(precompute.result().positions)).toHaveLength(80);
  });

  describe("layout key", () => {
    function keyFor(workspaces: Workspace[], state = graphState()) {
      const tabs = workspaces.flatMap((w) => w.tabs);
      const sections = workspaces.flatMap((w) => w.sections ?? []);
      return computeLayoutKey(
        buildClusterTree(tabs, sections, []),
        tabs.map((t) => t.id),
        state.settings
      );
    }

    it("is stable for the same graph", () => {
      const workspaces = syntheticWorkspaces(20);
      expect(keyFor(workspaces)).toBe(keyFor(syntheticWorkspaces(20)));
    });

    it("changes when a tab is added or removed", () => {
      expect(keyFor(syntheticWorkspaces(20))).not.toBe(keyFor(syntheticWorkspaces(21)));
    });

    it("changes when a tab moves to a different cluster, even though the tab set is identical", () => {
      const before = syntheticWorkspaces(20);
      const after = syntheticWorkspaces(20);
      // Exactly what recategorizing a tab, or applying an Auto-Organize plan,
      // does: same tabs, different cluster. The layout is no longer finished
      // for this graph, so the canvas must lay out again rather than open
      // static on positions that put this tab in its old neighbourhood.
      after[0].tabs[0] = { ...after[0].tabs[0], sectionId: "s3", category: "social" };

      expect(keyFor(after)).not.toBe(keyFor(before));
    });

    it("changes when a display setting that shapes the forces changes", () => {
      const workspaces = syntheticWorkspaces(20);
      const base = graphState();
      const resized = {
        ...base,
        settings: { ...base.settings, display: { ...base.settings.display, edgeStrength: 2 } },
      };

      expect(keyFor(workspaces, resized)).not.toBe(keyFor(workspaces, base));
    });
  });

  it("keeps positions for tabs that are no longer in the graph rather than dropping them", () => {
    const workspaces = syntheticWorkspaces(10);
    const state: GraphPersistedState = { ...graphState(), positions: { "gone-tab": { x: 5, y: 7 } } };

    const result = precomputeGraphLayout(resolveGraphLayoutInput(workspaces, [], [], state));

    // Pruning is GraphPersistedState's job (pruneGraphState), not the
    // precompute's — it must not silently discard state it wasn't asked about.
    expect(result.positions["gone-tab"]).toEqual({ x: 5, y: 7 });
  });
});
