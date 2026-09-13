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
 * The lifecycle of a workspace that already exists in the cloud when a
 * device meets it.
 *
 * The behaviour this file exists to pin down: a second device asking to
 * upload a workspace the account already has is NOT a data conflict. Nothing
 * disagrees. The right answer is to install what is there, and the wrong
 * answer — the one this replaces — was to route it through the conflict
 * machinery and leave the workspace sitting in `conflict` with no conflicts
 * in it.
 *
 * Same harness as multi-device.test.ts: real `SyncEngine` instances against
 * one in-memory server implementing the wire contract. It proves the client
 * half; it proves nothing about Postgres.
 */

const T0 = 1_700_000_000_000;
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS = "11111111-1111-4111-8111-111111111111";
const WS_TWO = "77777777-7777-4777-8777-777777777777";
const TAB_1 = "22222222-2222-4222-8222-222222222222";
const TAB_2 = "33333333-3333-4333-8333-333333333333";
const TAB_3 = "66666666-6666-4666-8666-666666666666";
const SECTION_1 = "44444444-4444-4444-8444-444444444444";
const GROUP_1 = "88888888-8888-4888-8888-888888888888";
const COLL_1 = "aaaa1111-1111-4111-8111-111111111111";

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

/** A workspace with one of everything, so adoption has every entity type to restore. */
function richWorkspace(id = WS): Workspace {
  return {
    id,
    name: "Research",
    createdAt: T0,
    updatedAt: T0 + 5,
    sections: [{ id: SECTION_1, parentId: null, name: "Reading", source: "user", createdAt: T0, updatedAt: T0 }],
    groups: [{ id: GROUP_1, name: "Papers", createdAt: T0, updatedAt: T0 }],
    tabs: [
      tab({ id: TAB_1, title: "One", sectionId: SECTION_1, groupId: GROUP_1, isFavorite: true }),
      tab({ id: TAB_2, title: "Two", notes: "a note" }),
    ],
  };
}

class DeviceHost implements SyncEngineHost {
  userId: string | null = USER_A;
  workspaces = new Map<string, Workspace>();
  collections: Collection[] = [];
  dependencies: TabDependency[] = [];
  remoteCommits: string[] = [];

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
  /** Installs OR replaces, exactly as app-shell's onRemoteWorkspace does. */
  commitRemote(next: Workspace) {
    this.remoteCommits.push(next.id);
    this.workspaces.set(next.id, next);
  }

  tab(tabId: string, workspaceId = WS): Tab | null {
    return this.workspaces.get(workspaceId)?.tabs.find((t) => t.id === tabId) ?? null;
  }
}

