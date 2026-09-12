import { describe, expect, it } from "vitest";
import { applyChanges } from "./apply";
import type { LocalSyncState } from "./apply";
import type { SyncChange } from "./types";
import type { Tab } from "@/lib/tabs/types";

/**
 * The rules that decide whether a server response can cost a user data.
 *
 * Every test here is ultimately one assertion: a pull can add, it can update
 * a named entity, and it can remove an entity the server explicitly
 * tombstoned — and it can do nothing else.
 */

const T0 = 1_700_000_000_000;
const WS = "11111111-1111-4111-8111-111111111111";
const TAB_A = "22222222-2222-4222-8222-222222222222";
const TAB_B = "33333333-3333-4333-8333-333333333333";
const SECTION = "44444444-4444-4444-8444-444444444444";

function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://example.com/${over.id}`,
    normalizedUrl: `https://example.com/${over.id}`,
    domain: "example.com",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function state(): LocalSyncState {
  return {
    workspace: {
      id: WS,
      name: "Local",
      createdAt: T0,
      updatedAt: T0,
      sections: [{ id: SECTION, parentId: null, name: "Root", source: "ai", createdAt: T0, updatedAt: T0 }],
      groups: [],
      tabs: [tab({ id: TAB_A, title: "Local A" }), tab({ id: TAB_B, title: "Local B" })],
    },
    collections: [],
    dependencies: [],
  };
}

function upsertTab(id: string, over: Record<string, unknown> = {}): SyncChange {
  return {
    operation: "upsert",
    workspaceId: WS,
    cursor: "5",
    entityType: "tab",
    entityId: id,
    entity: { id, url: `https://example.com/${id}`, ...over },
  } as SyncChange;
}

function deleteTab(id: string): SyncChange {
  return {
    operation: "delete",
    workspaceId: WS,
    cursor: "6",
    deletedAt: T0,
    entityType: "tab",
    entityId: id,
  };
}

describe("absence is never deletion", () => {
  it("keeps every local entity when the server sends nothing", () => {
    // The scenario that would empty a user's app if absence were read as
    // deletion: a server that simply has not seen this workspace.
    const before = state();
    const result = applyChanges(before, []);
    expect(result.state.workspace.tabs).toHaveLength(2);
    expect(result.state.workspace.sections).toHaveLength(1);
    expect(result.applied).toBe(0);
  });

  it("keeps local tabs the server never mentions", () => {
    const result = applyChanges(state(), [upsertTab(TAB_A, { title: "Server A" })]);
    // B was not in the response. That is not a statement about B.
    expect(result.state.workspace.tabs.map((t) => t.id).sort()).toEqual([TAB_A, TAB_B].sort());
    expect(result.state.workspace.tabs.find((t) => t.id === TAB_B)?.title).toBe("Local B");
  });

  it("removes a tab only when an explicit tombstone names it", () => {
    const result = applyChanges(state(), [deleteTab(TAB_A)]);
    expect(result.state.workspace.tabs.map((t) => t.id)).toEqual([TAB_B]);
  });

  it("never deletes the workspace itself from a pull", () => {
    const workspaceTombstone: SyncChange = {
      operation: "delete",
      workspaceId: WS,
      cursor: "7",
      deletedAt: T0,
      entityType: "workspace",
      entityId: WS,
    };
    const result = applyChanges(state(), [workspaceTombstone]);
    // Reported for the caller to surface, never acted on silently: removing
    // someone's whole workspace during a background pull is the one outcome
    // this phase exists to prevent.
    expect(result.state.workspace.tabs).toHaveLength(2);
    expect(result.conflicts).toContainEqual({
      entityType: "workspace",
      entityId: WS,
      reason: "local-unsynced-change",
    });
  });
});

