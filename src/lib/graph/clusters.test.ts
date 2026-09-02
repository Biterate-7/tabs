import { describe, expect, it } from "vitest";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Collection } from "@/lib/collections/types";
import { buildClusterTree, computeClusterAnchors, resolveCategoryKey } from "./clusters";

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://${overrides.id}.example.com`,
    normalizedUrl: `https://${overrides.id}.example.com`,
    domain: `${overrides.id}.example.com`,
    ...overrides,
  };
}

function makeSection(overrides: Partial<Section> & { id: string; parentId: string | null }): Section {
  return { name: overrides.id, source: "user", createdAt: 0, updatedAt: 0, ...overrides };
}

function makeCollection(overrides: Partial<Collection> & { id: string; tabIds: string[] }): Collection {
  return { workspaceId: "w1", name: overrides.id, createdAt: 0, updatedAt: 0, ...overrides };
}

describe("resolveCategoryKey", () => {
  it("uses the root section id when sectionId resolves", () => {
    const root = makeSection({ id: "root-1", parentId: null });
    const child = makeSection({ id: "child-1", parentId: "root-1" });
    const tab = makeTab({ id: "a", sectionId: "child-1" });
    expect(resolveCategoryKey(tab, [root, child])).toBe("root-1");
  });

  it("falls back to legacy category when sectionId is dangling", () => {
    const tab = makeTab({ id: "a", sectionId: "ghost", category: "school" });
    expect(resolveCategoryKey(tab, [])).toBe("legacy:school");
  });

  it("falls back to legacy 'other' when neither sectionId nor category is set", () => {
    const tab = makeTab({ id: "a" });
    expect(resolveCategoryKey(tab, [])).toBe("legacy:other");
  });
});

