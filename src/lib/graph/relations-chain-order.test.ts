/**
 * The chain ORDER, which is what decides how long an edge ends up being.
 *
 * buildGraphEdges represents each shared-attribute group as an O(n) chain
 * rather than an O(n^2) clique (see chainEdges). Any spanning path over the
 * group states the relationship equally well, so the path is chosen — and
 * choosing it by tab id, as this used to, is choosing a random permutation of
 * the group. On the real 283-tab export, where every tab shares one
 * workspace, that produced 162 workspace edges averaging 1237px in a graph
 * only ~3300px across.
 *
 * These tests assert the ordering PROPERTIES that fix holds — chained pairs
 * are structurally adjacent, and cluster-to-cluster seams land between
 * spatial neighbours — without freezing the exact permutation, which is an
 * implementation detail the serpentine sweep is free to change.
 */
import { describe, expect, it } from "vitest";
import { buildGraphEdges, buildWorkspaceLookup } from "./relations";
import { DEFAULT_CONNECTION_FILTERS } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * Tabs in `categoryCount` legacy categories, `perCategory` each, with ids
 * deliberately assigned so that sorting by id INTERLEAVES the categories —
 * i.e. the exact input on which an id-ordered chain performs worst and a
 * locality-ordered one performs best.
 */
function makeTabs(categoryCount: number, perCategory: number): Tab[] {
  const categories = ["research", "school", "projects", "shopping", "creative", "news"] as const;
  const tabs: Tab[] = [];
  for (let member = 0; member < perCategory; member++) {
    for (let category = 0; category < categoryCount; category++) {
      const id = `tab-${String(member * categoryCount + category).padStart(4, "0")}`;
      tabs.push({
        id,
        url: `https://c${category}.example.com/${id}`,
        normalizedUrl: `https://c${category}.example.com/${id}`,
        domain: `c${category}.example.com`,
        category: categories[category % categories.length],
      });
    }
  }
  return tabs;
}

function build(tabs: Tab[], anchorOf?: (id: string) => { x: number; y: number } | undefined) {
  const workspaces: Workspace[] = [{ id: "w1", name: "w1", tabs, createdAt: 0, updatedAt: 0 }];
  return buildGraphEdges(
    tabs,
    buildWorkspaceLookup(workspaces),
    DEFAULT_CONNECTION_FILTERS,
    [],
    [],
    anchorOf
  );
}

/** Anchors placing each category on a wide ring, so "spatially adjacent" is well defined and differs from id order. */
function ringAnchors(tabs: Tab[]): (id: string) => { x: number; y: number } | undefined {
  const categories = [...new Set(tabs.map((t) => t.category!))].sort();
  const byCategory = new Map(
    categories.map((category, index) => {
      const angle = (index / categories.length) * Math.PI * 2;
      return [category, { x: Math.cos(angle) * 1000, y: Math.sin(angle) * 1000 }];
    })
  );
  const byTab = new Map(tabs.map((tab) => [tab.id, byCategory.get(tab.category!)]));
  return (id) => byTab.get(id);
}

