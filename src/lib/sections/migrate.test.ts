import { describe, expect, it } from "vitest";
import { applyCategoryChange, ensureSectionsSeeded, ensureSectionsSeededInStore, syncSectionsWithCategories, syncSectionsWithCategoriesInStore } from "./migrate";
import type { Section } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return { url: "https://example.com", normalizedUrl: "https://example.com", domain: "example.com", ...over };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "General", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

describe("applyCategoryChange", () => {
  it("clears sectionId/organizationStatus/organizationReason so syncSectionsWithCategories re-syncs to the new category", () => {
    const tab = makeTab({
      id: "1",
      category: "school",
      sectionId: "some-ai-section",
      organizationStatus: "fallback",
      organizationReason: "Grouped with other tabs that didn't clearly match an existing topic.",
    });

    const changed = applyCategoryChange(tab, "news");

    expect(changed.category).toBe("news");
    expect(changed.sectionId).toBeUndefined();
    expect(changed.organizationStatus).toBeUndefined();
    expect(changed.organizationReason).toBeUndefined();
  });

  it("leaves sectionId alone for a tab the user already manually moved (sectionLocked)", () => {
    const tab = makeTab({ id: "1", category: "school", sectionId: "manual-section", sectionLocked: true });

    const changed = applyCategoryChange(tab, "news");

    expect(changed.category).toBe("news");
    expect(changed.sectionId).toBe("manual-section");
  });
});

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

function makeSection(over: Partial<Section> & { id: string }): Section {
  return { parentId: null, name: "Untitled", source: "ai", createdAt: 0, updatedAt: 0, ...over };
}

describe("syncSectionsWithCategories", () => {
  it("creates a root section for a tab whose category has no matching section yet", () => {
    // Reproduces the reported bug: a workspace seeded with only "School",
    // then a tab recategorized (or freshly present) as "projects" without
    // ever going through the async AI/fallback organizer.
    const workspace = makeWorkspace({
      id: "w1",
      sections: [makeSection({ id: "school-1", name: "School" })],
      tabs: [
        makeTab({ id: "1", category: "school", sectionId: "school-1" }),
        makeTab({ id: "2", category: "projects" }),
      ],
    });

    const synced = syncSectionsWithCategories(workspace);

    const names = synced.sections!.map((s) => s.name).sort();
    expect(names).toEqual(["Projects", "School"]);
    const projectsSection = synced.sections!.find((s) => s.name === "Projects")!;
    expect(synced.tabs.find((t) => t.id === "2")!.sectionId).toBe(projectsSection.id);
  });

  it("does not swallow a categorized tab into Other just because its section is stale", () => {
    const workspace = makeWorkspace({
      id: "w1",
      sections: [makeSection({ id: "school-1", name: "School" })],
      tabs: [
        makeTab({ id: "1", category: "creative" }),
        makeTab({ id: "2", category: "news" }),
      ],
    });

    const synced = syncSectionsWithCategories(workspace);
    const names = synced.sections!.map((s) => s.name).sort();
    expect(names).toEqual(["Creative", "News", "School"]);
    expect(synced.tabs.every((t) => t.sectionId !== undefined)).toBe(true);
  });

  it("reuses an existing root section by case-insensitive name instead of creating a duplicate", () => {
    const workspace = makeWorkspace({
      id: "w1",
      sections: [makeSection({ id: "projects-1", name: "projects" })],
      tabs: [makeTab({ id: "1", category: "projects" })],
    });

    const synced = syncSectionsWithCategories(workspace);
    expect(synced.sections).toHaveLength(1);
    expect(synced.tabs[0].sectionId).toBe("projects-1");
  });

  it("never creates a real section for the 'other' category", () => {
    const workspace = makeWorkspace({
      id: "w1",
      sections: [],
      tabs: [makeTab({ id: "1", category: "other" }), makeTab({ id: "2" })],
    });

    const synced = syncSectionsWithCategories(workspace);
    expect(synced.sections).toEqual([]);
    expect(synced.tabs.every((t) => t.sectionId === undefined)).toBe(true);
  });

  it("never touches a tab whose sectionId already resolves, even to a differently-named section", () => {
    const workspace = makeWorkspace({
      id: "w1",
      sections: [makeSection({ id: "custom-1", name: "My Custom Bucket" })],
      tabs: [makeTab({ id: "1", category: "projects", sectionId: "custom-1", sectionLocked: true })],
    });

    const synced = syncSectionsWithCategories(workspace);
    expect(synced).toBe(workspace);
  });

  it("is idempotent and referentially stable when nothing needs fixing", () => {
    const school = makeSection({ id: "school-1", name: "School" });
    const workspace = makeWorkspace({
      id: "w1",
      sections: [school],
      tabs: [makeTab({ id: "1", category: "school", sectionId: "school-1" })],
    });

    expect(syncSectionsWithCategories(workspace)).toBe(workspace);
  });

  it("leaves a workspace with sections === undefined unchanged (seeding runs first)", () => {
    const workspace = makeWorkspace({ id: "w1", tabs: [makeTab({ id: "1", category: "projects" })] });
    expect(syncSectionsWithCategories(workspace)).toBe(workspace);
  });
});

describe("syncSectionsWithCategoriesInStore", () => {
  it("syncs every workspace in the store", () => {
    const store: WorkspaceStore = {
      version: 1,
      currentId: "a",
      workspaces: [
        makeWorkspace({ id: "a", sections: [], tabs: [makeTab({ id: "1", category: "creative" })] }),
        makeWorkspace({ id: "b", sections: [], tabs: [makeTab({ id: "2", category: "news" })] }),
      ],
    };
    const synced = syncSectionsWithCategoriesInStore(store);
    expect(synced.workspaces[0].sections!.map((s) => s.name)).toEqual(["Creative"]);
    expect(synced.workspaces[1].sections!.map((s) => s.name)).toEqual(["News"]);
  });
});
