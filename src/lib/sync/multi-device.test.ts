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
 * Two authenticated devices, one account, one workspace.
 *
 * Both devices run the REAL `SyncEngine` against one shared in-memory server
 * that implements the wire contract (see multi-device-server.ts for exactly
 * what it does and does not model). Nothing here proves anything about
 * Postgres; what it proves is that the client half behaves when another
 * device is writing at the same time.
 *
 * The question behind every test is the same: can a second device cost the
 * first one an edit, silently?
 *
 *
 * ## Why the journal is mounted and unmounted around each device's turn
 *
 * `loadJournalStore`/`saveJournalStore` use one fixed localStorage key, so
 * two engines in one jsdom would share a blob they each believe is theirs.
 * Each engine keeps its own in-memory copy and only reads the blob when it
 * is constructed, so their live behaviour is already independent — but a
 * "device reloads" test needs that device's own blob back on disk. `act`
 * therefore mounts a device's disk before its turn and captures it after,
 * which is what a real pair of devices with separate storage would have.
 */

const T0 = 1_700_000_000_000;
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS = "11111111-1111-4111-8111-111111111111";
const WS_OTHER = "77777777-7777-4777-8777-777777777777";
const TAB_1 = "22222222-2222-4222-8222-222222222222";
const TAB_2 = "33333333-3333-4333-8333-333333333333";
const TAB_3 = "66666666-6666-4666-8666-666666666666";
const SECTION_1 = "44444444-4444-4444-8444-444444444444";
const SECTION_2 = "55555555-5555-4555-8555-555555555555";
const GROUP_1 = "88888888-8888-4888-8888-888888888888";
const COLL_1 = "aaaa1111-1111-4111-8111-111111111111";
const COLL_2 = "aaaa2222-2222-4222-8222-222222222222";

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

function baseWorkspace(id = WS): Workspace {
  return {
    id,
    name: "Shared",
    createdAt: T0,
    updatedAt: T0,
    sections: [],
    groups: [],
    tabs: [tab({ id: TAB_1, title: "One" }), tab({ id: TAB_2, title: "Two" })],
  };
}

/** Deep-ish clone so two devices never share a mutable object by accident. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class DeviceHost implements SyncEngineHost {
  userId: string | null = USER_A;
  workspaces = new Map<string, Workspace>();
  collections: Collection[] = [];
  dependencies: TabDependency[] = [];
  remoteCommits = 0;

  constructor(workspace: Workspace) {
    this.workspaces.set(workspace.id, workspace);
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
    this.remoteCommits++;
    this.workspaces.set(next.id, next);
  }

  /** The live tab as this device sees it, or null when it has been removed locally. */
  tab(tabId: string, workspaceId = WS): Tab | null {
    return this.workspaces.get(workspaceId)?.tabs.find((t) => t.id === tabId) ?? null;
  }
}

/** One conceptual device: its own host, its own engine, its own journal blob. */
class Device {
  host: DeviceHost;
  engine: SyncEngine;
  /** This device's private copy of the journal blob. */
  private disk: string | null = null;

  /** Undoes this device's subscription to the remote-entity channel. */
  private unsubscribe: () => void;

