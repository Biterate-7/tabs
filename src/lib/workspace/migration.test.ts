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

/**
 * A load-time failure must never cost the user their workspaces.
 *
 * loadWorkspaceStore() answers null for three different situations — no
 * store, an unreadable store, and (until this was fixed) a store that threw
 * while being REPAIRED. migrateToWorkspaceStore treats null as "first run"
 * and replaces everything with a fresh default workspace, so that third
 * case silently destroyed a present, valid store.
 *
 * The reproduction is not hypothetical. isValidWorkspace checks id, name,
 * tabs, createdAt and updatedAt — it says nothing about `sections`. A store
 * whose sections is not an array therefore passes validation and then throws
 * inside the repair pass, which is exactly the shape that turns a valid
 * store into "no store".
 *
 * persistence.ts already states the rule this restores: "Repair, never
 * reject ... refusing the whole store would turn one bad value into a user
 * losing all their workspaces, which is a worse outcome than the thing being
 * defended against."
 */
describe("a store that survives validation but breaks repair", () => {
  /** Valid by isValidWorkspaceStore's rules; `sections` is the wrong type. */
  function seedStoreWithUnrepairableWorkspace() {
    window.localStorage.setItem(
      "tabdump:workspaces:v1",
      JSON.stringify({
        version: 1,
        currentId: "w1",
        workspaces: [
          {
            id: "w1",
            name: "Research",
            createdAt: 1,
            updatedAt: 2,
            sections: { not: "an array" },
            tabs: [
              { id: "t1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com" },
              { id: "t2", url: "https://b.com", normalizedUrl: "https://b.com", domain: "b.com" },
            ],
          },
        ],
      })
    );
  }

  it("still loads the store rather than reporting no store at all", () => {
    seedStoreWithUnrepairableWorkspace();
    const store = loadWorkspaceStore();
    expect(store).not.toBeNull();
    expect(store!.workspaces).toHaveLength(1);
    expect(store!.workspaces[0].tabs).toHaveLength(2);
  });

  it("is not replaced by a fresh default workspace", () => {
    seedStoreWithUnrepairableWorkspace();
    const store = migrateToWorkspaceStore();
    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0].id).toBe("w1");
    expect(store.workspaces[0].name).toBe("Research");
    expect(store.workspaces[0].name).not.toBe(DEFAULT_WORKSPACE_NAME);
  });

  it("does not overwrite the stored copy with a default", () => {
    seedStoreWithUnrepairableWorkspace();
    migrateToWorkspaceStore();
    const onDisk = JSON.parse(window.localStorage.getItem("tabdump:workspaces:v1")!);
    expect(onDisk.workspaces).toHaveLength(1);
    expect(onDisk.workspaces[0].id).toBe("w1");
    expect(onDisk.workspaces[0].tabs).toHaveLength(2);
  });

  /** The behaviour that must NOT change: a genuinely absent store still gets a default. */
  it("still creates a default workspace when there is genuinely no store", () => {
    const store = migrateToWorkspaceStore();
    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0].name).toBe(DEFAULT_WORKSPACE_NAME);
  });

  /** And an unreadable store is still not silently trusted. */
  it("still falls back to a default when the stored JSON is corrupt", () => {
    window.localStorage.setItem("tabdump:workspaces:v1", "{ not json");
    const store = migrateToWorkspaceStore();
    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0].name).toBe(DEFAULT_WORKSPACE_NAME);
  });
});
