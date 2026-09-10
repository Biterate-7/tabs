import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStorageNamespace } from "@/lib/storage/namespace";
import { loadCollectionState, saveCollectionState } from "@/lib/collections/persistence";
import { loadDependencyState, saveDependencyState } from "@/lib/dependencies/persistence";
import { loadAnonymousWorkspaceStore, loadWorkspaceStore, saveWorkspaceStore } from "./persistence";
import { migrateToWorkspaceStore } from "./migration";
import type { WorkspaceStore } from "./types";

/**
 * The end of the ownership story for a local-first app: TabDump has no
 * server-side workspace to protect, so "user A cannot reach user B's tabs"
 * has to hold at the persistence layer instead. These exercise the real
 * load/save functions, not the key helper underneath them.
 */

const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";

function storeNamed(name: string): WorkspaceStore {
  const now = Date.now();
  return {
    version: 1,
    currentId: "w-1",
    workspaces: [{ id: "w-1", name, tabs: [], createdAt: now, updatedAt: now }],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
});

describe("workspace persistence across accounts", () => {
  it("keeps each account's workspaces to itself", () => {
    setStorageNamespace(ADA);
    saveWorkspaceStore(storeNamed("Ada's research"));

    setStorageNamespace(GRACE);
    expect(loadWorkspaceStore()).toBeNull();

    saveWorkspaceStore(storeNamed("Grace's compilers"));
    expect(loadWorkspaceStore()?.workspaces[0].name).toBe("Grace's compilers");

    setStorageNamespace(ADA);
    expect(loadWorkspaceStore()?.workspaces[0].name).toBe("Ada's research");
  });

  it("hides the signed-out workspace from a signed-in account", () => {
    saveWorkspaceStore(storeNamed("Anonymous"));

    setStorageNamespace(ADA);
    expect(loadWorkspaceStore()).toBeNull();
  });

  it("gives the signed-out workspace straight back after signing out", () => {
    // The promise that adding accounts takes nobody's existing data away.
    saveWorkspaceStore(storeNamed("Anonymous"));

    setStorageNamespace(ADA);
    saveWorkspaceStore(storeNamed("Ada's"));
    setStorageNamespace(null);

    expect(loadWorkspaceStore()?.workspaces[0].name).toBe("Anonymous");
  });

  it("scopes collections and dependencies the same way", () => {
    setStorageNamespace(ADA);
    saveCollectionState({ version: 1, collections: [] });
    saveDependencyState({
      version: 1,
      dependencies: [{ id: "d1", parentTabId: "t1", childTabId: "t2", createdAt: Date.now() }],
    });

    setStorageNamespace(GRACE);
    expect(loadCollectionState().collections).toEqual([]);
    expect(loadDependencyState().dependencies).toEqual([]);

    setStorageNamespace(ADA);
    expect(loadDependencyState().dependencies).toHaveLength(1);
  });

  it("never seeds a new account from the signed-out legacy store", () => {
    // migrateToWorkspaceStore wraps a pre-workspaces `tabdump:workspace:v1`
    // into a default workspace. Scoped, so signing in for the first time
    // starts empty rather than silently inheriting whoever used this
    // browser signed out.
    window.localStorage.setItem(
      "tabdump:workspace:v1",
      JSON.stringify({
        version: 1,
        tabs: [{ id: "t1", url: "https://example.com", normalizedUrl: "example.com", domain: "example.com" }],
      })
    );

    setStorageNamespace(ADA);
    const migrated = migrateToWorkspaceStore();

    expect(migrated.workspaces).toHaveLength(1);
    expect(migrated.workspaces[0].tabs).toEqual([]);
  });

  it("reads the signed-out store on purpose only through the dedicated helper", () => {
    saveWorkspaceStore(storeNamed("Anonymous"));

    setStorageNamespace(ADA);
    expect(loadWorkspaceStore()).toBeNull();
    // The one deliberate exception, for the "bring your data in?" offer.
    expect(loadAnonymousWorkspaceStore()?.workspaces[0].name).toBe("Anonymous");
  });
});