  constructor(
    readonly name: string,
    workspace: Workspace,
    private readonly clock: () => number
  ) {
    this.host = new DeviceHost(workspace);
    window.localStorage.removeItem(JOURNAL_KEY);
    this.engine = new SyncEngine(this.host, { debounceMs: 0, now: clock });
    // Collections and dependencies live in their own stores and reach a
    // device through notify.ts rather than through commitRemote — see the
    // note in engine.ts's applyRemote. Standing in for the hooks that own
    // those stores is what makes a pulled collection visible here.
    this.unsubscribe = subscribeRemoteEntities((event) => {
      if (!this.receiving) return;
      // The channel is typed structurally so notify.ts stays free of domain
      // imports (see CollectionLike there); the values the engine publishes
      // are the real objects, so the owning store casts back — exactly what
      // the production hooks do.
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

  /** The channel is global, so only the device currently taking a turn listens. */
  private receiving = false;

  dispose(): void {
    this.unsubscribe();
    this.engine.dispose();
  }

  /** Runs one turn with this device's own journal mounted, then captures it back. */
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

  /** Restarts the app on this device: a fresh engine reading this device's own persisted journal. */
  reload(): void {
    if (this.disk === null) window.localStorage.removeItem(JOURNAL_KEY);
    else window.localStorage.setItem(JOURNAL_KEY, this.disk);
    this.engine = new SyncEngine(this.host, { debounceMs: 0, now: this.clock });
  }

  state(workspaceId = WS) {
    return this.engine.getState(workspaceId);
  }
}

let server: FakeSyncServer;
let clock = T0;
const now = () => clock;

beforeEach(() => {
  window.localStorage.clear();
  clock = T0;
  server = new FakeSyncServer({ now });
  server.currentUserId = USER_A;
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Brings two devices to the same synced starting point.
 *
 * A migrates the workspace (the explicit, user-initiated upload), then B
 * adopts the same server state by migrating too — which the server answers
 * as an idempotent retry once B knows the cursor. This is the "both devices
 * signed in and synced" baseline every scenario starts from.
 */
async function twoSyncedDevices(): Promise<{ a: Device; b: Device }> {
  const a = new Device("A", baseWorkspace(), now);
  await a.act((engine) => engine.migrateWorkspace(WS));

  // B starts from the same local state and pulls the server's stream from
  // the beginning, which is what a second device signing in really does.
  const b = new Device("B", baseWorkspace(), now);
  await b.act(async (engine) => {
    await engine.migrateWorkspace(WS);
    await engine.syncWorkspace(WS);
  });

  return { a, b };
}

describe("two devices, one account", () => {
  it("carries an edit from A to B", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Edited on A" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_1)?.title).toBe("Edited on A");

    await b.act((engine) => engine.syncWorkspace(WS));
    expect(b.host.tab(TAB_1)?.title).toBe("Edited on A");
  });

  it("carries an edit from B to A, the same way in reverse", async () => {
    const { a, b } = await twoSyncedDevices();

    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "Edited on B" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    await a.act((engine) => engine.syncWorkspace(WS));
    expect(a.host.tab(TAB_2)?.title).toBe("Edited on B");
  });

  /**
   * The case that must not be "resolved" by picking a winner.
   *
   * Both devices edit DIFFERENT tabs from the same base. The stale-base gate
   * means the second pusher is told to catch up first — but the outcome that
   * matters is that both edits exist afterwards, with neither overwritten.
   */
  it("keeps both edits when the two devices touch different tabs", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "A's tab" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "B's tab" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
      // First pass hits the stale base and catches up; the second sends it.
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_1)?.title).toBe("A's tab");
    expect(server.tabOf(WS, TAB_2)?.title).toBe("B's tab");

    // And A converges on both without losing its own.
    await a.act((engine) => engine.syncWorkspace(WS));
    expect(a.host.tab(TAB_1)?.title).toBe("A's tab");
    expect(a.host.tab(TAB_2)?.title).toBe("B's tab");
  });

  it("does not report a conflict merely because the other device was busy elsewhere", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: [...ws.tabs, tab({ id: TAB_3, title: "New on A" })] });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_3 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, isFavorite: true } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(b.state().conflicts).toHaveLength(0);
    expect(b.state().status).not.toBe("conflict");
    expect(b.host.tab(TAB_3)?.title).toBe("New on A");
  });
});

describe("the same entity on both devices", () => {
  /**
   * The central concurrency case. Both devices edit TAB_1 from the same
   * base. Exactly one push lands; the loser must end up with an observable,
   * unresolved conflict rather than having its edit silently replaced.
   */
  it("surfaces a conflict instead of letting the later write win", async () => {
    const { a, b } = await twoSyncedDevices();

    const editTab1 = (title: string) => async (engine: SyncEngine, host: DeviceHost) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
    };

    await a.act(editTab1("A's title"));
    await b.act(editTab1("B's title"));

    // A wins the race to the server.
    await a.act((engine) => engine.syncWorkspace(WS));
    expect(server.tabOf(WS, TAB_1)?.title).toBe("A's title");

    // B is stale, catches up, and finds its own unsynced edit on the very
    // tab the server changed.
    await b.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    const state = b.state();
    expect(state.status).toBe("conflict");
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0].entityId).toBe(TAB_1);
    // B's own edit is still on B's device — nothing was overwritten.
    expect(b.host.tab(TAB_1)?.title).toBe("B's title");
    // And the server still holds A's, because B never got to push.
    expect(server.tabOf(WS, TAB_1)?.title).toBe("A's title");
  });

  it("is deterministic — the same race twice produces the same conflict id", async () => {
    const run = async () => {
      window.localStorage.clear();
      server = new FakeSyncServer({ now });
      server.currentUserId = USER_A;
      vi.stubGlobal("fetch", server.fetch);

      const { a, b } = await twoSyncedDevices();
      for (const [device, title] of [
        [a, "A"],
        [b, "B"],
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
      await a.act((engine) => engine.syncWorkspace(WS));
      await b.act(async (engine) => {
        await engine.syncWorkspace(WS);
        await engine.syncWorkspace(WS);
      });
      return b.state().conflicts.map((c) => c.id);
    };

    expect(await run()).toEqual(await run());
  });

  it("does the same for a section", async () => {
    const withSection = (): Workspace => ({
      ...baseWorkspace(),
      sections: [{ id: SECTION_1, parentId: null, name: "Original", source: "user", createdAt: T0, updatedAt: T0 }],
    });

    const a = new Device("A", withSection(), now);
    await a.act((engine) => engine.migrateWorkspace(WS));
    const b = new Device("B", withSection(), now);
    await b.act(async (engine) => {
      await engine.migrateWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    const rename = (name: string) => (engine: SyncEngine, host: DeviceHost) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        sections: (ws.sections ?? []).map((s) => (s.id === SECTION_1 ? { ...s, name } : s)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "section", entityId: SECTION_1 }, deleted: false }]);
    };

    await a.act(rename("A's section"));
    await b.act(rename("B's section"));
    await a.act((engine) => engine.syncWorkspace(WS));
    await b.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(b.state().status).toBe("conflict");
    expect(b.state().conflicts[0].entityId).toBe(SECTION_1);
  });

  it("does the same for a group", async () => {
    const withGroup = (): Workspace => ({
      ...baseWorkspace(),
      groups: [{ id: GROUP_1, name: "Original", createdAt: T0, updatedAt: T0 }],
    });

    const a = new Device("A", withGroup(), now);
    await a.act((engine) => engine.migrateWorkspace(WS));
    const b = new Device("B", withGroup(), now);
    await b.act(async (engine) => {
      await engine.migrateWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    const rename = (name: string) => (engine: SyncEngine, host: DeviceHost) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        groups: (ws.groups ?? []).map((g) => (g.id === GROUP_1 ? { ...g, name } : g)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "group", entityId: GROUP_1 }, deleted: false }]);
    };

    await a.act(rename("A's group"));
    await b.act(rename("B's group"));
    await a.act((engine) => engine.syncWorkspace(WS));
    await b.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(b.state().status).toBe("conflict");
    expect(b.state().conflicts[0].entityId).toBe(GROUP_1);
  });
});