/** One conceptual device: its own host, engine and journal blob. */
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
    // Stands in for the collection/dependency hooks, which own those stores
    // and are the only writers of them — see notify.ts.
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

  /** Restarts the app on this device, reading this device's own persisted journal. */
  reload(): void {
    if (this.disk === null) window.localStorage.removeItem(JOURNAL_KEY);
    else window.localStorage.setItem(JOURNAL_KEY, this.disk);
    this.engine = new SyncEngine(this.host, { debounceMs: 0, now: this.clock });
  }

  /** Wipes this device's durable sync bookkeeping, as signing out does. */
  forgetJournal(): void {
    this.disk = null;
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

/** Puts a fully-populated workspace on the server, the way the first device does. */
async function seedServer(): Promise<Device> {
  const first = makeDevice([richWorkspace()]);
  await first.act(async (engine, host) => {
    host.collections = [
      { id: COLL_1, workspaceId: WS, name: "To read", tabIds: [TAB_2, TAB_1], createdAt: T0, updatedAt: T0 },
    ];
    host.dependencies = [
      { id: `dep-${TAB_1}-${TAB_2}`, parentTabId: TAB_1, childTabId: TAB_2, type: "research", createdAt: T0, updatedAt: T0 },
    ];
    await engine.migrateWorkspace(WS);
  });
  return first;
}

describe("a workspace that already exists is not a conflict", () => {
  /**
   * The headline. A device holding its own copy asks to upload; the server
   * says it already has it. That is the ordinary second-device situation and
   * must not be reported as a disagreement.
   */
  it("adopts instead of reporting a conflict when the upload is refused", async () => {
    await seedServer();

    const second = makeDevice([richWorkspace()]);
    await second.act((engine) => engine.migrateWorkspace(WS));

    const state = second.state();
    expect(state.status).not.toBe("conflict");
    expect(state.conflicts).toHaveLength(0);
    expect(state.lastError).toBeUndefined();
    // And it is genuinely synced, not merely "not conflicted".
    expect(state.cursor).toBe(server.cursorOf(WS));
  });

  it("reports already-exists distinctly from a real conflict", async () => {
    await seedServer();
    const { initialSync } = await import("./client");

    const result = await initialSync(
      { workspace: richWorkspace(), collections: [], dependencies: [] },
      null
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.failure.kind).toBe("already-exists");
  });

  it("still treats a genuine entity conflict as a conflict", async () => {
    const first = await seedServer();
    const second = makeDevice([richWorkspace()]);
    await second.act((engine) => engine.migrateWorkspace(WS));

    // Both devices edit the same tab from the same base.
    for (const [device, title] of [
      [first, "First's title"],
      [second, "Second's title"],
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
    await second.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    // Adoption stopped being a conflict; this did not.
    expect(second.state().status).toBe("conflict");
    expect(second.state().conflicts).toHaveLength(1);
  });

  it("leaves a transient failure an error and an outage offline", async () => {
    await seedServer();
    const second = makeDevice([richWorkspace()]);

    server.failNextRequests(1, 500, { error: "Server error." });
    await second.act((engine) => engine.migrateWorkspace(WS));
    expect(second.state().status).toBe("error");
    expect(second.state().conflicts).toHaveLength(0);
  });
});

describe("adopting a workspace onto a device that has none", () => {
  /** The true new-device case: signed in, nothing stored locally. */
  it("installs the workspace and every syncable entity in it", async () => {
    await seedServer();

    const fresh = makeDevice([]);
    const outcome = await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(outcome.ok).toBe(true);
    const workspace = fresh.host.workspaces.get(WS);
    expect(workspace).toBeDefined();

    // Workspace-level fields.
    expect(workspace!.name).toBe("Research");
    expect(workspace!.createdAt).toBe(T0);
    expect(workspace!.updatedAt).toBe(T0 + 5);

    // Sections and groups.
    expect(workspace!.sections?.map((s) => s.id)).toEqual([SECTION_1]);
    expect(workspace!.sections?.[0].name).toBe("Reading");
    expect(workspace!.groups?.map((g) => g.id)).toEqual([GROUP_1]);

    // Tabs, with their syncable fields and their references intact.
    expect(workspace!.tabs.map((t) => t.id).sort()).toEqual([TAB_1, TAB_2].sort());
    const one = workspace!.tabs.find((t) => t.id === TAB_1)!;
    expect(one.title).toBe("One");
    expect(one.sectionId).toBe(SECTION_1);
    expect(one.groupId).toBe(GROUP_1);
    expect(one.isFavorite).toBe(true);
    expect(workspace!.tabs.find((t) => t.id === TAB_2)!.notes).toBe("a note");

    // Collections, with membership order preserved.
    const collection = fresh.host.collections.find((c) => c.id === COLL_1);
    expect(collection?.name).toBe("To read");
    expect(collection?.tabIds).toEqual([TAB_2, TAB_1]);
    expect(collection?.workspaceId).toBe(WS);

    // Dependencies, keyed on the pair.
    expect(fresh.host.dependencies).toHaveLength(1);
    expect(fresh.host.dependencies[0]).toMatchObject({
      parentTabId: TAB_1,
      childTabId: TAB_2,
      type: "research",
    });
  });

  /**
   * Derived fields never cross the wire (see serialize.ts) — they are
   * recomputed from the URL on arrival. Device-local state is not represented
   * at all.
   */
  it("recomputes derived fields rather than expecting them from the server", async () => {
    await seedServer();
    const fresh = makeDevice([]);
    await fresh.act((engine) => engine.adoptWorkspace(WS));

    const one = fresh.host.workspaces.get(WS)!.tabs.find((t) => t.id === TAB_1)!;
    expect(one.normalizedUrl).toBe(`https://example.com/${TAB_1}`);
    expect(one.domain).toBe("example.com");
    // Never sent, never invented.
    expect(one.favicon).toBeUndefined();
  });

  it("lands on the server's cursor, so the next sync is incremental", async () => {
    await seedServer();
    const fresh = makeDevice([]);
    await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(fresh.state().cursor).toBe(server.cursorOf(WS));
    expect(fresh.state().status).toBe("idle");

    // The next pass asks from that cursor and receives nothing new.
    const pullsBefore = server.pulls.length;
    await fresh.act((engine) => engine.syncWorkspace(WS));
    const asked = server.pulls.slice(pullsBefore).map((c) => new URLSearchParams(c.url.split("?")[1]).get("cursor"));
    expect(asked.every((c) => c === server.cursorOf(WS))).toBe(true);
  });

  it("does not re-hydrate on every restart", async () => {
    await seedServer();
    const fresh = makeDevice([]);
    await fresh.act((engine) => engine.adoptWorkspace(WS));

    const pullsAfterAdoption = server.pulls.length;
    fresh.reload();
    await fresh.act((engine) => engine.syncWorkspace(WS));

    // One incremental pull from the stored cursor, not a second full read.
    const asked = server.pulls
      .slice(pullsAfterAdoption)
      .map((c) => new URLSearchParams(c.url.split("?")[1]).get("cursor"));
    expect(asked).not.toContain("0");
    expect(fresh.host.workspaces.get(WS)!.tabs).toHaveLength(2);
  });

  it("is idempotent — adopting twice installs one copy", async () => {
    await seedServer();
    const fresh = makeDevice([]);
    await fresh.act((engine) => engine.adoptWorkspace(WS));
    await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(fresh.host.workspaces.get(WS)!.tabs).toHaveLength(2);
    expect(fresh.host.collections.filter((c) => c.id === COLL_1)).toHaveLength(1);
    expect(fresh.host.dependencies).toHaveLength(1);
  });

  it("refuses to install a workspace the account does not have", async () => {
    const fresh = makeDevice([]);
    const outcome = await fresh.act((engine) => engine.adoptWorkspace(WS_TWO));

    expect(outcome.ok).toBe(false);
    // No empty shell named after an id.
    expect(fresh.host.workspaces.has(WS_TWO)).toBe(false);
    expect(fresh.state(WS_TWO).cursor).toBe("0");
  });
});

describe("adoption is all or nothing", () => {
  /**
   * A half-installed workspace is worse than none: it looks real while
   * missing tabs the user cannot tell are missing. So a failure part-way
   * through must leave the device exactly as it was.
   */
  it("installs nothing and moves no cursor when a page fails", async () => {
    await seedServer();
    const fresh = makeDevice([]);

    server.failNextRequests(1, 500, { error: "Server error." });
    const outcome = await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(outcome.ok).toBe(false);
    expect(fresh.host.workspaces.has(WS)).toBe(false);
    expect(fresh.host.collections).toHaveLength(0);
    expect(fresh.host.dependencies).toHaveLength(0);
    expect(fresh.state().cursor).toBe("0");
  });

  it("installs nothing when the connection drops mid-adoption", async () => {
    await seedServer();
    const fresh = makeDevice([]);

    server.dropNextResponses(1);
    await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(fresh.host.workspaces.has(WS)).toBe(false);
    expect(fresh.state().cursor).toBe("0");
    expect(fresh.state().status).toBe("offline");
  });

  it("recovers completely on the next attempt", async () => {
    await seedServer();
    const fresh = makeDevice([]);

    server.failNextRequests(1, 503, { error: "Unavailable." });
    await fresh.act((engine) => engine.adoptWorkspace(WS));
    expect(fresh.host.workspaces.has(WS)).toBe(false);

    // Past the backoff the retry arms, adoption completes in full.
    clock += 60_000;
    await fresh.act((engine) => engine.adoptWorkspace(WS));
    expect(fresh.host.workspaces.get(WS)!.tabs).toHaveLength(2);
    expect(fresh.state().cursor).toBe(server.cursorOf(WS));
  });

  /** A multi-page read must not leave a partial workspace either. */
  it("installs nothing when a later page of a paged adoption fails", async () => {
    server = new FakeSyncServer({ now, pageSize: 1 });
    server.currentUserId = USER_A;
    vi.stubGlobal("fetch", server.fetch);

    const first = makeDevice([richWorkspace()]);
    await first.act((engine) => engine.migrateWorkspace(WS));
    // Several distinct versions, so the catch-up genuinely pages.
    for (const id of [TAB_3, "aaaabbbb-1111-4111-8111-111111111111"]) {
      await first.act(async (engine, host) => {
        const ws = host.workspaces.get(WS)!;
        host.workspaces.set(WS, { ...ws, tabs: [...ws.tabs, tab({ id })] });
        engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: id }, deleted: false }]);
        await engine.syncWorkspace(WS);
      });
    }

    const fresh = makeDevice([]);
    // Let the first page through, then break the second.
    let seen = 0;
    const real = server.fetch;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
      if (path.startsWith("/api/sync/pull")) {
        seen++;
        if (seen === 2) return new Response(JSON.stringify({ error: "Server error." }), { status: 500 });
      }
      return real(path, init);
    });

    await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(fresh.host.workspaces.has(WS)).toBe(false);
    expect(fresh.state().cursor).toBe("0");
  });
});

