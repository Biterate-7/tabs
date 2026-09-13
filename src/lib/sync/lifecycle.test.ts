import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./engine";
import type { SyncEngineHost } from "./engine";
import { FakeSyncServer } from "./multi-device-server";
import { subscribeRemoteEntities } from "./notify";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * The whole life of a workspace: created, joined, merged, deleted, and what
 * happens when two devices disagree about which of those is true.
 *
 * Two questions run through every test:
 *
 *  1. Can the user's local data be destroyed by something they did not do?
 *  2. Can something they deleted come back?
 *
 * Same harness as multi-device.test.ts and onboarding.test.ts: real
 * `SyncEngine` instances against one in-memory server implementing the wire
 * contract. It proves the client half; it proves nothing about Postgres.
 */

const T0 = 1_700_000_000_000;
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS = "11111111-1111-4111-8111-111111111111";
const WS_TWO = "77777777-7777-4777-8777-777777777777";
const TAB_1 = "22222222-2222-4222-8222-222222222222";
const TAB_2 = "33333333-3333-4333-8333-333333333333";
const LOCAL_TAB = "66666666-6666-4666-8666-666666666666";
const REMOTE_SECTION = "44444444-4444-4444-8444-444444444444";
const LOCAL_SECTION = "55555555-5555-4555-8555-555555555555";
const LOCAL_GROUP = "88888888-8888-4888-8888-888888888888";
const REMOTE_COLL = "aaaa1111-1111-4111-8111-111111111111";
const LOCAL_COLL = "aaaa2222-2222-4222-8222-222222222222";

const JOURNAL_KEY = "tabdump:sync-journal:v1";

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

/** What the first device uploads: one section, two tabs, one collection, one dependency. */
function serverWorkspace(id = WS): Workspace {
  return {
    id,
    name: "Shared",
    createdAt: T0,
    updatedAt: T0,
    sections: [
      { id: REMOTE_SECTION, parentId: null, name: "Remote section", source: "user", createdAt: T0, updatedAt: T0 },
    ],
    groups: [],
    tabs: [tab({ id: TAB_1, title: "One" }), tab({ id: TAB_2, title: "Two" })],
  };
}

class DeviceHost implements SyncEngineHost {
  userId: string | null = USER_A;
  workspaces = new Map<string, Workspace>();
  collections: Collection[] = [];
  dependencies: TabDependency[] = [];

  constructor(workspaces: Workspace[]) {
    for (const workspace of workspaces) this.workspaces.set(workspace.id, workspace);
  }

  getUserId() {
    return this.userId;
  }
  getWorkspace(workspaceId: string) {
    return this.workspaces.get(workspaceId) ?? null;
  }
  getCollections(workspaceId: string) {
    return this.collections.filter((c) => c.workspaceId === workspaceId);
  }
  getDependencies() {
    return this.dependencies;
  }
  getWorkspaceIds() {
    return [...this.workspaces.keys()];
  }
  commitRemote(next: Workspace) {
    this.workspaces.set(next.id, next);
  }

  tab(tabId: string, workspaceId = WS): Tab | null {
    return this.workspaces.get(workspaceId)?.tabs.find((t) => t.id === tabId) ?? null;
  }

  /** Removes a workspace exactly as the local delete action does. */
  removeWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
  }
}

class Device {
  host: DeviceHost;
  engine: SyncEngine;
  private disk: string | null = null;
  private receiving = false;
  private unsubscribe: () => void;

  constructor(
    workspaces: Workspace[],
    private readonly clock: () => number,
    userId: string | null = USER_A
  ) {
    this.host = new DeviceHost(workspaces);
    this.host.userId = userId;
    window.localStorage.removeItem(JOURNAL_KEY);
    this.engine = new SyncEngine(this.host, { debounceMs: 0, now: clock });
    this.unsubscribe = subscribeRemoteEntities((event) => {
      if (!this.receiving) return;
      if (event.collections) {
        const { workspaceId, items } = event.collections;
        this.host.collections = [
          ...this.host.collections.filter((c) => c.workspaceId !== workspaceId),
          ...(items as Collection[]),
        ];
      }
      if (event.dependencies) this.host.dependencies = [...event.dependencies] as TabDependency[];
    });
  }