describe("a stale base never overwrites and never half-writes", () => {
  it("refuses the push, keeps the work pending, and succeeds on the retry", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "A first" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    const cursorAfterA = server.cursorOf(WS)!;

    // B edits a different tab against its now-stale cursor.
    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "B second" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
    });

    const before = b.state();
    await b.act((engine) => engine.syncWorkspace(WS));
    const afterStale = b.state();

    // Nothing of B's reached the server on the refused attempt...
    expect(server.tabOf(WS, TAB_2)?.title).not.toBe("B second");
    // ...A's write is intact...
    expect(server.tabOf(WS, TAB_1)?.title).toBe("A first");
    // ...B's pending work survived the refusal...
    expect(afterStale.dirty).toHaveLength(1);
    // ...and it is queued to try again rather than parked as an error.
    expect(afterStale.status).toBe("queued");
    expect(afterStale.cursor >= before.cursor).toBe(true);

    // The retry lands.
    await b.act((engine) => engine.syncWorkspace(WS));
    expect(server.tabOf(WS, TAB_2)?.title).toBe("B second");
    expect(b.state().dirty).toHaveLength(0);
    expect(Number(server.cursorOf(WS))).toBeGreaterThan(Number(cursorAfterA));
  });

  it("never moves a cursor backwards across the whole exchange", async () => {
    const { a, b } = await twoSyncedDevices();
    const seen: number[] = [];

    for (let round = 0; round < 3; round++) {
      for (const [device, tabId] of [
        [a, TAB_1],
        [b, TAB_2],
      ] as const) {
        await device.act(async (engine, host) => {
          const ws = host.workspaces.get(WS)!;
          host.workspaces.set(WS, {
            ...ws,
            tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, title: `r${round}` } : t)),
          });
          engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: tabId }, deleted: false }]);
          await engine.syncWorkspace(WS);
          await engine.syncWorkspace(WS);
          seen.push(Number(engine.getState(WS).cursor));
        });
      }
    }

    const sorted = [...seen].sort((x, y) => x - y);
    expect(seen).toEqual(sorted);
  });
});