describe("adoption does not become an upload", () => {
  /**
   * Everything adoption writes came from the server. If any of it were
   * marked dirty, the device would immediately push back everything it had
   * just downloaded — and with collections and dependencies travelling on
   * their own notification channel, that is the easiest mistake to make.
   */
  it("pushes nothing after installing a workspace", async () => {
    await seedServer();
    const fresh = makeDevice([]);

    const pushesBefore = server.pushes.length;
    await fresh.act(async (engine) => {
      await engine.adoptWorkspace(WS);
      // Whatever the scheduler would do next, it must not be an upload.
      await engine.syncWorkspace(WS);
    });

    expect(server.pushes.length).toBe(pushesBefore);
    expect(fresh.state().dirty).toHaveLength(0);
  });

  it("leaves the server's contents exactly as they were", async () => {
    await seedServer();
    const before = server.cursorOf(WS);

    const fresh = makeDevice([]);
    await fresh.act(async (engine) => {
      await engine.adoptWorkspace(WS);
      await engine.syncWorkspace(WS);
    });

    expect(server.cursorOf(WS)).toBe(before);
    expect(server.collectionOf(WS, COLL_1)?.tabIds).toEqual([TAB_2, TAB_1]);
    expect(server.dependencyKeysOf(WS)).toEqual([`${TAB_1}::${TAB_2}`]);
  });

  it("syncs incrementally afterwards, like any other workspace", async () => {
    const first = await seedServer();
    const fresh = makeDevice([]);
    await fresh.act((engine) => engine.adoptWorkspace(WS));

    // The adopting device makes a real edit; it goes up as a normal push.
    await fresh.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_2 ? { ...t, title: "Edited after adopting" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_2 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    expect(server.tabOf(WS, TAB_2)?.title).toBe("Edited after adopting");

    // And the device that seeded the server receives it.
    await first.act((engine) => engine.syncWorkspace(WS));
    expect(first.host.tab(TAB_2)?.title).toBe("Edited after adopting");
  });
});

describe("adopting onto a device that already has local data", () => {
  /**
   * Case B. Adoption merges by identity: remote entities arrive, local-only
   * entities stay, and anything with a pending local edit is withheld and
   * reported rather than replaced. Nothing is silently overwritten in either
   * direction.
   */
  it("keeps a local-only tab the server has never heard of", async () => {
    await seedServer();

    const other = makeDevice([
      { ...richWorkspace(), tabs: [...richWorkspace().tabs, tab({ id: TAB_3, title: "Only on this device" })] },
    ]);
    await other.act((engine) => engine.adoptWorkspace(WS));

    // Absence on the server is never deletion.
    expect(other.host.tab(TAB_3)?.title).toBe("Only on this device");
    // And the server's own entities arrived alongside it.
    expect(other.host.workspaces.get(WS)!.tabs).toHaveLength(3);
  });

  it("never discards a pending offline edit", async () => {
    const first = await seedServer();

    // Another device edits TAB_1 remotely.
    await first.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Changed elsewhere" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.syncWorkspace(WS);
    });

    // This device edited the same tab while it had no connection.
    const other = makeDevice([richWorkspace()]);
    await other.act(async (engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "Edited offline" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
      await engine.adoptWorkspace(WS);
    });

    // The local edit survived and the disagreement is surfaced, not resolved.
    expect(other.host.tab(TAB_1)?.title).toBe("Edited offline");
    expect(other.state().dirty).toHaveLength(1);
    expect(other.state().conflicts.some((c) => c.entityId === TAB_1)).toBe(true);
  });

  it("does not disturb another workspace held on the same device", async () => {
    await seedServer();

    const other = makeDevice([richWorkspace(WS_TWO)]);
    await other.act(async (engine, host) => {
      host.collections = [
        { id: COLL_1, workspaceId: WS_TWO, name: "Untouched", tabIds: [TAB_1], createdAt: T0, updatedAt: T0 },
      ];
      await engine.adoptWorkspace(WS);
    });

    // The adopted workspace arrived...
    expect(other.host.workspaces.has(WS)).toBe(true);
    // ...and the pre-existing one is exactly as it was.
    const untouched = other.host.workspaces.get(WS_TWO)!;
    expect(untouched.tabs).toHaveLength(2);
    expect(other.host.collections.find((c) => c.workspaceId === WS_TWO)?.name).toBe("Untouched");
  });
});

