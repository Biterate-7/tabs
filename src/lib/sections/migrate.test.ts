import { describe, expect, it } from "vitest";
import { ensureSectionsSeeded, ensureSectionsSeededInStore } from "./migrate";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return { url: "https://example.com", normalizedUrl: "https://example.com", domain: "example.com", ...over };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "General", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

describe("ensureSectionsSeeded", () => {
  it("creates one root section per distinct legacy category present", () => {
    const workspace = makeWorkspace({
      id: "w1",
      tabs: [
        makeTab({ id: "1", category: "school" }),
        makeTab({ id: "2", category: "school" }),
        makeTab({ id: "3", category: "research" }),
      ],
    });

    const migrated = ensureSectionsSeeded(workspace);

    expect(migrated.sections).toHaveLength(2);
    const names = migrated.sections!.map((s) => s.name).sort();
    expect(names).toEqual(["Research", "School"]);
    expect(migrated.sections!.every((s) => s.parentId === null && s.source === "ai")).toBe(true);
  });

  it("points each tab's sectionId at its category's new root section", () => {
    const workspace = makeWorkspace({ id: "w1", tabs: [makeTab({ id: "1", category: "school" })] });
    const migrated = ensureSectionsSeeded(workspace);
    const schoolSection = migrated.sections!.find((s) => s.name === "School")!;
    expect(migrated.tabs[0].sectionId).toBe(schoolSection.id);
    expect(migrated.tabs[0].organizationStatus).toBe("classified");
  });

  it("never seeds a real 'Other' section — those tabs are simply left without a sectionId", () => {
    const workspace = makeWorkspace({
      id: "w1",
      tabs: [makeTab({ id: "1" }), makeTab({ id: "2", category: "other" })],
    });
    const migrated = ensureSectionsSeeded(workspace);
    expect(migrated.sections).toEqual([]);
    expect(migrated.tabs.every((t) => t.sectionId === undefined)).toBe(true);
  });

  it("does not create an Other section even alongside other real categories", () => {
    const workspace = makeWorkspace({
      id: "w1",
      tabs: [makeTab({ id: "1", category: "school" }), makeTab({ id: "2", category: "other" })],
    });
    const migrated = ensureSectionsSeeded(workspace);
    expect(migrated.sections!.map((s) => s.name)).toEqual(["School"]);
    expect(migrated.tabs.find((t) => t.id === "2")!.sectionId).toBeUndefined();
  });

  it("is idempotent: a workspace that already has sections (even empty) is returned unchanged", () => {
    const workspace = makeWorkspace({ id: "w1", tabs: [makeTab({ id: "1", category: "school" })], sections: [] });
    expect(ensureSectionsSeeded(workspace)).toBe(workspace);
  });

  it("never touches a tab that already has a sectionId", () => {
    const workspace = makeWorkspace({
      id: "w1",
      tabs: [makeTab({ id: "1", category: "school", sectionId: "manual-section" })],
    });
    const migrated = ensureSectionsSeeded(workspace);
    expect(migrated.tabs[0].sectionId).toBe("manual-section");
  });

  it("produces an empty sections array for a workspace with no tabs", () => {
    const workspace = makeWorkspace({ id: "w1", tabs: [] });
    expect(ensureSectionsSeeded(workspace).sections).toEqual([]);
  });
});

describe("ensureSectionsSeededInStore", () => {
  it("seeds every workspace in the store", () => {
    const store: WorkspaceStore = {
      version: 1,
      currentId: "a",
      workspaces: [
        makeWorkspace({ id: "a", tabs: [makeTab({ id: "1", category: "shopping" })] }),
        makeWorkspace({ id: "b", tabs: [makeTab({ id: "2", category: "news" })] }),
      ],
    };
    const migrated = ensureSectionsSeededInStore(store);
    expect(migrated.workspaces[0].sections).toHaveLength(1);
    expect(migrated.workspaces[1].sections).toHaveLength(1);
  });
});