describe("a catch-up spanning several pages", () => {
  /**
   * B has been away while A made many separate changes, each its own
   * version. With a page size of one, catching up takes as many round trips
   * as there were versions — and the cursor must walk them in order,
   * skipping nothing and never running past what has actually been applied.
   */
  it("walks every page in order and lands on the server's cursor", async () => {
    server = new FakeSyncServer({ now, pageSize: 1 });
    server.currentUserId = USER_A;
    vi.stubGlobal("fetch", server.fetch);

    const { a, b } = await twoSyncedDevices();

    // Five separate pushes of five DIFFERENT tabs, so five distinct
    // versions each carrying its own row. Five edits to one tab would be
    // a single row at the latest version and so a single page.
    const extras = [
      "aaaabbbb-1111-4111-8111-111111111111",
      "aaaabbbb-2222-4222-8222-222222222222",
      "aaaabbbb-3333-4333-8333-333333333333",
      "aaaabbbb-4444-4444-8444-444444444444",
      "aaaabbbb-5555-4555-8555-555555555555",
    ];
    for (const [index, id] of extras.entries()) {
      await a.act(async (engine, host) => {
        const ws = host.workspaces.get(WS)!;
        host.workspaces.set(WS, { ...ws, tabs: [...ws.tabs, tab({ id, title: `extra ${index}` })] });
        engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: id }, deleted: false }]);
        await engine.syncWorkspace(WS);
      });
    }

    const serverCursor = server.cursorOf(WS)!;
    const pullsBefore = server.pulls.length;

    await b.act((engine) => engine.syncWorkspace(WS));

    // It took more than one page...
    expect(server.pulls.length - pullsBefore).toBeGreaterThan(1);
    // ...the cursors it asked for only ever moved forward...
    const asked = server.pulls
      .slice(pullsBefore)
      .map((call) => Number(new URLSearchParams(call.url.split("?")[1]).get("cursor")));
    expect(asked).toEqual([...asked].sort((x, y) => x - y));
    // ...and it ended up exactly where the server is, having applied the last value.
    expect(b.state().cursor).toBe(serverCursor);
    // Every one of A's tabs arrived, not just the last page's.
    for (const [index, id] of extras.entries()) {
      expect(b.host.tab(id)?.title, id).toBe(`extra ${index}`);
    }
  });

  it("does not advance past changes it could not apply", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "A's change" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    const before = b.state().cursor;

    // The workspace vanishes locally mid-pass, so the apply cannot happen.
    await b.act(async (engine, host) => {
      host.workspaces.delete(WS);
      await engine.syncWorkspace(WS);
    });

    // The cursor stayed put, so the change is fetched again rather than skipped.
    expect(b.state().cursor).toBe(before);
  });
});

describe("deletes do not come back", () => {
  it("does not resurrect a tab another device deleted", async () => {
    const { a, b } = await twoSyncedDevices();

    // A adds a tab and syncs; B picks it up.
    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: [...ws.tabs, tab({ id: TAB_3, title: "Doomed" })] });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_3 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });
    await b.act((engine) => engine.syncWorkspace(WS));
    expect(b.host.tab(TAB_3)).not.toBeNull();

    // B deletes it and syncs.
    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: ws.tabs.filter((t) => t.id !== TAB_3) });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_3 }, deleted: true }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });
    expect(server.tabOf(WS, TAB_3)).toBeNull();

    // A pulls the tombstone and lets the tab go.
    await a.act((engine) => engine.syncWorkspace(WS));
    expect(a.host.tab(TAB_3)).toBeNull();

    // And a further sync does not push it back up from A's stale copy.
    await a.act((engine) => engine.syncWorkspace(WS));
    expect(server.tabOf(WS, TAB_3)).toBeNull();
  });

  it("holds a remote delete back when this device edited the same tab offline", async () => {
    const { a, b } = await twoSyncedDevices();

    // B deletes TAB_1 remotely.
    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: ws.tabs.filter((t) => t.id !== TAB_1) });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: true }]);
      await engine.syncWorkspace(WS);
    });

    // A edited the same tab while it was away.
    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Edited offline" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // The delete is NOT applied silently — A still has its edit and is told.
    expect(a.host.tab(TAB_1)?.title).toBe("Edited offline");
    expect(a.state().status).toBe("conflict");
    expect(a.state().conflicts.some((c) => c.entityId === TAB_1)).toBe(true);
  });

  it("does not resurrect a deleted collection", async () => {
    const { a, b } = await twoSyncedDevices();
    const collection: Collection = {
      id: COLL_1,
      workspaceId: WS,
      name: "Reading",
      tabIds: [TAB_1],
      createdAt: T0,
      updatedAt: T0,
    };

    await a.act(async (engine, host) => {
      host.collections = [clone(collection)];
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });
    await b.act((engine) => engine.syncWorkspace(WS));
    expect(b.host.collections.some((c) => c.id === COLL_1)).toBe(true);

    await b.act(async (engine, host) => {
      host.collections = host.collections.filter((c) => c.id !== COLL_1);
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_1 }, deleted: true }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.collectionOf(WS, COLL_1)).toBeNull();
    await a.act((engine) => engine.syncWorkspace(WS));
    await a.act((engine) => engine.syncWorkspace(WS));
    expect(server.collectionOf(WS, COLL_1)).toBeNull();
  });
});