describe("chain ordering", () => {
  const tabs = makeTabs(6, 20);

  it("does not change how many edges exist, only which pairs they join", () => {
    // The relationship set is the same size either way — this is a choice of
    // spanning path, not a change to what the graph claims is related.
    const withoutAnchors = build(tabs);
    const withAnchors = build(tabs, ringAnchors(tabs));
    expect(withAnchors.length).toBe(withoutAnchors.length);
  });

  it("chains almost every pair within a single category", () => {
    const categoryOf = new Map(tabs.map((tab) => [tab.id, tab.category!]));
    const edges = build(tabs, ringAnchors(tabs));
    const sameCategory = edges.filter((edge) => categoryOf.get(edge.source) === categoryOf.get(edge.target)).length;

    // A chain over k categories must cross between them k-1 times; everything
    // else should stay inside a category. With 6 categories that is at most 5
    // crossings per chained relationship.
    expect(sameCategory / edges.length).toBeGreaterThan(0.9);
  });

  it("is a large improvement on id ordering for exactly that measure", () => {
    // The regression this guards: ids here interleave the categories, so an
    // id-ordered chain crosses a category boundary on almost every link.
    const categoryOf = new Map(tabs.map((tab) => [tab.id, tab.category!]));
    const share = (edges: ReturnType<typeof build>) =>
      edges.filter((edge) => categoryOf.get(edge.source) === categoryOf.get(edge.target)).length / edges.length;

    const idOrdered = tabs.map((tab) => ({ ...tab, category: undefined, domain: "same.example.com" }));
    const degenerate = build(idOrdered);
    const categoryOfDegenerate = new Map(tabs.map((tab) => [tab.id, tab.category!]));
    const degenerateShare =
      degenerate.filter((edge) => categoryOfDegenerate.get(edge.source) === categoryOfDegenerate.get(edge.target))
        .length / degenerate.length;

    expect(share(build(tabs, ringAnchors(tabs)))).toBeGreaterThan(degenerateShare + 0.4);
  });

  it("lands the unavoidable cluster-to-cluster seams between spatial neighbours", () => {
    const anchorOf = ringAnchors(tabs);
    const categoryOf = new Map(tabs.map((tab) => [tab.id, tab.category!]));
    const edges = build(tabs, anchorOf);

    const seams = edges.filter((edge) => categoryOf.get(edge.source) !== categoryOf.get(edge.target));
    expect(seams.length).toBeGreaterThan(0);

    // Every distinct pairwise distance between category anchors, so "a seam
    // joins neighbours" can be stated as "no seam is near the widest possible
    // separation".
    const anchors = [...new Set(tabs.map((t) => t.category!))].map(
      (category) => anchorOf(tabs.find((t) => t.category === category)!.id)!
    );
    let widest = 0;
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        widest = Math.max(widest, Math.hypot(anchors[i].x - anchors[j].x, anchors[i].y - anchors[j].y));
      }
    }

    for (const seam of seams) {
      const a = anchorOf(seam.source)!;
      const b = anchorOf(seam.target)!;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      expect(distance, `seam ${seam.id} crosses the whole layout`).toBeLessThan(widest * 0.95);
    }
  });

  it("is deterministic — the same inputs always produce the same edges", () => {
    const anchorOf = ringAnchors(tabs);
    const first = build(tabs, anchorOf).map((edge) => edge.id);
    const second = build(tabs, anchorOf).map((edge) => edge.id);
    expect(first).toEqual(second);
  });

  it("does not depend on the order tabs are passed in", () => {
    const anchorOf = ringAnchors(tabs);
    const shuffled = [...tabs].reverse();
    const forwards = build(tabs, anchorOf).map((edge) => edge.id).sort();
    const backwards = build(shuffled, anchorOf).map((edge) => edge.id).sort();
    expect(backwards).toEqual(forwards);
  });

  it("falls back cleanly when anchors are missing or only partly known", () => {
    const partial = (id: string) => (id === tabs[0].id ? { x: 0, y: 0 } : undefined);
    expect(() => build(tabs, partial)).not.toThrow();
    expect(build(tabs, partial).length).toBe(build(tabs).length);

    const nonFinite = () => ({ x: Number.NaN, y: 0 });
    expect(() => build(tabs, nonFinite)).not.toThrow();
    expect(build(tabs, nonFinite).length).toBe(build(tabs).length);
  });

  it("handles a single category, a single tab, and no tabs at all", () => {
    expect(build([])).toEqual([]);
    expect(build(makeTabs(1, 1))).toEqual([]);
    const oneCategory = makeTabs(1, 5);
    expect(build(oneCategory, ringAnchors(oneCategory)).length).toBeGreaterThan(0);
  });
});