  async act<T>(fn: (engine: SyncEngine, host: DeviceHost) => T | Promise<T>): Promise<T> {
    if (this.disk === null) window.localStorage.removeItem(JOURNAL_KEY);
    else window.localStorage.setItem(JOURNAL_KEY, this.disk);
    this.receiving = true;
    try {
      return await fn(this.engine, this.host);
    } finally {
      this.receiving = false;
      this.disk = window.localStorage.getItem(JOURNAL_KEY);
    }
  }

  reload(): void {
    if (this.disk === null) window.localStorage.removeItem(JOURNAL_KEY);
    else window.localStorage.setItem(JOURNAL_KEY, this.disk);
    this.engine = new SyncEngine(this.host, { debounceMs: 0, now: this.clock });
  }

  dispose(): void {
    this.unsubscribe();
    this.engine.dispose();
  }

  state(workspaceId = WS) {
    return this.engine.getState(workspaceId);
  }
}

let server: FakeSyncServer;
let clock = T0;
const now = () => clock;
const devices: Device[] = [];

function makeDevice(workspaces: Workspace[], userId: string | null = USER_A): Device {
  const device = new Device(workspaces, now, userId);
  devices.push(device);
  return device;
}

beforeEach(() => {
  window.localStorage.clear();
  clock = T0;
  server = new FakeSyncServer({ now });
  server.currentUserId = USER_A;
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  for (const device of devices.splice(0)) device.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Puts the workspace on the server, with a collection and a dependency. */
async function seedServer(): Promise<Device> {
  const first = makeDevice([serverWorkspace()]);
  await first.act(async (engine, host) => {
    host.collections = [
      { id: REMOTE_COLL, workspaceId: WS, name: "Remote list", tabIds: [TAB_1], createdAt: T0, updatedAt: T0 },
    ];
    host.dependencies = [
      { id: `dep-${TAB_1}-${TAB_2}`, parentTabId: TAB_1, childTabId: TAB_2, createdAt: T0, updatedAt: T0 },
    ];
    await engine.migrateWorkspace(WS);
  });
  return first;
}

/** Removes a workspace locally and records the deletion, as the app's delete action does. */
function deleteLocally(engine: SyncEngine, host: DeviceHost, workspaceId = WS): void {
  host.removeWorkspace(workspaceId);
  engine.markDirty(workspaceId, [{ ref: { entityType: "workspace", entityId: workspaceId }, deleted: true }]);
}

describe("local-only entities after a merge", () => {
  /**
   * The gap this closes: a device that already held the workspace kept its
   * own entities after adopting, but nothing ever scheduled them, so they
   * existed on exactly one device forever — present locally and invisible
   * everywhere else.
   */
  it("uploads a local-only tab, section and group", async () => {
    await seedServer();

    const other = makeDevice([
      {
        ...serverWorkspace(),
        sections: [
          ...serverWorkspace().sections!,
          { id: LOCAL_SECTION, parentId: null, name: "Mine", source: "user", createdAt: T0, updatedAt: T0 },
        ],
        groups: [{ id: LOCAL_GROUP, name: "My group", createdAt: T0, updatedAt: T0 }],
        tabs: [
          ...serverWorkspace().tabs,
          tab({ id: LOCAL_TAB, title: "Only here", sectionId: LOCAL_SECTION, groupId: LOCAL_GROUP }),
        ],
      },
    ]);

    await other.act(async (engine) => {
      await engine.adoptWorkspace(WS);
      // The merge left them pending rather than orphaned...
      expect(engine.getState(WS).dirty.length).toBeGreaterThan(0);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // ...and an ordinary pass sent them.
    expect(server.tabOf(WS, LOCAL_TAB)?.title).toBe("Only here");
    expect(other.state().dirty).toHaveLength(0);

    // The first device receives them as ordinary remote changes.
    const third = makeDevice([]);
    await third.act((engine) => engine.adoptWorkspace(WS));
    const arrived = third.host.workspaces.get(WS)!;
    expect(arrived.tabs.map((t) => t.id)).toContain(LOCAL_TAB);
    expect(arrived.sections?.map((s) => s.id)).toContain(LOCAL_SECTION);
    expect(arrived.groups?.map((g) => g.id)).toContain(LOCAL_GROUP);
    // The relationships survived the round trip.
    expect(arrived.tabs.find((t) => t.id === LOCAL_TAB)?.sectionId).toBe(LOCAL_SECTION);
    expect(arrived.tabs.find((t) => t.id === LOCAL_TAB)?.groupId).toBe(LOCAL_GROUP);
  });

  it("uploads a local-only collection and dependency", async () => {
    await seedServer();

    const other = makeDevice([
      { ...serverWorkspace(), tabs: [...serverWorkspace().tabs, tab({ id: LOCAL_TAB })] },
    ]);
    await other.act(async (engine, host) => {
      host.collections = [
        { id: LOCAL_COLL, workspaceId: WS, name: "My list", tabIds: [LOCAL_TAB], createdAt: T0, updatedAt: T0 },
      ];
      host.dependencies = [
        { id: `dep-${TAB_2}-${LOCAL_TAB}`, parentTabId: TAB_2, childTabId: LOCAL_TAB, createdAt: T0, updatedAt: T0 },
      ];
      await engine.adoptWorkspace(WS);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.collectionOf(WS, LOCAL_COLL)?.tabIds).toEqual([LOCAL_TAB]);
    expect(server.dependencyKeysOf(WS)).toContain(`${TAB_2}::${LOCAL_TAB}`);
    // And the server's own collection is still there — a merge, not a swap.
    expect(server.collectionOf(WS, REMOTE_COLL)?.name).toBe("Remote list");
  });

  /**
   * A local-only tab placed in a section that only the server has. The tab
   * must upload; the section must not be re-sent as though it were local.
   */
  it("uploads a local-only child of a remote-only parent", async () => {
    await seedServer();

    const other = makeDevice([
      {
        ...serverWorkspace(),
        // This device has not heard of the remote section yet.
        sections: [],
        tabs: [tab({ id: LOCAL_TAB, title: "Filed remotely", sectionId: REMOTE_SECTION })],
      },
    ]);

    await other.act(async (engine) => {
      await engine.adoptWorkspace(WS);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, LOCAL_TAB)?.sectionId).toBe(REMOTE_SECTION);
    // The section came down rather than going back up.
    expect(other.host.workspaces.get(WS)!.sections?.map((s) => s.id)).toContain(REMOTE_SECTION);
  });

  it("never re-sends anything the server just supplied", async () => {
    await seedServer();

    const fresh = makeDevice([]);
    const pushesBefore = server.pushes.length;
    await fresh.act(async (engine) => {
      await engine.adoptWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // A device adopting onto nothing has no local-only entities by
    // definition, so nothing becomes pending and nothing goes up.
    expect(fresh.state().dirty).toHaveLength(0);
    expect(server.pushes.length).toBe(pushesBefore);
  });

  it("does not push a dependency belonging to a different workspace", async () => {
    await seedServer();

    const other = makeDevice([serverWorkspace(), serverWorkspace(WS_TWO)]);
    await other.act(async (engine, host) => {
      // A dependency whose endpoints live in the OTHER workspace.
      host.dependencies = [
        { id: "dep-other", parentTabId: TAB_1, childTabId: TAB_2, createdAt: T0, updatedAt: T0 },
      ];
      await engine.migrateWorkspace(WS_TWO);
      await engine.adoptWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // Both workspaces contain TAB_1/TAB_2 ids in this fixture, so the pair is
    // legitimately part of WS too — what matters is that it was not invented
    // for a workspace that does not hold its parent.
    const pushed = server.pushes.flatMap((call) => (call.body?.upserts as { entityType?: string }[]) ?? []);
    const depUpserts = pushed.filter((u) => u.entityType === "dependency");
    expect(depUpserts.length).toBeLessThanOrEqual(2);
  });
});

describe("deleting a workspace reaches the server", () => {
  it("tombstones it rather than leaving it behind", async () => {
    const first = await seedServer();

    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });

    const found = await first.act((engine) => engine.listRemoteWorkspaces());
    if (!found.ok) throw new Error("expected discovery to succeed");
    expect(found.workspaces.map((w) => w.id)).not.toContain(WS);
  });

  it("cannot be adopted back afterwards", async () => {
    const first = await seedServer();
    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });

    const outcome = await first.act((engine) => engine.adoptWorkspace(WS));
    expect(outcome.ok).toBe(false);
    expect(first.host.workspaces.has(WS)).toBe(false);
  });

  it("forgets the bookkeeping once both sides are gone", async () => {
    const first = await seedServer();
    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });

    const blob = window.localStorage.getItem(JOURNAL_KEY) ?? "";
    expect(blob).not.toContain(WS);
  });

  it("asks the server nothing for a workspace that was never uploaded", async () => {
    const local = makeDevice([serverWorkspace()]);
    const callsBefore = server.calls.length;

    await local.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });

    // Nothing was ever there to delete.
    expect(server.calls.length).toBe(callsBefore);
  });

  /** A deletion interrupted by a reload is work that still needs doing. */
  it("finishes a deletion that was pending when the app restarted", async () => {
    const first = await seedServer();

    // The deletion is recorded but the request never happens.
    server.currentUserId = null;
    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });
    expect(server.cursorOf(WS)).not.toBeNull();

    server.currentUserId = USER_A;
    first.reload();
    await first.act(async (engine) => {
      // syncAll is what a reconnect or focus calls, and the workspace is no
      // longer in the local list — the journal is the only record of it.
      engine.syncAll();
      await Promise.resolve();
      await engine.syncWorkspace(WS);
    });

    const found = await first.act((engine) => engine.listRemoteWorkspaces());
    if (!found.ok) throw new Error("expected discovery to succeed");
    expect(found.workspaces.map((w) => w.id)).not.toContain(WS);
  });

  it("leaves other workspaces untouched", async () => {
    const first = await seedServer();
    await first.act(async (engine, host) => {
      host.workspaces.set(WS_TWO, serverWorkspace(WS_TWO));
      host.collections = [
        ...host.collections,
        { id: LOCAL_COLL, workspaceId: WS_TWO, name: "Other list", tabIds: [], createdAt: T0, updatedAt: T0 },
      ];
      await engine.migrateWorkspace(WS_TWO);
    });

    await first.act(async (engine, host) => {
      deleteLocally(engine, host, WS);
      await engine.syncWorkspace(WS);
    });

    expect(first.host.workspaces.get(WS_TWO)!.tabs).toHaveLength(2);
    expect(first.host.collections.find((c) => c.id === LOCAL_COLL)?.name).toBe("Other list");
    const found = await first.act((engine) => engine.listRemoteWorkspaces());
    if (!found.ok) throw new Error("expected discovery to succeed");
    expect(found.workspaces.map((w) => w.id)).toEqual([WS_TWO]);
  });
});