describe("applied by identity", () => {
  it("updates only the named tab", () => {
    const result = applyChanges(state(), [upsertTab(TAB_A, { title: "Server A" })]);
    expect(result.state.workspace.tabs.find((t) => t.id === TAB_A)?.title).toBe("Server A");
    expect(result.state.workspace.tabs.find((t) => t.id === TAB_B)?.title).toBe("Local B");
  });

  it("adds an entity this device has never seen", () => {
    const fresh = "55555555-5555-4555-8555-555555555555";
    const result = applyChanges(state(), [upsertTab(fresh, { title: "New" })]);
    expect(result.state.workspace.tabs).toHaveLength(3);
    expect(result.state.workspace.tabs.find((t) => t.id === fresh)?.title).toBe("New");
  });

  it("recomputes the fields the wire deliberately omits", () => {
    const result = applyChanges(state(), [upsertTab(TAB_A, { url: "https://Example.COM/x?b=2&a=1" })]);
    const applied = result.state.workspace.tabs.find((t) => t.id === TAB_A)!;
    // normalizedUrl and domain are derived locally, so a tab that round-trips
    // is indistinguishable from one that never left.
    expect(applied.domain).toBe("example.com");
    expect(applied.normalizedUrl).toBeTruthy();
    expect(applied.url).toBe("https://Example.COM/x?b=2&a=1");
  });

  it("drops a remote tab whose URL the app would refuse to open", () => {
    const result = applyChanges(state(), [upsertTab(TAB_A, { url: "javascript:alert(1)" })]);
    expect(result.rejected).toBe(1);
    // The local tab is untouched rather than replaced by something unsafe.
    expect(result.state.workspace.tabs.find((t) => t.id === TAB_A)?.url).toBe(`https://example.com/${TAB_A}`);
  });
});

describe("a local unsynced edit is never overwritten", () => {
  it("withholds a remote change to a dirty entity and reports it", () => {
    const result = applyChanges(state(), [upsertTab(TAB_A, { title: "Server A" })], new Set([TAB_A]));
    expect(result.state.workspace.tabs.find((t) => t.id === TAB_A)?.title).toBe("Local A");
    expect(result.conflicts).toEqual([
      { entityType: "tab", entityId: TAB_A, reason: "local-unsynced-change" },
    ]);
    expect(result.applied).toBe(0);
  });

  it("withholds a remote deletion of a dirty entity", () => {
    const result = applyChanges(state(), [deleteTab(TAB_A)], new Set([TAB_A]));
    expect(result.state.workspace.tabs).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
  });

  it("still applies clean entities in the same batch", () => {
    const result = applyChanges(
      state(),
      [upsertTab(TAB_A, { title: "Server A" }), upsertTab(TAB_B, { title: "Server B" })],
      new Set([TAB_A])
    );
    expect(result.state.workspace.tabs.find((t) => t.id === TAB_A)?.title).toBe("Local A");
    expect(result.state.workspace.tabs.find((t) => t.id === TAB_B)?.title).toBe("Server B");
    expect(result.applied).toBe(1);
    expect(result.conflicts).toHaveLength(1);
  });
});

describe("purity", () => {
  it("does not mutate the state it is given", () => {
    const before = state();
    const snapshot = JSON.stringify(before);
    applyChanges(before, [upsertTab(TAB_A, { title: "Server" }), deleteTab(TAB_B)]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("produces the same result twice from the same inputs", () => {
    const changes = [upsertTab(TAB_A, { title: "Server" }), deleteTab(TAB_B)];
    const a = applyChanges(state(), changes);
    const b = applyChanges(state(), changes);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
});

describe("other entity types", () => {
  it("upserts and tombstones sections, collections and dependencies by identity", () => {
    const section: SyncChange = {
      operation: "upsert",
      workspaceId: WS,
      cursor: "5",
      entityType: "section",
      entityId: SECTION,
      entity: { id: SECTION, parentId: null, name: "Renamed", source: "user", createdAt: T0, updatedAt: T0 + 1 },
    };
    const dependency: SyncChange = {
      operation: "upsert",
      workspaceId: WS,
      cursor: "5",
      entityType: "dependency",
      parentTabId: TAB_A,
      childTabId: TAB_B,
      entity: { parentTabId: TAB_A, childTabId: TAB_B, createdAt: T0, type: "reference" },
    };

    const result = applyChanges(state(), [section, dependency]);
    expect(result.state.workspace.sections![0].name).toBe("Renamed");
    expect(result.state.dependencies).toHaveLength(1);
    // The dependency's local id is rebuilt from the pair, matching how the
    // client mints it.
    expect(result.state.dependencies[0].id).toBe(`dep-${TAB_A}::${TAB_B}`);

    const removed = applyChanges(result.state, [
      {
        operation: "delete",
        workspaceId: WS,
        cursor: "6",
        deletedAt: T0,
        entityType: "dependency",
        parentTabId: TAB_A,
        childTabId: TAB_B,
      },
    ]);
    expect(removed.state.dependencies).toHaveLength(0);
  });
});
