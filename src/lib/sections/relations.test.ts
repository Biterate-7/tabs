import { describe, expect, it } from "vitest";
import {
  childrenOf,
  createSection,
  deleteSection,
  descendantIds,
  moveSection,
  renameSection,
  rootSections,
  sectionDepth,
  sectionPath,
} from "./relations";
import type { Section } from "./types";

function makeSection(over: Partial<Section> & { id: string }): Section {
  return { parentId: null, name: "Untitled", source: "user", createdAt: 0, updatedAt: 0, ...over };
}

describe("sectionDepth", () => {
  it("is 0 for a root section", () => {
    expect(sectionDepth([makeSection({ id: "a" })], "a")).toBe(0);
  });

  it("counts ancestors for nested sections", () => {
    const a = makeSection({ id: "a" });
    const b = makeSection({ id: "b", parentId: "a" });
    const c = makeSection({ id: "c", parentId: "b" });
    expect(sectionDepth([a, b, c], "c")).toBe(2);
  });

  it("returns -1 for an unknown id", () => {
    expect(sectionDepth([], "missing")).toBe(-1);
  });

  it("does not infinite-loop on a cyclic parentId chain (corrupted data)", () => {
    const a = makeSection({ id: "a", parentId: "b" });
    const b = makeSection({ id: "b", parentId: "a" });
    expect(sectionDepth([a, b], "a")).toBeGreaterThanOrEqual(0);
  });
});

describe("sectionPath", () => {
  it("returns the root-to-leaf chain", () => {
    const a = makeSection({ id: "a", name: "School" });
    const b = makeSection({ id: "b", parentId: "a", name: "Physics" });
    expect(sectionPath([a, b], "b").map((s) => s.name)).toEqual(["School", "Physics"]);
  });

  it("returns an empty array for an unknown id", () => {
    expect(sectionPath([], "missing")).toEqual([]);
  });
});

describe("descendantIds", () => {
  it("collects children and grandchildren, not the node itself", () => {
    const a = makeSection({ id: "a" });
    const b = makeSection({ id: "b", parentId: "a" });
    const c = makeSection({ id: "c", parentId: "b" });
    const sibling = makeSection({ id: "sibling" });
    expect(descendantIds([a, b, c, sibling], "a").sort()).toEqual(["b", "c"]);
  });

  it("does not infinite-loop on a cyclic parentId chain (corrupted data)", () => {
    const a = makeSection({ id: "a", parentId: "b" });
    const b = makeSection({ id: "b", parentId: "a" });
    expect(() => descendantIds([a, b], "a")).not.toThrow();
  });
});

describe("createSection", () => {
  it("creates a root section", () => {
    const result = createSection([], null, "School", "user");
    expect(result?.section.parentId).toBeNull();
    expect(result?.section.name).toBe("School");
    expect(result?.section.source).toBe("user");
  });

  it("trims the name and rejects a blank one", () => {
    expect(createSection([], null, "  Physics  ", "ai")?.section.name).toBe("Physics");
    expect(createSection([], null, "   ", "ai")).toBeNull();
  });

  it("creates a child under an existing section", () => {
    const root = createSection([], null, "School", "user")!;
    const child = createSection(root.sections, root.section.id, "Physics", "ai");
    expect(child?.section.parentId).toBe(root.section.id);
  });

  it("refuses to create a section deeper than MAX_SECTION_DEPTH", () => {
    const root = createSection([], null, "School", "user")!;
    const sub = createSection(root.sections, root.section.id, "Physics", "ai")!;
    const project = createSection(sub.sections, sub.section.id, "S2 Orbit Research", "ai")!;
    const tooDeep = createSection(project.sections, project.section.id, "Nope", "ai");
    expect(tooDeep).toBeNull();
  });

  it("returns null when the parent doesn't exist", () => {
    expect(createSection([], "missing-parent", "Physics", "ai")).toBeNull();
  });

  it("refuses to create a root section named 'Other' (reserved for the synthetic fallback bucket), case-insensitively", () => {
    expect(createSection([], null, "Other", "ai")).toBeNull();
    expect(createSection([], null, "other", "user")).toBeNull();
    expect(createSection([], null, "  OTHER  ", "ai")).toBeNull();
  });

  it("still allows a subsection named 'Other' under a real category — only the root name is reserved", () => {
    const root = createSection([], null, "School", "user")!;
    const sub = createSection(root.sections, root.section.id, "Other", "ai");
    expect(sub?.section.name).toBe("Other");
  });
});

describe("renameSection", () => {
  it("renames the matching section only", () => {
    const a = makeSection({ id: "a", name: "Old" });
    const b = makeSection({ id: "b", name: "Untouched" });
    const renamed = renameSection([a, b], "a", "New");
    expect(renamed.find((s) => s.id === "a")?.name).toBe("New");
    expect(renamed.find((s) => s.id === "b")?.name).toBe("Untouched");
  });

  it("ignores a blank name", () => {
    const a = makeSection({ id: "a", name: "Old" });
    expect(renameSection([a], "a", "   ")[0].name).toBe("Old");
  });
});

describe("deleteSection", () => {
  it("removes the section and reports its id", () => {
    const a = makeSection({ id: "a" });
    const result = deleteSection([a], "a");
    expect(result.sections).toEqual([]);
    expect(result.removedIds).toEqual(["a"]);
  });

  it("cascades to descendants and reports every removed id", () => {
    const a = makeSection({ id: "a" });
    const b = makeSection({ id: "b", parentId: "a" });
    const c = makeSection({ id: "c", parentId: "b" });
    const sibling = makeSection({ id: "sibling" });
    const result = deleteSection([a, b, c, sibling], "a");
    expect(result.sections).toEqual([sibling]);
    expect(result.removedIds.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("moveSection", () => {
  it("re-parents a section", () => {
    const a = makeSection({ id: "a" });
    const b = makeSection({ id: "b" });
    const moved = moveSection([a, b], "b", "a");
    expect(moved?.find((s) => s.id === "b")?.parentId).toBe("a");
  });

  it("refuses to move a section under itself", () => {
    const a = makeSection({ id: "a" });
    expect(moveSection([a], "a", "a")).toBeNull();
  });

  it("refuses to create a cycle (moving a section under its own descendant)", () => {
    const a = makeSection({ id: "a" });
    const b = makeSection({ id: "b", parentId: "a" });
    expect(moveSection([a, b], "a", "b")).toBeNull();
  });

  it("refuses a move that would exceed MAX_SECTION_DEPTH", () => {
    const root = createSection([], null, "School", "user")!;
    const sub = createSection(root.sections, root.section.id, "Physics", "ai")!;
    const project = createSection(sub.sections, sub.section.id, "S2", "ai")!;
    // Moving "Physics" (which has a child "S2") under itself's sibling depth-2 node would push S2 to depth 3.
    const otherRoot = createSection(project.sections, null, "Personal", "user")!;
    const otherSub = createSection(otherRoot.sections, otherRoot.section.id, "OtherSub", "ai")!;
    expect(moveSection(otherSub.sections, sub.section.id, otherSub.section.id)).toBeNull();
  });
});

describe("rootSections / childrenOf", () => {
  it("splits sections by parentage", () => {
    const a = makeSection({ id: "a" });
    const b = makeSection({ id: "b", parentId: "a" });
    const sections = [a, b];
    expect(rootSections(sections)).toEqual([a]);
    expect(childrenOf(sections, "a")).toEqual([b]);
  });
});