describe("discovery", () => {
  it("lists the workspaces this account owns", async () => {
    const first = await seedServer();
    await first.act(async (engine, host) => {
      host.workspaces.set(WS_TWO, richWorkspace(WS_TWO));
      await engine.migrateWorkspace(WS_TWO);
    });

    const fresh = makeDevice([]);
    const found = await fresh.act((engine) => engine.listRemoteWorkspaces());

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.workspaces.map((w) => w.id).sort()).toEqual([WS, WS_TWO].sort());
    expect(found.workspaces.find((w) => w.id === WS)?.name).toBe("Research");
  });

  it("returns metadata only, never contents", async () => {
    await seedServer();
    const fresh = makeDevice([]);
    const found = await fresh.act((engine) => engine.listRemoteWorkspaces());

    if (!found.ok) throw new Error("expected discovery to succeed");
    for (const workspace of found.workspaces) {
      expect(Object.keys(workspace).sort()).toEqual(["createdAt", "id", "name", "updatedAt"]);
    }
  });

  it("shows another account nothing", async () => {
    await seedServer();

    server.currentUserId = USER_B;
    const intruder = makeDevice([], USER_B);
    const found = await intruder.act((engine) => engine.listRemoteWorkspaces());

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.workspaces).toHaveLength(0);
  });

  it("asks for nothing at all when signed out", async () => {
    await seedServer();
    const callsBefore = server.calls.length;

    const anonymous = makeDevice([], null);
    const found = await anonymous.act((engine) => engine.listRemoteWorkspaces());

    expect(found.ok).toBe(false);
    expect(server.calls.length).toBe(callsBefore);
  });
});