describe("collections across devices", () => {
  it("keeps two different collections edited on two devices", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      host.collections = [
        { id: COLL_1, workspaceId: WS, name: "A's list", tabIds: [TAB_1], createdAt: T0, updatedAt: T0 },
      ];
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    await b.act(async (engine, host) => {
      host.collections = [
        { id: COLL_2, workspaceId: WS, name: "B's list", tabIds: [TAB_2], createdAt: T0, updatedAt: T0 },
      ];
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_2 }, deleted: false }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.collectionOf(WS, COLL_1)?.name).toBe("A's list");
    expect(server.collectionOf(WS, COLL_2)?.name).toBe("B's list");
  });

  /**
   * Membership travels inside the collection payload rather than as its own
   * versioned entity (schema.sql), so "A added tab X" and "B removed tab X"
   * are two writes to ONE object. They must therefore behave like any other
   * same-entity contention: one lands, the other is reported.
   */
  it("treats an add and a remove of the same membership as one contested object", async () => {
    const { a, b } = await twoSyncedDevices();
    const seed: Collection = {
      id: COLL_1,
      workspaceId: WS,
      name: "Shared list",
      tabIds: [TAB_1, TAB_2],
      createdAt: T0,
      updatedAt: T0,
    };

    await a.act(async (engine, host) => {
      host.collections = [clone(seed)];
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });
    await b.act((engine) => engine.syncWorkspace(WS));

    // A adds TAB_3; B removes TAB_2. Same base, same collection.
    await a.act((engine, host) => {
      host.collections = [{ ...clone(seed), tabIds: [TAB_1, TAB_2, TAB_3] }];
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_1 }, deleted: false }]);
    });
    await b.act((engine, host) => {
      host.collections = [{ ...clone(seed), tabIds: [TAB_1] }];
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_1 }, deleted: false }]);
    });

    await a.act((engine) => engine.syncWorkspace(WS));
    expect(server.collectionOf(WS, COLL_1)?.tabIds).toEqual([TAB_1, TAB_2, TAB_3]);

    await b.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // B's removal did not silently win, and B's own copy is untouched.
    expect(server.collectionOf(WS, COLL_1)?.tabIds).toEqual([TAB_1, TAB_2, TAB_3]);
    expect(b.host.collections.find((c) => c.id === COLL_1)?.tabIds).toEqual([TAB_1]);
  });

  /**
   * Exclusivity: a tab belongs to at most one collection (schema.sql's
   * one-collection-per-tab constraint). Moving X from A to B is therefore
   * TWO collection writes, and both have to reach the other device or it is
   * left believing X is still in the first list.
   */
  it("carries both sides of an exclusive move to the other device", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      host.collections = [
        { id: COLL_1, workspaceId: WS, name: "First", tabIds: [TAB_1], createdAt: T0, updatedAt: T0 },
        { id: COLL_2, workspaceId: WS, name: "Second", tabIds: [], createdAt: T0, updatedAt: T0 },
      ];
      engine.markDirty(WS, [
        { ref: { entityType: "collection", entityId: COLL_1 }, deleted: false },
        { ref: { entityType: "collection", entityId: COLL_2 }, deleted: false },
      ]);
      await engine.syncWorkspace(WS);
    });
    await b.act((engine) => engine.syncWorkspace(WS));
    expect(b.host.collections.find((c) => c.id === COLL_1)?.tabIds).toEqual([TAB_1]);

    // A moves TAB_1 into COLL_2, which removes it from COLL_1.
    await a.act(async (engine, host) => {
      host.collections = [
        { id: COLL_1, workspaceId: WS, name: "First", tabIds: [], createdAt: T0, updatedAt: T0 },
        { id: COLL_2, workspaceId: WS, name: "Second", tabIds: [TAB_1], createdAt: T0, updatedAt: T0 },
      ];
      engine.markDirty(WS, [
        { ref: { entityType: "collection", entityId: COLL_1 }, deleted: false },
        { ref: { entityType: "collection", entityId: COLL_2 }, deleted: false },
      ]);
      await engine.syncWorkspace(WS);
    });

    await b.act((engine) => engine.syncWorkspace(WS));

    // B must not be left thinking TAB_1 is still in the first collection.
    expect(b.host.collections.find((c) => c.id === COLL_1)?.tabIds).toEqual([]);
    expect(b.host.collections.find((c) => c.id === COLL_2)?.tabIds).toEqual([TAB_1]);
  });
});

