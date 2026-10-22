import { describe, expect, it } from "vitest";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace } from "@/lib/workspace/types";
import { resolveCategoryKey } from "./clusters";
import { buildWorkspaceLookup } from "./relations";

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

  it("files an unorganized tab under the project that holds it, never one global Other", () => {
    const a = makeTab({ id: "a" });
    const b = makeTab({ id: "b" });
    const workspaces: Workspace[] = [
      { id: "w1", name: "Maths", tabs: [a], createdAt: 0, updatedAt: 0 },
      { id: "w2", name: "History", tabs: [b], createdAt: 0, updatedAt: 0 },
    ];
    const lookup = buildWorkspaceLookup(workspaces);
    expect(resolveCategoryKey(a, [], lookup)).toBe("project:w1");
    expect(resolveCategoryKey(b, [], lookup)).toBe("project:w2");
    // A confident legacy category still wins over the project.
    expect(resolveCategoryKey(makeTab({ id: "c", category: "school" }), [], lookup)).toBe("legacy:school");
  });
});
