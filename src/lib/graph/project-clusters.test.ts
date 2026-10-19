/**
 * Regression: the Graph grouped every project's unorganized sources under one
 * global "Other" cluster. A source added to a project (a PDF, an upload, a page
 * on a site the URL classifier doesn't recognise) has no section and no
 * confident category, and the cluster fallback for that case ignored the
 * project holding the tab. These tests drive the same input builder the Graph
 * View and its pre-open settle both use (resolveGraphLayoutInput), from a real
 * workspace store, so they cover what the canvas actually labels.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import { ingestResources } from "@/lib/resources/ingest";
import { ensureSectionsSeededInStore, syncSectionsWithCategoriesInStore } from "@/lib/sections/migrate";
import { clearWorkspaceStore, loadWorkspaceStore, saveWorkspaceStore } from "@/lib/workspace/persistence";
import { buildClusterTree, resolveCategoryKey, type ClusterTree } from "./clusters";
import { buildGraphEdges, buildWorkspaceLookup } from "./relations";
import { resolveGraphLayoutInput } from "./precompute";
import { defaultGraphState } from "./persistence";
import { DEFAULT_CONNECTION_FILTERS } from "./types";

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://${overrides.id}.example.com`,
    normalizedUrl: `https://${overrides.id}.example.com`,
    domain: `${overrides.id}.example.com`,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> & { id: string; name: string }): Workspace {
  return { tabs: [], sections: [], createdAt: 0, updatedAt: 0, ...overrides };
}

const historySection: Section = {
  id: "hist-source-analysis",
  parentId: null,
  name: "Source Analysis",
  source: "user",
  createdAt: 0,
  updatedAt: 0,
};

function studentStore(): WorkspaceStore {
  return {
    version: 1,
    currentId: "math",
    workspaces: [
      makeWorkspace({
        id: "math",
        name: "Mathematics AA HL",
        tabs: [makeTab({ id: "m1", category: "other" }), makeTab({ id: "m2" })],
      }),
      makeWorkspace({
        id: "hist",
        name: "History HL",
        sections: [historySection],
        tabs: [makeTab({ id: "h1" }), makeTab({ id: "h2", sectionId: historySection.id })],
      }),
    ],
  };
}

function treeFor(store: WorkspaceStore, workspaceFilter: string | "all" = "all"): ClusterTree {
  const state = defaultGraphState();
  state.settings.workspaceFilter = workspaceFilter;
  return resolveGraphLayoutInput(store.workspaces, [], [], state).clusterTree;
}

function labelOf(tree: ClusterTree, tabId: string): string | undefined {
  const rootId = tree.clusterPathOfTab.get(tabId)?.[0];
  return rootId ? tree.byId.get(rootId)?.label : undefined;
}

function rootLabels(tree: ClusterTree): string[] {
  return tree.roots.map((root) => root.label).sort();
}

afterEach(() => {
  clearWorkspaceStore();
});

describe("graph project association", () => {
  it("groups a Mathematics AA HL source under Mathematics AA HL, not Other", () => {
    const tree = treeFor(studentStore());
    expect(labelOf(tree, "m1")).toBe("Mathematics AA HL");
    expect(labelOf(tree, "m2")).toBe("Mathematics AA HL");
    expect(rootLabels(tree)).not.toContain("Other");
  });

  it("groups a History HL source under History HL and keeps its sectioned tabs where they were", () => {
    const tree = treeFor(studentStore());
    expect(labelOf(tree, "h1")).toBe("History HL");
    expect(labelOf(tree, "h2")).toBe("Source Analysis");
  });

  it("never pools two projects' unorganized sources into one cluster", () => {
    const tree = treeFor(studentStore());
    expect(tree.clusterPathOfTab.get("m1")?.[0]).toBe(tree.clusterPathOfTab.get("m2")?.[0]);
    expect(tree.clusterPathOfTab.get("m1")?.[0]).not.toBe(tree.clusterPathOfTab.get("h1")?.[0]);
  });

  it("keeps Other only for a tab no project holds", () => {
    const store = studentStore();
    const lookup = buildWorkspaceLookup(store.workspaces);
    const orphan = makeTab({ id: "orphan" });
    const tree = buildClusterTree([...store.workspaces.flatMap((w) => w.tabs), orphan], [historySection], [], lookup);
    expect(labelOf(tree, "orphan")).toBe("Other");
    expect(labelOf(tree, "m1")).toBe("Mathematics AA HL");
    expect(resolveCategoryKey(orphan, [], lookup)).toBe("legacy:other");
  });

  it("keeps a tab's confident legacy category ahead of its project", () => {
    const store: WorkspaceStore = {
      version: 1,
      currentId: "math",
      // `sections` undefined: a workspace saved before sections existed.
      workspaces: [{ id: "math", name: "Mathematics AA HL", tabs: [makeTab({ id: "s1", category: "school" })], createdAt: 0, updatedAt: 0 }],
    };
    expect(labelOf(treeFor(store), "s1")).toBe("School");
  });

  it("labels a project with a blank name the way the rest of the app does", () => {
    const store = studentStore();
    store.workspaces[0] = { ...store.workspaces[0]!, name: "   " };
    expect(labelOf(treeFor(store), "m1")).toBe("Untitled project");
  });

  it("follows a project rename", () => {
    const store = studentStore();
    store.workspaces[0] = { ...store.workspaces[0]!, name: "Maths AA HL" };
    expect(labelOf(treeFor(store), "m1")).toBe("Maths AA HL");
  });

  it("uses the project when a tab's section was deleted", () => {
    const store = studentStore();
    store.workspaces[0] = {
      ...store.workspaces[0]!,
      tabs: [makeTab({ id: "m3", sectionId: "deleted-section" })],
    };
    expect(labelOf(treeFor(store), "m3")).toBe("Mathematics AA HL");
  });

  it("does not break on a deleted project: its tabs leave the graph and a stale filter yields an empty graph", () => {
    const store = studentStore();
    const withoutMath: WorkspaceStore = { ...store, workspaces: store.workspaces.filter((w) => w.id !== "math") };
    const tree = treeFor(withoutMath);
    expect(tree.clusterPathOfTab.has("m1")).toBe(false);
    expect(rootLabels(tree)).toEqual(["History HL", "Source Analysis"]);
    expect(treeFor(withoutMath, "math").roots).toEqual([]);
  });

  it("labels a source newly added to a project with that project", () => {
    const added = ingestResources(
      studentStore(),
      "math",
      [{ url: "https://files.example.org/paper-1-markscheme.pdf", title: "Paper 1 markscheme" }],
      "manual",
      1
    );
    expect(added).not.toBeNull();
    const store = syncSectionsWithCategoriesInStore(added!.store);
    const tabId = added!.plan.outcomes[0]!.status === "added" ? added!.plan.outcomes[0]!.tabId : "";
    const tab = store.workspaces[0]!.tabs.find((t) => t.id === tabId);
    // Precondition: this is the unorganized case the bug was about.
    expect(tab?.sectionId).toBeUndefined();
    expect(labelOf(treeFor(store), tabId)).toBe("Mathematics AA HL");
  });

  it("gives the same groups after the store is saved and loaded again", () => {
    const before = treeFor(studentStore());
    expect(saveWorkspaceStore(studentStore())).toBe(true);
    const loaded = loadWorkspaceStore();
    expect(loaded).not.toBeNull();
    // The same load-time passes AppShell runs before the graph can open.
    const after = treeFor(syncSectionsWithCategoriesInStore(ensureSectionsSeededInStore(loaded!)));
    expect([...after.clusterPathOfTab.entries()]).toEqual([...before.clusterPathOfTab.entries()]);
    expect(rootLabels(after)).toEqual(rootLabels(before));
  });

  it("keeps category edges inside a project and leaves the other relationships untouched", () => {
    const store = studentStore();
    const lookup = buildWorkspaceLookup(store.workspaces);
    const tabs = store.workspaces.flatMap((w) => w.tabs);
    const filters = { ...DEFAULT_CONNECTION_FILTERS, category: true };
    const edges = buildGraphEdges(tabs, lookup, filters, [], [historySection]);
    const crossProjectCategory = edges.filter(
      (e) => e.reasons.includes("category") && lookup.get(e.source)?.id !== lookup.get(e.target)?.id
    );
    expect(crossProjectCategory).toEqual([]);
    const mathPair = edges.find((e) => e.id === "m1::m2");
    expect(mathPair?.reasons).toEqual(expect.arrayContaining(["workspace", "category"]));
    expect(edges.find((e) => e.id === "h1::h2")?.reasons).toContain("workspace");
  });
});
