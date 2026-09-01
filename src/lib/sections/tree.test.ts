import { describe, expect, it } from "vitest";
import { buildSectionTree, findSectionTreeNode, OTHER_SECTION_ID } from "./tree";
import type { Section } from "./types";
import type { Tab } from "@/lib/tabs/types";

function makeSection(over: Partial<Section> & { id: string }): Section {
  return { parentId: null, name: "Untitled", source: "user", createdAt: 0, updatedAt: 0, ...over };
}

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return { url: `https://example.com/${over.id}`, normalizedUrl: `https://example.com/${over.id}`, domain: "example.com", ...over };
}

describe("buildSectionTree", () => {
  it("buckets a tab with no sectionId into the synthetic Other node", () => {
    const tree = buildSectionTree([], [makeTab({ id: "1" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].section.id).toBe(OTHER_SECTION_ID);
    expect(tree[0].tabs).toHaveLength(1);
  });

  it("buckets a tab whose sectionId doesn't resolve into Other too (deleted/corrupt section)", () => {
    const tree = buildSectionTree([], [makeTab({ id: "1", sectionId: "gone" })]);
    expect(tree[0].section.id).toBe(OTHER_SECTION_ID);
    expect(tree[0].tabs).toHaveLength(1);
  });

  it("nests children under their parent and rolls up totalTabCount", () => {
    const root = makeSection({ id: "root", name: "School" });
    const child = makeSection({ id: "child", parentId: "root", name: "Physics" });
    const tabs = [makeTab({ id: "1", sectionId: "child" }), makeTab({ id: "2", sectionId: "root" })];

    const tree = buildSectionTree([root, child], tabs);
    const schoolNode = tree.find((n) => n.section.id === "root")!;

    expect(schoolNode.tabs).toHaveLength(1); // direct only
    expect(schoolNode.totalTabCount).toBe(2); // direct + child
    expect(schoolNode.children).toHaveLength(1);
    expect(schoolNode.children[0].tabs).toHaveLength(1);
  });

  it("always includes Other, pinned last, even when empty", () => {
    const root = makeSection({ id: "root", name: "School" });
    const tree = buildSectionTree([root], [makeTab({ id: "1", sectionId: "root" })]);
    expect(tree[tree.length - 1].section.id).toBe(OTHER_SECTION_ID);
  });

  it("sorts root sections by total tab count, descending", () => {
    const small = makeSection({ id: "small", name: "Small" });
    const big = makeSection({ id: "big", name: "Big" });
    const tabs = [
      makeTab({ id: "1", sectionId: "small" }),
      makeTab({ id: "2", sectionId: "big" }),
      makeTab({ id: "3", sectionId: "big" }),
    ];
    const tree = buildSectionTree([small, big], tabs);
    expect(tree[0].section.id).toBe("big");
    expect(tree[1].section.id).toBe("small");
  });

  it("marks a section with at most one tab as compact presence", () => {
    const root = makeSection({ id: "root", name: "Solo" });
    const tree = buildSectionTree([root], [makeTab({ id: "1", sectionId: "root" })]);
    expect(tree.find((n) => n.section.id === "root")?.presence).toBe("compact");
  });
});

describe("findSectionTreeNode", () => {
  it("finds a root node", () => {
    const tree = buildSectionTree([makeSection({ id: "root" })], []);
    expect(findSectionTreeNode(tree, "root")?.section.id).toBe("root");
  });

  it("finds a nested child node", () => {
    const root = makeSection({ id: "root" });
    const child = makeSection({ id: "child", parentId: "root" });
    const tree = buildSectionTree([root, child], []);
    expect(findSectionTreeNode(tree, "child")?.section.id).toBe("child");
  });

  it("returns undefined for an id that isn't in the tree", () => {
    const tree = buildSectionTree([], []);
    expect(findSectionTreeNode(tree, "missing")).toBeUndefined();
  });
});