describe("buildClusterTree", () => {
  it("groups sectionless tabs sharing a legacy category into one root cluster", () => {
    const tabs = [makeTab({ id: "a", category: "research" }), makeTab({ id: "b", category: "research" })];
    const tree = buildClusterTree(tabs, [], []);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].kind).toBe("category");
    expect(tree.roots[0].totalTabIds.sort()).toEqual(["a", "b"]);
    expect(tree.roots[0].children).toHaveLength(0);
  });

  it("creates a subcategory child only for tabs with a depth>=1 sectionId", () => {
    const root = makeSection({ id: "root-1", parentId: null, name: "School" });
    const sub = makeSection({ id: "sub-1", parentId: "root-1", name: "Physics" });
    const tabs = [
      makeTab({ id: "a", sectionId: "sub-1" }),
      makeTab({ id: "b", sectionId: "sub-1" }),
      makeTab({ id: "c", sectionId: "root-1" }),
    ];
    const tree = buildClusterTree(tabs, [root, sub], []);
    expect(tree.roots).toHaveLength(1);
    const category = tree.roots[0];
    expect(category.label).toBe("School");
    expect(category.memberTabIds).toEqual(["c"]);
    expect(category.children).toHaveLength(1);
    expect(category.children[0].label).toBe("Physics");
    expect(category.children[0].memberTabIds.sort()).toEqual(["a", "b"]);
    expect(category.totalTabIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("folds a depth-2 project section into its depth-1 subcategory parent", () => {
    const root = makeSection({ id: "root-1", parentId: null });
    const sub = makeSection({ id: "sub-1", parentId: "root-1" });
    const project = makeSection({ id: "proj-1", parentId: "sub-1" });
    const tabs = [makeTab({ id: "a", sectionId: "proj-1" })];
    const tree = buildClusterTree(tabs, [root, sub, project], []);
    expect(tree.roots[0].children).toHaveLength(1);
    expect(tree.roots[0].children[0].id).toBe("sub:sub-1");
    expect(tree.roots[0].children[0].memberTabIds).toEqual(["a"]);
  });

  it("excludes a collection with fewer than 2 present members, mirroring engine.ts", () => {
    const tabs = [makeTab({ id: "a" })];
    const collections = [makeCollection({ id: "c1", tabIds: ["a"] })];
    const tree = buildClusterTree(tabs, [], collections);
    expect([...tree.byId.values()].some((n) => n.kind === "collection")).toBe(false);
  });

  it("parents a cross-category collection by majority membership", () => {
    const root1 = makeSection({ id: "root-1", parentId: null, name: "Research" });
    const root2 = makeSection({ id: "root-2", parentId: null, name: "Shopping" });
    const tabs = [
      makeTab({ id: "a", sectionId: "root-1" }),
      makeTab({ id: "b", sectionId: "root-1" }),
      makeTab({ id: "c", sectionId: "root-2" }),
    ];
    const collections = [makeCollection({ id: "c1", tabIds: ["a", "b", "c"] })];
    const tree = buildClusterTree(tabs, [root1, root2], collections);
    const collectionNode = tree.byId.get("col:c1");
    expect(collectionNode).toBeDefined();
    expect(collectionNode!.parentId).toBe("cat:root-1");
    expect(collectionNode!.memberTabIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("computes weight/totalTabIds bottom-up across category -> subcategory", () => {
    const root = makeSection({ id: "root-1", parentId: null });
    const sub = makeSection({ id: "sub-1", parentId: "root-1" });
    const tabs = [
      makeTab({ id: "a", sectionId: "sub-1" }),
      makeTab({ id: "b", sectionId: "sub-1" }),
      makeTab({ id: "c", sectionId: "root-1" }),
    ];
    const tree = buildClusterTree(tabs, [root, sub], []);
    expect(tree.roots[0].weight).toBe(3);
    expect(tree.roots[0].children[0].weight).toBe(2);
  });

  it("is deterministic: identical input produces a structurally identical tree", () => {
    const root = makeSection({ id: "root-1", parentId: null });
    const sub = makeSection({ id: "sub-1", parentId: "root-1" });
    const tabs = [
      makeTab({ id: "a", sectionId: "sub-1" }),
      makeTab({ id: "b", category: "news" }),
      makeTab({ id: "c" }),
    ];
    const treeA = buildClusterTree(tabs, [root, sub], []);
    const treeB = buildClusterTree(tabs, [root, sub], []);
    const idsA = treeA.roots.map((r) => r.id).sort();
    const idsB = treeB.roots.map((r) => r.id).sort();
    expect(idsA).toEqual(idsB);
  });

  it("never drops a tab with a dangling sectionId and no legacy category", () => {
    const tabs = [makeTab({ id: "a", sectionId: "ghost" })];
    const tree = buildClusterTree(tabs, [], []);
    const allTabIds = tree.roots.flatMap((r) => r.totalTabIds);
    expect(allTabIds).toEqual(["a"]);
  });
});

describe("computeClusterAnchors", () => {
  it("is deterministic across repeated calls on the same tree", () => {
    const tabs = [makeTab({ id: "a", category: "research" }), makeTab({ id: "b", category: "news" })];
    const tree = buildClusterTree(tabs, [], []);
    const anchorsA = computeClusterAnchors(tree);
    const anchorsB = computeClusterAnchors(tree);
    expect(anchorsA.get("a")).toEqual(anchorsB.get("a"));
    expect(anchorsA.get("b")).toEqual(anchorsB.get("b"));
  });

  it("gives every root category a distinct anchor across many categories", () => {
    const tabs = Array.from({ length: 8 }, (_, i) => makeTab({ id: `t${i}`, category: `cat${i}` }));
    const tree = buildClusterTree(tabs, [], []);
    const anchors = computeClusterAnchors(tree);
    const points = tabs.map((t) => anchors.get(t.id)!.categoryAnchor!);
    const keys = new Set(points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    expect(keys.size).toBe(points.length);
  });

  it("leaves subcategoryAnchor null for a tab with no subcategory", () => {
    const tabs = [makeTab({ id: "a", category: "research" })];
    const tree = buildClusterTree(tabs, [], []);
    const anchors = computeClusterAnchors(tree);
    expect(anchors.get("a")!.subcategoryAnchor).toBeNull();
    expect(anchors.get("a")!.categoryAnchor).not.toBeNull();
  });
});