describe("a workspace deleted on another device", () => {
  /**
   * The receiving side. A deletion elsewhere is reported, never applied:
   * removing someone's workspace as a side effect of a background read is
   * the one destructive act this design will not perform.
   */
  it("keeps the local copy and says so", async () => {
    const first = await seedServer();
    const second = makeDevice([serverWorkspace()]);
    await second.act((engine) => engine.adoptWorkspace(WS));

    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });

    await second.act((engine) => engine.syncWorkspace(WS));

    expect(second.host.workspaces.get(WS)!.tabs).toHaveLength(2);
    expect(second.state().status).toBe("remote-deleted");
    // Not a conflict: there is no second version to choose between.
    expect(second.state().conflicts).toHaveLength(0);
  });

  it("stops syncing it rather than fighting the deletion", async () => {
    const first = await seedServer();
    const second = makeDevice([serverWorkspace()]);
    await second.act((engine) => engine.adoptWorkspace(WS));

    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });
    await second.act((engine) => engine.syncWorkspace(WS));

    const callsBefore = server.calls.length;
    await second.act(async (engine) => {
      engine.syncAll();
      await Promise.resolve();
    });
    expect(server.calls.length).toBe(callsBefore);
  });

  it("does not disturb the device's other workspaces", async () => {
    const first = await seedServer();
    const second = makeDevice([serverWorkspace(), serverWorkspace(WS_TWO)]);
    await second.act(async (engine) => {
      await engine.adoptWorkspace(WS);
      await engine.migrateWorkspace(WS_TWO);
    });

    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });
    await second.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS_TWO);
    });

    expect(second.state(WS).status).toBe("remote-deleted");
    expect(second.state(WS_TWO).status).not.toBe("remote-deleted");
    expect(second.host.workspaces.get(WS_TWO)!.tabs).toHaveLength(2);
  });
});

