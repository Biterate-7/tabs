import { describe, expect, it } from "vitest";
import { buildLegacyIdMap, migrateLegacyWorkspace, needsLegacyMigration } from "./legacy-migration";
import type { LegacyMigrationInput } from "./legacy-migration";
import { isUuid } from "./validation";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { GraphPersistedState } from "@/lib/graph/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import { DEFAULT_GRAPH_SETTINGS } from "@/lib/graph/types";

/**
 * A pre-UUID workspace is the one shape that cannot be uploaded as it
 * stands, and rewriting it touches every reference in the user's data. A
 * mistake here is silent and permanent — a tab pointing at a section id that
 * no longer exists, or two entities collapsed into one — so these are
 * deliberately exhaustive about references.
 */

const T0 = 1_700_000_000_000;

function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com/a",
    normalizedUrl: "https://example.com/a",
    domain: "example.com",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** A workspace entirely in the old id format, with every kind of reference populated. */
function legacyInput(): LegacyMigrationInput {
  const workspace: Workspace = {
    id: "ws-1699123456789-1",
    name: "Research",
    createdAt: T0,
    updatedAt: T0,
    sections: [
      { id: "section-1699123456789-1", parentId: null, name: "Root", source: "ai", createdAt: T0, updatedAt: T0 },
      {
        id: "section-1699123456789-2",
        parentId: "section-1699123456789-1",
        name: "Child",
        source: "user",
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    groups: [{ id: "group-1699123456789-1", name: "Group", createdAt: T0, updatedAt: T0 }],
    tabs: [
      tab({
        id: "tab-1699123456789-1",
        url: "https://example.com/foo_bar",
        sectionId: "section-1699123456789-2",
        groupId: "group-1699123456789-1",
      }),
      tab({ id: "tab-1699123456789-2", url: "https://example.com/foo_bar" }),
      tab({ id: "tab-1699123456789-3", url: "https://other.example/x", sectionId: "section-1699123456789-1" }),
    ],
  };

  const collections: Collection[] = [
    {
      id: "collection-1699123456789-1",
      workspaceId: "ws-1699123456789-1",
      name: "Reading",
      tabIds: ["tab-1699123456789-2", "tab-1699123456789-1"],
      createdAt: T0,
      updatedAt: T0,
    },
  ];

  const dependencies: TabDependency[] = [
    {
      id: "dep-tab-1699123456789-1::tab-1699123456789-3",
      parentTabId: "tab-1699123456789-1",
      childTabId: "tab-1699123456789-3",
      type: "reference",
      createdAt: T0,
      updatedAt: T0,
    },
  ];

  const graph: GraphPersistedState = {
    version: 1,
    positions: { "tab-1699123456789-1": { x: 1, y: 2 }, "tab-1699123456789-3": { x: 3, y: 4 } },
    boundaryOffsets: { "tab-1699123456789-1": { x: 5, y: 6 } },
    manualConnections: [{ a: "tab-1699123456789-1", b: "tab-1699123456789-2", createdAt: T0 }],
    settings: {
      ...DEFAULT_GRAPH_SETTINGS,
      workspaceFilter: "ws-1699123456789-1",
      selectedTabId: "tab-1699123456789-3",
    },
  };

  return { workspace, collections, dependencies, graph };
}

describe("detecting whether migration is needed", () => {
  it("recognises a legacy workspace", () => {
    expect(needsLegacyMigration(legacyInput())).toBe(true);
  });

  it("leaves an all-UUID workspace alone", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const input: LegacyMigrationInput = {
      workspace: { id, name: "W", createdAt: T0, updatedAt: T0, tabs: [] },
      collections: [],
      dependencies: [],
    };
    expect(needsLegacyMigration(input)).toBe(false);
    expect(migrateLegacyWorkspace(input).migrated).toBe(false);
  });
});

describe("the id map is complete before anything is rewritten", () => {
  it("covers the workspace and every entity it owns", () => {
    const input = legacyInput();
    const map = buildLegacyIdMap(input);

    const expected = [
      input.workspace.id,
      ...(input.workspace.sections ?? []).map((s) => s.id),
      ...(input.workspace.groups ?? []).map((g) => g.id),
      ...input.workspace.tabs.map((t) => t.id),
      ...input.collections.map((c) => c.id),
    ];
    for (const id of expected) {
      expect(map.has(id), id).toBe(true);
      expect(isUuid(map.get(id)!), id).toBe(true);
    }
    expect(map.size).toBe(expected.length);
  });

  it("gives every entity a distinct new id", () => {
    const map = buildLegacyIdMap(legacyInput());
    expect(new Set(map.values()).size).toBe(map.size);
  });
});

describe("every reference is remapped", () => {
  const input = legacyInput();
  const result = migrateLegacyWorkspace(input);
  const map = result.idMap;

  it("rewrites the workspace id", () => {
    expect(result.workspace.id).toBe(map.get(input.workspace.id));
    expect(isUuid(result.workspace.id)).toBe(true);
  });

  it("rewrites section ids and the parent link", () => {
    const [root, child] = result.workspace.sections!;
    expect(root.id).toBe(map.get("section-1699123456789-1"));
    expect(root.parentId).toBeNull();
    expect(child.parentId).toBe(map.get("section-1699123456789-1"));
    expect(isUuid(child.parentId!)).toBe(true);
  });

  it("rewrites a tab's section and group references", () => {
    const first = result.workspace.tabs[0];
    expect(first.id).toBe(map.get("tab-1699123456789-1"));
    expect(first.sectionId).toBe(map.get("section-1699123456789-2"));
    expect(first.groupId).toBe(map.get("group-1699123456789-1"));
  });

  it("rewrites collection membership, preserving order", () => {
    const collection = result.collections[0];
    expect(collection.workspaceId).toBe(result.workspace.id);
    expect(collection.tabIds).toEqual([
      map.get("tab-1699123456789-2"),
      map.get("tab-1699123456789-1"),
    ]);
  });

  it("rebuilds a dependency's identity from its new pair", () => {
    const dependency = result.dependencies[0];
    const parent = map.get("tab-1699123456789-1")!;
    const child = map.get("tab-1699123456789-3")!;
    expect(dependency.parentTabId).toBe(parent);
    expect(dependency.childTabId).toBe(child);
    // The client derives the id from the pair, so carrying the old one over
    // would leave an id that disagrees with the columns beside it.
    expect(dependency.id).toBe(`dep-${parent}::${child}`);
    expect(dependency.type).toBe("reference");
  });

  it("rewrites the tab ids embedded in device-local graph state", () => {
    const graph = result.graph!;
    expect(Object.keys(graph.positions)).toEqual([
      map.get("tab-1699123456789-1"),
      map.get("tab-1699123456789-3"),
    ]);
    expect(Object.keys(graph.boundaryOffsets)).toEqual([map.get("tab-1699123456789-1")]);
    expect(graph.manualConnections[0].a).toBe(map.get("tab-1699123456789-1"));
    expect(graph.manualConnections[0].b).toBe(map.get("tab-1699123456789-2"));
    expect(graph.settings.workspaceFilter).toBe(result.workspace.id);
    expect(graph.settings.selectedTabId).toBe(map.get("tab-1699123456789-3"));
  });

  it("leaves no legacy id anywhere in the result", () => {
    // The blunt instrument on purpose: if any reference were missed, its old
    // id would still be somewhere in this JSON.
    const serialized = JSON.stringify({
      workspace: result.workspace,
      collections: result.collections,
      dependencies: result.dependencies,
      graph: result.graph,
    });
    for (const legacyId of map.keys()) {
      expect(serialized, `${legacyId} still present`).not.toContain(legacyId);
    }
    expect(result.unmappableIds).toEqual([]);
  });
});

describe("identity is the id, never the URL", () => {
  it("keeps two tabs with the same URL as two distinct entities", () => {
    const result = migrateLegacyWorkspace(legacyInput());
    const sameUrl = result.workspace.tabs.filter((t) => t.url === "https://example.com/foo_bar");
    expect(sameUrl).toHaveLength(2);
    expect(sameUrl[0].id).not.toBe(sameUrl[1].id);
  });

  it("preserves the URL byte-for-byte, underscores included", () => {
    const result = migrateLegacyWorkspace(legacyInput());
    expect(result.workspace.tabs[0].url).toBe("https://example.com/foo_bar");
  });
});

describe("non-destructive", () => {
  it("does not mutate the input", () => {
    const input = legacyInput();
    const before = JSON.stringify(input);
    migrateLegacyWorkspace(input);
    // The caller keeps the original until the server confirms; a mutation
    // here would destroy the thing they fall back to.
    expect(JSON.stringify(input)).toBe(before);
  });

  it("preserves every entity and every unrelated field", () => {
    const input = legacyInput();
    const result = migrateLegacyWorkspace(input);

    expect(result.workspace.tabs).toHaveLength(input.workspace.tabs.length);
    expect(result.workspace.sections).toHaveLength(input.workspace.sections!.length);
    expect(result.workspace.groups).toHaveLength(input.workspace.groups!.length);
    expect(result.collections).toHaveLength(input.collections.length);
    expect(result.dependencies).toHaveLength(input.dependencies.length);

    expect(result.workspace.name).toBe("Research");
    expect(result.workspace.createdAt).toBe(T0);
    expect(result.workspace.updatedAt).toBe(T0);
    for (const [index, t] of result.workspace.tabs.entries()) {
      expect(t.createdAt).toBe(input.workspace.tabs[index].createdAt);
      expect(t.updatedAt).toBe(input.workspace.tabs[index].updatedAt);
      expect(t.url).toBe(input.workspace.tabs[index].url);
    }
  });

  it("keeps an absent optional absent rather than writing undefined", () => {
    const result = migrateLegacyWorkspace(legacyInput());
    const plain = result.workspace.tabs[1];
    expect("sectionId" in plain).toBe(false);
    expect("groupId" in plain).toBe(false);
  });
});

describe("idempotency", () => {
  it("is a no-op when run against its own output", () => {
    const first = migrateLegacyWorkspace(legacyInput());
    const second = migrateLegacyWorkspace({
      workspace: first.workspace,
      collections: first.collections,
      dependencies: first.dependencies,
      graph: first.graph,
    });

    // Second run finds only UUIDs, so it mints nothing and changes nothing —
    // which is what makes retrying a lost upload safe.
    expect(second.migrated).toBe(false);
    expect(second.workspace).toBe(first.workspace);
    expect(JSON.stringify(second.collections)).toBe(JSON.stringify(first.collections));
    expect(JSON.stringify(second.dependencies)).toBe(JSON.stringify(first.dependencies));
  });

  it("produces stable ids within a single run", () => {
    const result = migrateLegacyWorkspace(legacyInput());
    // The same legacy id referenced from three places resolves to one new id.
    const tabId = result.idMap.get("tab-1699123456789-1")!;
    expect(result.workspace.tabs[0].id).toBe(tabId);
    expect(result.collections[0].tabIds[1]).toBe(tabId);
    expect(result.dependencies[0].parentTabId).toBe(tabId);
    expect(Object.keys(result.graph!.positions)).toContain(tabId);
  });
});

describe("references that cannot be resolved", () => {
  it("reports a dangling legacy reference instead of inventing a target", () => {
    const input = legacyInput();
    const broken: LegacyMigrationInput = {
      ...input,
      workspace: {
        ...input.workspace,
        tabs: [...input.workspace.tabs, tab({ id: "tab-1699123456789-9", sectionId: "section-1699999999999-7" })],
      },
    };
    const result = migrateLegacyWorkspace(broken);
    // Surfaced rather than silently dropped or pointed somewhere invented —
    // validation refuses the upload with a precise reason.
    expect(result.unmappableIds).toContain("section-1699999999999-7");
  });
});

describe("mixed workspaces", () => {
  it("migrates only the legacy ids and leaves existing UUIDs identical", () => {
    const uuidTab = "22222222-2222-4222-8222-222222222222";
    const input: LegacyMigrationInput = {
      workspace: {
        id: "ws-1699123456789-1",
        name: "Mixed",
        createdAt: T0,
        updatedAt: T0,
        tabs: [tab({ id: uuidTab }), tab({ id: "tab-1699123456789-1" })],
      },
      collections: [],
      dependencies: [],
    };
    const result = migrateLegacyWorkspace(input);
    // An id that was already a UUID maps to itself: a partially migrated
    // workspace must not have its good ids churned.
    expect(result.idMap.get(uuidTab)).toBe(uuidTab);
    expect(result.workspace.tabs[0].id).toBe(uuidTab);
    expect(isUuid(result.workspace.tabs[1].id)).toBe(true);
    expect(result.workspace.tabs[1].id).not.toBe("tab-1699123456789-1");
  });
});
