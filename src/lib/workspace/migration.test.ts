import { describe, expect, it, beforeEach } from "vitest";
import { migrateToWorkspaceStore, DEFAULT_WORKSPACE_NAME } from "./migration";
import { loadWorkspace, loadWorkspaceStore, saveWorkspace } from "./persistence";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("migrateToWorkspaceStore", () => {
  it("creates a clean empty default workspace for a brand-new user", () => {
    const store = migrateToWorkspaceStore();

    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0].name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(store.workspaces[0].tabs).toEqual([]);
    expect(store.currentId).toBe(store.workspaces[0].id);
  });

  it("wraps existing legacy single-workspace tabs into the default workspace", () => {
    const legacyTabs = [makeTab({ id: "1" }), makeTab({ id: "2" })];
    saveWorkspace(legacyTabs);

    const store = migrateToWorkspaceStore();

    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0].name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(store.workspaces[0].tabs).toEqual(legacyTabs);
  });

  it("removes the legacy key once migrated so no user data lingers in two places", () => {
    saveWorkspace([makeTab({ id: "1" })]);
    migrateToWorkspaceStore();

    expect(loadWorkspace()).toBeNull();
  });

  it("is idempotent: calling it again returns the same store untouched", () => {
    saveWorkspace([makeTab({ id: "1" })]);
    const first = migrateToWorkspaceStore();
    const second = migrateToWorkspaceStore();

    expect(second).toEqual(first);
  });

  it("does not re-migrate legacy data that resurfaces after the store already exists", () => {
    const first = migrateToWorkspaceStore();
    // Simulate stray leftover legacy data (e.g. from an old tab never closed).
    saveWorkspace([makeTab({ id: "stray" })]);

    const second = migrateToWorkspaceStore();

    expect(second).toEqual(first);
    expect(second.workspaces[0].tabs).toEqual([]);
  });

  it("persists the migrated store so a subsequent load sees it", () => {
    saveWorkspace([makeTab({ id: "1" })]);
    const store = migrateToWorkspaceStore();

    expect(loadWorkspaceStore()).toEqual(store);
  });
});