describe("cross-account isolation", () => {
  it("cannot adopt another account's workspace", async () => {
    await seedServer();

    server.currentUserId = USER_B;
    const intruder = makeDevice([], USER_B);
    const outcome = await intruder.act((engine) => engine.adoptWorkspace(WS));

    expect(outcome.ok).toBe(false);
    expect(intruder.host.workspaces.has(WS)).toBe(false);
    expect(intruder.host.collections).toHaveLength(0);
    expect(intruder.host.dependencies).toHaveLength(0);
  });

  it("cannot upload into another account's workspace id", async () => {
    await seedServer();

    server.currentUserId = USER_B;
    const intruder = makeDevice([{ ...richWorkspace(), name: "Mine now" }], USER_B);
    await intruder.act((engine) => engine.migrateWorkspace(WS));

    // The original owner's workspace is untouched.
    expect(server.tabOf(WS, TAB_1)?.title).toBe("One");
  });

  /**
   * Sign-out must leave nothing of the previous account behind: a cursor
   * belonging to A, replayed as B, would ask the server for changes that
   * never happened to B's workspace.
   */
  it("hands the next account none of the previous one's bookkeeping", async () => {
    const first = await seedServer();
    await first.act((engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "A's pending edit" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
    });
    expect(first.state().dirty).toHaveLength(1);

    // Account B signs in on the same device.
    await first.act((engine, host) => {
      host.userId = USER_B;
      engine.reset();
    });

    const asB = first.state();
    expect(asB.cursor).toBe("0");
    expect(asB.dirty).toHaveLength(0);
    expect(asB.conflicts).toHaveLength(0);
    expect(asB.status).toBe("never-synced");
  });

  it("gives the first account its pending work back when it returns", async () => {
    const first = await seedServer();
    await first.act((engine, host) => {
      const ws = host.workspaces.get(WS)!;
      host.workspaces.set(WS, {
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === TAB_1 ? { ...t, title: "A's pending edit" } : t)),
      });
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_1 }, deleted: false }]);
    });

    await first.act((engine, host) => {
      host.userId = USER_B;
      engine.reset();
    });
    await first.act((engine, host) => {
      host.userId = USER_A;
      engine.reset();
    });

    // A's journal was scoped to A and is still there.
    expect(first.state().dirty).toHaveLength(1);
    expect(first.state().cursor).not.toBe("0");
  });
});