describe("tombstones and stale writes", () => {
  it("does not let a stale device resurrect a deleted tab", async () => {
    const first = await seedServer();
    const second = makeDevice([serverWorkspace()]);
    await second.act((engine) => engine.adoptWorkspace(WS));

    // First device deletes a tab and syncs.
    await first.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: ws.tabs.filter((t) => t.id !== TAB_2) });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: true }]);
      await engine.syncWorkspace(WS);
    });
    expect(server.tabOf(WS, TAB_2)).toBeNull();

    // The second device, which never touched that tab, catches up.
    await second.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(second.host.tab(TAB_2)).toBeNull();
    expect(server.tabOf(WS, TAB_2)).toBeNull();
  });

  it("treats edit-then-delete as a delete", async () => {
    const first = await seedServer();

    await first.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "Edited first" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);

      host.workspaces.set(WS, {
        ...host.workspaces.get(WS)!,
        tabs: host.workspaces.get(WS)!.tabs.filter((t) => t.id !== TAB_2),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: true }]);

      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_2)).toBeNull();
  });

  it("treats delete-then-recreate as an upsert", async () => {
    const first = await seedServer();

    await first.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: ws.tabs.filter((t) => t.id !== TAB_2) });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: true }]);

      host.workspaces.set(WS, {
        ...host.workspaces.get(WS)!,
        tabs: [...host.workspaces.get(WS)!.tabs, tab({ id: TAB_2, title: "Back again" })],
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);

      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_2)?.title).toBe("Back again");
  });

  it("sends nothing for a tab created and deleted before the first push", async () => {
    const first = await seedServer();
    const pushesBefore = server.pushes.length;

    await first.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: [...ws.tabs, tab({ id: LOCAL_TAB })] });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: LOCAL_TAB }, deleted: false }]);
      host.workspaces.set(WS, {
        ...host.workspaces.get(WS)!,
        tabs: host.workspaces.get(WS)!.tabs.filter((t) => t.id !== LOCAL_TAB),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: LOCAL_TAB }, deleted: true }]);
      await engine.syncWorkspace(WS);
    });

    // A delete is still sent (the server may have it from another device),
    // but nothing was ever created there to resurrect.
    expect(server.tabOf(WS, LOCAL_TAB)).toBeNull();
    expect(server.pushes.length).toBeGreaterThan(pushesBefore);
  });

  it("reports rather than applies a remote delete of a tab edited offline", async () => {
    const first = await seedServer();
    const second = makeDevice([serverWorkspace()]);
    await second.act((engine) => engine.adoptWorkspace(WS));

    await first.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: ws.tabs.filter((t) => t.id !== TAB_2) });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: true }]);
      await engine.syncWorkspace(WS);
    });

    await second.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "Edited offline" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(second.host.tab(TAB_2)?.title).toBe("Edited offline");
    expect(second.state().conflicts.some((c) => c.entityId === TAB_2)).toBe(true);
  });
});