describe("a pull must not disturb another workspace's collections", () => {
  /**
   * The collection store is a single flat localStorage key covering every
   * workspace, but the engine reads and applies only the syncing workspace's
   * slice. If what it publishes is treated as the whole store, every other
   * workspace's collections are dropped — and the hook's persist effect then
   * writes that loss to disk.
   */
  it("keeps a second workspace's collections when the first one pulls", async () => {
    const { a, b } = await twoSyncedDevices();

    // A second workspace on device A, with its own collection.
    await a.act(async (engine, host) => {
      host.workspaces.set(WS_OTHER, baseWorkspace(WS_OTHER));
      host.collections = [
        { id: COLL_2, workspaceId: WS_OTHER, name: "Other workspace's list", tabIds: [], createdAt: T0, updatedAt: T0 },
      ];
      await engine.migrateWorkspace(WS_OTHER);
    });

    // B changes a collection in the FIRST workspace and pushes it.
    await b.act(async (engine, host) => {
      host.collections = [
        { id: COLL_1, workspaceId: WS, name: "From B", tabIds: [TAB_1], createdAt: T0, updatedAt: T0 },
      ];
      engine.markDirty(WS, [{ ref: { entityType: "collection", entityId: COLL_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // A pulls that change into the first workspace.
    await a.act((engine) => engine.syncWorkspace(WS));

    // It arrived...
    expect(a.host.collections.find((c) => c.id === COLL_1)?.name).toBe("From B");
    // ...and the unrelated workspace's collection is still here.
    expect(a.host.collections.find((c) => c.id === COLL_2)?.name).toBe("Other workspace's list");
  });
});

describe("dependencies across devices", () => {
  const dep = (parentTabId: string, childTabId: string): TabDependency => ({
    id: `dep-${parentTabId}-${childTabId}`,
    parentTabId,
    childTabId,
    createdAt: T0,
    updatedAt: T0,
  });

  it("keeps two unrelated dependencies created on two devices", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      host.dependencies = [dep(TAB_1, TAB_2)];
      engine.markDirty(WS, [
        { ref: { entityType: "dependency", parentTabId: TAB_1, childTabId: TAB_2 }, deleted: false },
      ]);
      await engine.syncWorkspace(WS);
    });

    await b.act(async (engine, host) => {
      host.dependencies = [dep(TAB_2, TAB_1)];
      engine.markDirty(WS, [
        { ref: { entityType: "dependency", parentTabId: TAB_2, childTabId: TAB_1 }, deleted: false },
      ]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.dependencyKeysOf(WS)).toEqual([`${TAB_1}::${TAB_2}`, `${TAB_2}::${TAB_1}`]);
  });

  /**
   * Identity is the pair, never a minted id (types.ts). Two devices creating
   * the same logical dependency must therefore converge on ONE row, not two.
   */
  it("does not create a duplicate when both devices create the same pair", async () => {
    const { a, b } = await twoSyncedDevices();

    for (const device of [a, b]) {
      await device.act((engine, host) => {
        host.dependencies = [dep(TAB_1, TAB_2)];
        engine.markDirty(WS, [
          { ref: { entityType: "dependency", parentTabId: TAB_1, childTabId: TAB_2 }, deleted: false },
        ]);
      });
    }

    await a.act((engine) => engine.syncWorkspace(WS));
    await b.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.dependencyKeysOf(WS)).toEqual([`${TAB_1}::${TAB_2}`]);
  });

  it("does not resurrect a dependency the other device removed", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      host.dependencies = [dep(TAB_1, TAB_2)];
      engine.markDirty(WS, [
        { ref: { entityType: "dependency", parentTabId: TAB_1, childTabId: TAB_2 }, deleted: false },
      ]);
      await engine.syncWorkspace(WS);
    });
    await b.act((engine) => engine.syncWorkspace(WS));
    expect(b.host.dependencies).toHaveLength(1);

    await b.act(async (engine, host) => {
      host.dependencies = [];
      engine.markDirty(WS, [
        { ref: { entityType: "dependency", parentTabId: TAB_1, childTabId: TAB_2 }, deleted: true },
      ]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.dependencyKeysOf(WS)).toEqual([]);
    await a.act((engine) => engine.syncWorkspace(WS));
    await a.act((engine) => engine.syncWorkspace(WS));
    expect(server.dependencyKeysOf(WS)).toEqual([]);
  });
});

describe("manual placement survives the network", () => {
  /**
   * `sectionLocked` says a human put this tab here. The local organizer
   * already refuses to move such a tab; the same has to hold when the move
   * arrives from another device's automatic organization.
   */
  it("refuses an automatic move of a tab a human locked on the other device", async () => {
    const locked = (): Workspace => ({
      ...baseWorkspace(),
      sections: [
        { id: SECTION_1, parentId: null, name: "One", source: "user", createdAt: T0, updatedAt: T0 },
        { id: SECTION_2, parentId: null, name: "Two", source: "ai", createdAt: T0, updatedAt: T0 },
      ],
      tabs: [
        tab({ id: TAB_1, title: "Pinned by hand", sectionId: SECTION_1, sectionLocked: true }),
        tab({ id: TAB_2 }),
      ],
    });

    const a = new Device("A", locked(), now);
    await a.act((engine) => engine.migrateWorkspace(WS));
    const b = new Device("B", locked(), now);
    await b.act(async (engine) => {
      await engine.migrateWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // B's organizer tries to move it WITHOUT claiming a manual placement.
    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) =>
          t.id === TAB_1 ? { ...t, sectionId: SECTION_2, sectionLocked: false, organizationStatus: "classified" } : t
        ),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    // The server kept the human's placement and said so.
    expect(server.tabOf(WS, TAB_1)?.sectionId).toBe(SECTION_1);
    expect(b.state().status).toBe("conflict");
    expect(b.state().conflicts[0]?.reason).toBe("locked-section");
  });

  it("accepts a genuine manual move from the other device", async () => {
    const locked = (): Workspace => ({
      ...baseWorkspace(),
      sections: [
        { id: SECTION_1, parentId: null, name: "One", source: "user", createdAt: T0, updatedAt: T0 },
        { id: SECTION_2, parentId: null, name: "Two", source: "user", createdAt: T0, updatedAt: T0 },
      ],
      tabs: [tab({ id: TAB_1, sectionId: SECTION_1, sectionLocked: true }), tab({ id: TAB_2 })],
    });

    const a = new Device("A", locked(), now);
    await a.act((engine) => engine.migrateWorkspace(WS));
    const b = new Device("B", locked(), now);
    await b.act(async (engine) => {
      await engine.migrateWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    await b.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        // A person moved it: the lock travels with the move.
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, sectionId: SECTION_2, sectionLocked: true } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_1)?.sectionId).toBe(SECTION_2);
    expect(b.state().status).not.toBe("conflict");
  });
});

describe("account isolation, from the client's side", () => {
  it("cannot pull or push another account's workspace", async () => {
    const a = new Device("A", baseWorkspace(), now);
    await a.act((engine) => engine.migrateWorkspace(WS));

    // A second account signs in on another device and points at A's id.
    server.currentUserId = USER_B;
    const intruder = new Device("B", baseWorkspace(), now);
    intruder.host.userId = USER_B;

    await intruder.act(async (engine, host) => {
      await engine.migrateWorkspace(WS);
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Stolen" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    // Nothing of the intruder's reached A's workspace.
    expect(server.tabOf(WS, TAB_1)?.title).toBe("One");
  });

  it("answers a foreign workspace and a nonexistent one identically", async () => {
    const a = new Device("A", baseWorkspace(), now);
    await a.act((engine) => engine.migrateWorkspace(WS));

    server.currentUserId = USER_B;
    const responses: number[] = [];
    for (const id of [WS, WS_OTHER]) {
      const response = await server.fetch(`/api/sync/pull?workspaceId=${id}&cursor=0`, { method: "GET" });
      responses.push(response.status);
    }

    // Existing-but-foreign and simply-absent must be indistinguishable, or a
    // guessed id becomes an existence oracle.
    expect(responses).toEqual([404, 404]);
  });
});

describe("authentication expiring mid-flight", () => {
  it("keeps local work, stops retrying, and resumes once signed in again", async () => {
    const { a } = await twoSyncedDevices();

    await a.act((engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Written while expiring" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
    });

    // The session dies between the edit and the push.
    server.currentUserId = null;
    await a.act((engine) => engine.syncWorkspace(WS));

    let state = a.state();
    expect(state.status).toBe("paused");
    expect(state.dirty).toHaveLength(1);
    // No backoff timer: a 401 fails identically forever, so retrying is noise.
    expect(state.retryAfter).toBeUndefined();
    // The local edit is untouched.
    expect(a.host.tab(TAB_1)?.title).toBe("Written while expiring");

    // Signing back in lets the same pending work go up.
    server.currentUserId = USER_A;
    await a.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    state = a.state();
    expect(state.dirty).toHaveLength(0);
    expect(server.tabOf(WS, TAB_1)?.title).toBe("Written while expiring");
  });
});

describe("conflicts survive a restart and resolve cleanly", () => {
  /** Drives both devices into a conflict on TAB_1, with B holding the losing edit. */
  async function conflicted() {
    const { a, b } = await twoSyncedDevices();
    for (const [device, title] of [
      [a, "A's version"],
      [b, "B's version"],
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
    await a.act((engine) => engine.syncWorkspace(WS));
    await b.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });
    return { a, b };
  }

  it("still shows the conflict after the app restarts", async () => {
    const { b } = await conflicted();
    expect(b.state().conflicts).toHaveLength(1);

    b.reload();

    const restored = b.state();
    expect(restored.status).toBe("conflict");
    expect(restored.conflicts).toHaveLength(1);
    expect(restored.conflicts[0].entityId).toBe(TAB_1);
  });

  it("keep mine re-pushes the local version and clears the conflict", async () => {
    const { b } = await conflicted();
    const conflictId = b.state().conflicts[0].id;

    await b.act(async (engine) => {
      engine.resolveConflict(WS, conflictId, "local");
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(b.state().conflicts).toHaveLength(0);
    expect(b.state().status).not.toBe("conflict");
    expect(server.tabOf(WS, TAB_1)?.title).toBe("B's version");
  });

  it("keep theirs adopts the server's version and pushes nothing", async () => {
    const { b } = await conflicted();
    const conflictId = b.state().conflicts[0].id;
    const pushesBefore = server.pushes.length;

    await b.act(async (engine) => {
      engine.resolveConflict(WS, conflictId, "remote");
      await engine.syncWorkspace(WS);
    });

    expect(b.state().conflicts).toHaveLength(0);
    expect(b.host.tab(TAB_1)?.title).toBe("A's version");
    // The server's own value is not sent back to it as a new mutation.
    const sentTab1 = server.pushes
      .slice(pushesBefore)
      .flatMap((call) => (call.body?.upserts as { entity?: { id?: string } }[]) ?? [])
      .some((u) => u.entity?.id === TAB_1);
    expect(sentTab1).toBe(false);
  });

  /**
   * The requirement that makes resolution safe to offer at all: choosing a
   * side for ONE entity must not quietly revert anything else.
   */
  it("keep mine does not discard an unrelated remote change", async () => {
    const { a, b } = await conflicted();

    // While B sits on its conflict, A changes a DIFFERENT tab.
    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "A's unrelated edit" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    const conflictId = b.state().conflicts[0].id;
    await b.act(async (engine) => {
      engine.resolveConflict(WS, conflictId, "local");
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // B's choice won for TAB_1...
    expect(server.tabOf(WS, TAB_1)?.title).toBe("B's version");
    // ...and A's unrelated edit is still there, on the server and on B.
    expect(server.tabOf(WS, TAB_2)?.title).toBe("A's unrelated edit");
    expect(b.host.tab(TAB_2)?.title).toBe("A's unrelated edit");
  });

  it("keep theirs does not discard an unrelated local change", async () => {
    const { b } = await conflicted();

    // B has a second, uncontested local edit pending.
    await b.act((engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "B's other edit" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
    });

    const conflictId = b.state().conflicts[0].id;
    await b.act(async (engine) => {
      engine.resolveConflict(WS, conflictId, "remote");
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // Giving up TAB_1 did not give up TAB_2.
    expect(b.host.tab(TAB_2)?.title).toBe("B's other edit");
    expect(server.tabOf(WS, TAB_2)?.title).toBe("B's other edit");
  });
});

describe("retrying is safe", () => {
  it("does not duplicate anything when a response is lost after the server committed", async () => {
    const { a } = await twoSyncedDevices();

    await a.act((engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: [...ws.tabs, tab({ id: TAB_3, title: "Added once" })] });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_3 }, deleted: false }]);
    });

    // The server commits, then the reply is lost.
    server.dropNextResponses(1);
    await a.act((engine) => engine.syncWorkspace(WS));

    // The client believes it failed and still holds the work.
    expect(a.state().dirty).toHaveLength(1);
    expect(server.tabOf(WS, TAB_3)?.title).toBe("Added once");

    // A lost reply is recorded as an offline failure, which arms a backoff
    // window; a real retry happens after it, so step past it.
    clock += 60_000;

    // It retries; the replay is keyed on the client's own id, so one row.
    await a.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(a.host.workspaces.get(WS)!.tabs.filter((t) => t.id === TAB_3)).toHaveLength(1);
    expect(server.tabOf(WS, TAB_3)?.title).toBe("Added once");
    expect(a.state().dirty).toHaveLength(0);
  });

  it("applies the same pulled page twice without duplicating the entity", async () => {
    const { a, b } = await twoSyncedDevices();

    await a.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, { ...ws, tabs: [...ws.tabs, tab({ id: TAB_3, title: "From A" })] });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_3 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    await b.act(async (engine) => {
      await engine.syncWorkspace(WS);
      // A second pass re-reads from the same cursor when nothing moved.
      await engine.syncWorkspace(WS);
    });

    expect(b.host.workspaces.get(WS)!.tabs.filter((t) => t.id === TAB_3)).toHaveLength(1);
  });
});

describe("one workspace's trouble does not become another's", () => {
  it("syncs a healthy workspace while another sits in conflict", async () => {
    const { a, b } = await twoSyncedDevices();

    // Give A a second workspace, synced.
    await a.act(async (engine, host) => {
      host.workspaces.set(WS_OTHER, baseWorkspace(WS_OTHER));
      await engine.migrateWorkspace(WS_OTHER);
    });

    // Drive WS into conflict for A.
    for (const [device, title] of [
      [b, "B wins"],
      [a, "A loses"],
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
    await b.act((engine) => engine.syncWorkspace(WS));
    await a.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });
    expect(a.state(WS).status).toBe("conflict");

    // The other workspace still syncs normally.
    await a.act(async (engine, host) => {
      const other = host.workspaces.get(WS_OTHER)!;
      host.workspaces.set(WS_OTHER, {
        ...other,
        tabs: other.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Unaffected" } : t)),
      });
      engine.markDirty(WS_OTHER, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS_OTHER);
    });

    expect(server.tabOf(WS_OTHER, TAB_1)?.title).toBe("Unaffected");
    expect(a.state(WS_OTHER).status).not.toBe("conflict");
    // And the conflicted one is still conflicted, not quietly cleared.
    expect(a.state(WS).status).toBe("conflict");
  });
});