describe("workspace identity is the id, never the name", () => {
  it("keeps two same-named workspaces separate", async () => {
    const first = makeDevice([
      { ...richWorkspace(WS), name: "School" },
      { ...richWorkspace(WS_TWO), name: "School" },
    ]);
    await first.act(async (engine) => {
      await engine.migrateWorkspace(WS);
      await engine.migrateWorkspace(WS_TWO);
    });

    const fresh = makeDevice([]);
    const found = await fresh.act((engine) => engine.listRemoteWorkspaces());
    if (!found.ok) throw new Error("expected discovery to succeed");

    expect(found.workspaces).toHaveLength(2);
    expect(found.workspaces.every((w) => w.name === "School")).toBe(true);
    expect(new Set(found.workspaces.map((w) => w.id)).size).toBe(2);

    // Adopting one brings that one only.
    await fresh.act((engine) => engine.adoptWorkspace(WS));
    expect(fresh.host.workspaces.has(WS)).toBe(true);
    expect(fresh.host.workspaces.has(WS_TWO)).toBe(false);
  });
});

describe("workspace deletion", () => {
  it("drops a deleted workspace out of discovery", async () => {
    await seedServer();
    server.tombstoneWorkspace(WS);

    const fresh = makeDevice([]);
    const found = await fresh.act((engine) => engine.listRemoteWorkspaces());

    if (!found.ok) throw new Error("expected discovery to succeed");
    expect(found.workspaces.map((w) => w.id)).not.toContain(WS);
  });

  it("does not install a workspace that has been deleted", async () => {
    await seedServer();
    server.tombstoneWorkspace(WS);

    const fresh = makeDevice([]);
    const outcome = await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(outcome.ok).toBe(false);
    expect(fresh.host.workspaces.has(WS)).toBe(false);
  });

  /**
   * A workspace tombstone is surfaced, never acted on: removing the user's
   * whole workspace as a side effect of a background pull is the destructive
   * act the whole design forbids.
   */
  it("surfaces a remote deletion without deleting anything locally", async () => {
    const first = await seedServer();
    server.tombstoneWorkspace(WS);

    await first.act((engine) => engine.syncWorkspace(WS));

    // Still here, and still holding its tabs.
    expect(first.host.workspaces.get(WS)!.tabs).toHaveLength(2);
    expect(first.state().conflicts.some((c) => c.entityType === "workspace")).toBe(true);
  });

  it("does not touch other workspaces when one is deleted remotely", async () => {
    const first = await seedServer();
    await first.act(async (engine, host) => {
      host.workspaces.set(WS_TWO, richWorkspace(WS_TWO));
      await engine.migrateWorkspace(WS_TWO);
    });

    server.tombstoneWorkspace(WS);
    await first.act(async (engine) => {
      await engine.syncWorkspace(WS);
      await engine.syncWorkspace(WS_TWO);
    });

    expect(first.host.workspaces.get(WS_TWO)!.tabs).toHaveLength(2);
    expect(first.state(WS_TWO).status).not.toBe("conflict");
  });
});

describe("session expiry around adoption", () => {
  it("keeps local work and stops retrying, then resumes once signed in again", async () => {
    await seedServer();
    const fresh = makeDevice([]);

    server.currentUserId = null;
    await fresh.act((engine) => engine.adoptWorkspace(WS));

    expect(fresh.state().status).toBe("paused");
    expect(fresh.state().retryAfter).toBeUndefined();
    expect(fresh.host.workspaces.has(WS)).toBe(false);

    server.currentUserId = USER_A;
    await fresh.act((engine) => engine.adoptWorkspace(WS));
    expect(fresh.host.workspaces.get(WS)!.tabs).toHaveLength(2);
  });
});