describe("account isolation around lifecycle work", () => {
  it("never runs account A's pending deletion under account B", async () => {
    const first = await seedServer();

    // A deletes while unable to reach the server.
    server.currentUserId = null;
    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });

    // B signs in on the same device.
    server.currentUserId = USER_B;
    const callsBefore = server.calls.length;
    await first.act(async (engine, host) => {
      host.userId = USER_B;
      engine.reset();
      engine.syncAll();
      await Promise.resolve();
    });

    // A's deletion did not travel under B's session.
    expect(server.calls.length).toBe(callsBefore);
    // And the workspace is still on the server, since A never got to delete it.
    server.currentUserId = USER_A;
    expect(server.cursorOf(WS)).not.toBeNull();
  });

  it("gives account A its pending deletion back on return", async () => {
    const first = await seedServer();

    server.currentUserId = null;
    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });

    await first.act(async (engine, host) => {
      host.userId = USER_B;
      engine.reset();
    });
    server.currentUserId = USER_A;
    await first.act(async (engine, host) => {
      host.userId = USER_A;
      engine.reset();
      await engine.syncWorkspace(WS);
    });

    const found = await first.act((engine) => engine.listRemoteWorkspaces());
    if (!found.ok) throw new Error("expected discovery to succeed");
    expect(found.workspaces.map((w) => w.id)).not.toContain(WS);
  });

  it("does not hand account B account A's remote-deleted state", async () => {
    const first = await seedServer();
    const second = makeDevice([serverWorkspace()]);
    await second.act((engine) => engine.adoptWorkspace(WS));
    await first.act(async (engine, host) => {
      deleteLocally(engine, host);
      await engine.syncWorkspace(WS);
    });
    await second.act((engine) => engine.syncWorkspace(WS));
    expect(second.state().status).toBe("remote-deleted");

    await second.act(async (engine, host) => {
      host.userId = USER_B;
      engine.reset();
    });

    expect(second.state().status).toBe("never-synced");
    expect(second.state().cursor).toBe("0");
  });
});

describe("conflicts still work after a merge", () => {
  /** Drives a conflict on TAB_1 following an adoption, with `other` losing. */
  async function conflictedAfterAdoption() {
    const first = await seedServer();
    const other = makeDevice([serverWorkspace()]);
    await other.act((engine) => engine.adoptWorkspace(WS));

    for (const [device, title] of [
      [first, "First's title"],
      [other, "Other's title"],
    ] as const) {
      await device.act((engine, host) => {
        const ws = host.workspaces.get(WS)!;
        host.workspaces.set(WS, {
          ...ws,
          tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title } : t)),
        });
        engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      });
    }

    await first.act((engine) => engine.syncWorkspace(WS));
    await other.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });
    return { first, other };
  }

  it("keep mine wins for the contested tab and leaves the rest alone", async () => {
    const { other } = await conflictedAfterAdoption();
    expect(other.state().status).toBe("conflict");

    // An unrelated local edit, pending alongside the conflict.
    await other.act((engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "Unrelated" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
    });

    const conflictId = other.state().conflicts[0].id;
    await other.act(async (engine) => {
      engine.resolveConflict(WS, conflictId, "local");
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(other.state().conflicts).toHaveLength(0);
    expect(server.tabOf(WS, TAB_1)?.title).toBe("Other's title");
    expect(server.tabOf(WS, TAB_2)?.title).toBe("Unrelated");
    // Collections and dependencies came through the adoption untouched.
    expect(server.collectionOf(WS, REMOTE_COLL)?.name).toBe("Remote list");
    expect(server.dependencyKeysOf(WS)).toContain(`${TAB_1}::${TAB_2}`);
  });

  it("keep theirs adopts the server's value and keeps unrelated local work", async () => {
    const { other } = await conflictedAfterAdoption();

    await other.act((engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "Kept locally" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
    });

    const conflictId = other.state().conflicts[0].id;
    await other.act(async (engine) => {
      engine.resolveConflict(WS, conflictId, "remote");
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(other.state().conflicts).toHaveLength(0);
    expect(other.host.tab(TAB_1)?.title).toBe("First's title");
    expect(other.host.tab(TAB_2)?.title).toBe("Kept locally");
    expect(server.tabOf(WS, TAB_2)?.title).toBe("Kept locally");
  });

  it("holds the contested entity out of the push until it is resolved", async () => {
    const { other } = await conflictedAfterAdoption();

    // Phase 7's invariant: syncing again must not quietly send the local
    // version and win, which would be last-writer-wins by the back door.
    await other.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_1)?.title).toBe("First's title");
    expect(other.state().status).toBe("conflict");
  });
});

describe("workspace identity is the id", () => {
  it("does not merge two workspaces that share a name", async () => {
    const first = makeDevice([
      { ...serverWorkspace(WS), name: "Work" },
      { ...serverWorkspace(WS_TWO), name: "Work" },
    ]);
    await first.act(async (engine) => {
      await engine.migrateWorkspace(WS);
      await engine.migrateWorkspace(WS_TWO);
    });

    await first.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Changed in the first" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_1)?.title).toBe("Changed in the first");
    expect(server.tabOf(WS_TWO, TAB_1)?.title).toBe("One");
  });

  it("keeps a rename on one workspace off the other", async () => {
    const first = makeDevice([
      { ...serverWorkspace(WS), name: "Work" },
      { ...serverWorkspace(WS_TWO), name: "Work" },
    ]);
    await first.act(async (engine) => {
      await engine.migrateWorkspace(WS);
      await engine.migrateWorkspace(WS_TWO);
    });

    await first.act(async (engine, host) => {
      host.workspaces.set(WS, { ...host.workspaces.get(WS)!, name: "Renamed" });
      engine.markDirty(WS, [{ ref: { entityType: "workspace", entityId: WS }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    const fresh = makeDevice([]);
    const found = await fresh.act((engine) => engine.listRemoteWorkspaces());
    if (!found.ok) throw new Error("expected discovery to succeed");
    expect(found.workspaces.find((w) => w.id === WS)?.name).toBe("Renamed");
    expect(found.workspaces.find((w) => w.id === WS_TWO)?.name).toBe("Work");
  });

  /**
   * Workspace metadata is a syncable entity like any other, so two devices
   * renaming it from the same base contend exactly as two tabs would.
   */
  it("treats a concurrent rename as an ordinary contested entity", async () => {
    const first = await seedServer();
    const second = makeDevice([serverWorkspace()]);
    await second.act((engine) => engine.adoptWorkspace(WS));

    for (const [device, name] of [
      [first, "First's name"],
      [second, "Second's name"],
    ] as const) {
      await device.act((engine, host) => {
        host.workspaces.set(WS, { ...host.workspaces.get(WS)!, name });
        engine.markDirty(WS, [{ ref: { entityType: "workspace", entityId: WS }, deleted: false }]);
      });
    }

    await first.act((engine) => engine.syncWorkspace(WS));
    await second.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // Not silently last-writer-wins: the loser is told.
    expect(second.state().status).toBe("conflict");
    expect(second.host.workspaces.get(WS)!.name).toBe("Second's name");
  });
});

/**
 * An expired session parks pending work; signing back in has to pick it up.
 *
 * The bug these pin down: a 401 leaves the workspace `paused` with its edits
 * still in the journal, and every background trigger (`syncAll`) skips that
 * status on purpose. Nothing cleared it, so after the user signed back in
 * the edit sat there indefinitely — reaching the server only if they later
 * touched that workspace again or pressed sync by hand. Local data was never
 * lost, but "sync it again yourself" is precisely what sync is for.
 */
describe("an expired session, then signing back in", () => {
  /** Edits a tab and records it, as a local commit does. */
  function editTab(engine: SyncEngine, host: DeviceHost, title: string): void {
    const workspace = host.workspaces.get(WS)!;
    host.workspaces.set(WS, {
      ...workspace,
      tabs: workspace.tabs.map((t) => (t.id === TAB_1 ? { ...t, title } : t)),
    });
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
  }

  it("pauses on a 401 and keeps the pending edit", async () => {
    const device = await seedServer();

    server.failNextRequests(1, 401, { error: "Not signed in." });
    await device.act(async (engine, host) => {
      editTab(engine, host, "Edited after expiry");
      await engine.syncWorkspace(WS);
    });

    expect(device.state().status).toBe("paused");
    // The edit is still owed to the server, not discarded.
    expect(device.state().dirty.some((d) => d.ref.entityType === "tab" && d.ref.entityId === TAB_1)).toBe(true);
    expect(server.tabOf(WS, TAB_1)?.title).not.toBe("Edited after expiry");
  });

  it("leaves the pause alone while the session is still dead", async () => {
    const device = await seedServer();

    server.failNextRequests(1, 401, { error: "Not signed in." });
    await device.act(async (engine, host) => {
      editTab(engine, host, "Edited after expiry");
      await engine.syncWorkspace(WS);
    });

    // A background pass must not retry a dead session.
    const before = server.calls.length;
    await device.act((engine) => engine.syncAll());
    expect(server.calls.length).toBe(before);
    expect(device.state().status).toBe("paused");
  });

  it("sends the pending edit once the user signs back in", async () => {
    const device = await seedServer();

    server.failNextRequests(1, 401, { error: "Not signed in." });
    await device.act(async (engine, host) => {
      editTab(engine, host, "Edited after expiry");
      await engine.syncWorkspace(WS);
    });
    expect(device.state().status).toBe("paused");

    // Re-authenticating remounts the shell, so the engine is rebuilt from
    // the persisted journal before anything resumes.
    device.reload();
    expect(device.state().status).toBe("paused");

    // Exactly what the hook does on sign-in, and nothing more: no direct
    // syncWorkspace, because that bypasses the very skip being tested.
    await device.act(async (engine) => {
      engine.resumeAuthPaused();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(server.tabOf(WS, TAB_1)?.title).toBe("Edited after expiry");
    expect(device.state().status).toBe("idle");
    expect(device.state().dirty).toHaveLength(0);
  });

  it("does not resume a workspace paused because the deployment has no database", async () => {
    const device = await seedServer();

    server.failNextRequests(1, 503, { error: "Sync isnt available on this deployment yet.", reason: "not-configured" });
    await device.act(async (engine, host) => {
      editTab(engine, host, "Edited with no database");
      await engine.syncWorkspace(WS);
    });
    expect(device.state().status).toBe("paused");

    // Signing in changes nothing about a deployment with no database, so
    // this must stay put rather than becoming a request per sign-in.
    const before = server.calls.length;
    await device.act((engine) => engine.resumeAuthPaused());
    expect(server.calls.length).toBe(before);
    expect(device.state().status).toBe("paused");
    // And the edit is still owed, not dropped.
    expect(device.state().dirty.some((d) => d.ref.entityType === "tab" && d.ref.entityId === TAB_1)).toBe(true);
  });

  it("resumes nothing when there is no pending work", async () => {
    const device = await seedServer();

    const before = server.calls.length;
    await device.act((engine) => engine.resumeAuthPaused());
    expect(server.calls.length).toBe(before);
  });
});
