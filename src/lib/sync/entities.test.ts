import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./engine";
import type { SyncEngineHost } from "./engine";
import {
  __resetSyncDirtyListenersForTests,
  publishRemoteEntities,
  publishSyncDirty,
  subscribeRemoteEntities,
  subscribeSyncDirty,
} from "./notify";
import { buildPush } from "./diff";
import { loadJournalStore } from "./journal";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * Collections and dependencies as first-class sync participants.
 *
 * They reach the engine differently from tabs — through a published event
 * rather than a commitStore diff, because their stores are mounted deep in
 * the tree and are documented to have exactly one live writer. These tests
 * exercise the whole path: publish, queue, push payload, remote apply, and
 * the no-loop guarantee.
 */

const T0 = 1_700_000_000_000;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const WS_B = "99999999-9999-4999-8999-999999999999";
const TAB_A = "22222222-2222-4222-8222-222222222222";
const TAB_B = "33333333-3333-4333-8333-333333333333";
const COLL_A = "44444444-4444-4444-8444-444444444444";
const COLL_B = "55555555-5555-4555-8555-555555555555";

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

function workspace(id = WS, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: "Local",
    createdAt: T0,
    updatedAt: T0,
    sections: [],
    groups: [],
    tabs: [tab({ id: TAB_A }), tab({ id: TAB_B })],
    ...over,
  };
}

function collection(id: string, over: Partial<Collection> = {}): Collection {
  return { id, workspaceId: WS, name: "Reading", tabIds: [], createdAt: T0, updatedAt: T0, ...over };
}

function dependency(parentTabId: string, childTabId: string, over: Partial<TabDependency> = {}): TabDependency {
  return {
    id: `dep-${parentTabId}::${childTabId}`,
    parentTabId,
    childTabId,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

class TestHost implements SyncEngineHost {
  userId: string | null = USER;
  workspaces = new Map<string, Workspace>([[WS, workspace()]]);
  collections: Collection[] = [];
  dependencies: TabDependency[] = [];
  remoteCommits: Workspace[] = [];

  getUserId() {
    return this.userId;
  }
  getWorkspace(id: string) {
    return this.workspaces.get(id) ?? null;
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
    this.remoteCommits.push(next);
    this.workspaces.set(next.id, next);
  }
}

type Call = { url: string; body: Record<string, unknown> | null };

class FakeServer {
  calls: Call[] = [];
  private readonly responses: (() => Response | Promise<Response>)[] = [];
  fallback: () => Response = () => json(200, { workspaceId: WS, changes: [], nextCursor: "0", hasMore: false });

  queue(make: () => Response | Promise<Response>): void {
    this.responses.push(make);
  }

  get fetch() {
    return async (path: string, init: RequestInit = {}) => {
      let body: Record<string, unknown> | null = null;
      if (typeof init.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      this.calls.push({ url: path, body });
      const next = this.responses.shift();
      return next ? next() : this.fallback();
    };
  }

  get pushes(): Call[] {
    return this.calls.filter((c) => c.url.startsWith("/api/sync/push"));
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let host: TestHost;
let server: FakeServer;
let clock = T0;

function makeEngine() {
  return new SyncEngine(host, { debounceMs: 0, now: () => clock });
}

/** Wires the module-level notifier to an engine, as useSyncEngine does. */
function connect(engine: SyncEngine): () => void {
  return subscribeSyncDirty((events) => engine.markEntitiesDirty(events));
}

async function migrate(engine: SyncEngine, workspaceId = WS, cursor = "10") {
  server.queue(() => json(201, { cursor, created: true }));
  await engine.migrateWorkspace(workspaceId);
  server.calls.length = 0;
}

function pushBody(index = 0): { upserts: { entityType: string; entity: Record<string, unknown> }[]; deletes: Record<string, unknown>[] } {
  return server.pushes[index].body as never;
}

beforeEach(() => {
  window.localStorage.clear();
  __resetSyncDirtyListenersForTests();
  clock = T0;
  host = new TestHost();
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  __resetSyncDirtyListenersForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("collection mutations schedule sync", () => {
  it("queues a created collection and pushes its current state", async () => {
    host.collections = [collection(COLL_A, { name: "Reading", tabIds: [TAB_A] })];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    expect(engine.getState(WS).dirty).toHaveLength(1);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    const body = pushBody();
    expect(body.upserts).toHaveLength(1);
    expect(body.upserts[0].entityType).toBe("collection");
    expect(body.upserts[0].entity.id).toBe(COLL_A);
    // Membership travels inside the collection payload; it is not separately
    // versioned server-side.
    expect(body.upserts[0].entity.tabIds).toEqual([TAB_A]);
    off();
  });

  it("coalesces rename, add, remove and rename again into one push", async () => {
    host.collections = [collection(COLL_A, { name: "Final", tabIds: [TAB_B] })];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    for (let i = 0; i < 4; i++) {
      publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    }
    // Four mutations, one dirty entry — the push sends current state, so
    // repeats add nothing.
    expect(engine.getState(WS).dirty).toHaveLength(1);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    expect(server.pushes).toHaveLength(1);
    expect(pushBody().upserts[0].entity.name).toBe("Final");
    off();
  });

  it("sends a tombstone for a deleted collection", async () => {
    host.collections = [collection(COLL_A)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    // Deleted locally: gone from the store, published as a deletion.
    host.collections = [];
    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: true }]);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    const body = pushBody();
    expect(body.upserts).toHaveLength(0);
    expect(body.deletes).toEqual([{ entityType: "collection", entityId: COLL_A }]);
    off();
  });

  it("does not resurrect a collection created and deleted before the first push", async () => {
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    host.collections = [collection(COLL_A)];
    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    host.collections = [];
    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: true }]);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    const body = pushBody();
    // The later intent wins, and the push carries no upsert that would
    // recreate it on the server.
    expect(body.upserts).toHaveLength(0);
    expect(body.deletes).toHaveLength(1);
    off();
  });

  it("treats a dirty collection missing from the store as a delete", async () => {
    // Belt and braces: even if the event said "changed", current state is
    // what the push describes.
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    host.collections = [];

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    expect(pushBody().deletes).toEqual([{ entityType: "collection", entityId: COLL_A }]);
    off();
  });
});

describe("dependency mutations schedule sync", () => {
  it("queues a created dependency under the workspace holding its parent tab", async () => {
    host.dependencies = [dependency(TAB_A, TAB_B)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    // The event carries no workspace: the dependency store is flat, so the
    // engine resolves it from the parent tab.
    publishSyncDirty([{ entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false }]);
    expect(engine.getState(WS).dirty).toHaveLength(1);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    const body = pushBody();
    expect(body.upserts[0].entityType).toBe("dependency");
    // Identity is the pair; no id is sent.
    expect(body.upserts[0].entity).toMatchObject({ parentTabId: TAB_A, childTabId: TAB_B });
    expect(body.upserts[0].entity).not.toHaveProperty("id");
    off();
  });

  it("drops an event whose parent tab belongs to no local workspace", async () => {
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([
      { entityType: "dependency", parentTabId: "66666666-6666-4666-8666-666666666666", childTabId: TAB_B, deleted: false },
    ]);
    // Guessing a workspace would push a relationship into one that does not
    // own it.
    expect(engine.getState(WS).dirty).toHaveLength(0);
    off();
  });

  it("coalesces repeated creation of the same pair", async () => {
    host.dependencies = [dependency(TAB_A, TAB_B)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    for (let i = 0; i < 5; i++) {
      publishSyncDirty([{ entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false }]);
    }
    expect(engine.getState(WS).dirty).toHaveLength(1);
    off();
  });

  it("sends a tombstone for a removed dependency", async () => {
    host.dependencies = [dependency(TAB_A, TAB_B)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: true }]);
    host.dependencies = [];

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    expect(pushBody().deletes).toEqual([
      { entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B },
    ]);
    off();
  });

  it("does not resurrect a dependency created and removed before the first push", async () => {
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    host.dependencies = [dependency(TAB_A, TAB_B)];
    publishSyncDirty([{ entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false }]);
    host.dependencies = [];
    publishSyncDirty([{ entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: true }]);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    const body = pushBody();
    expect(body.upserts).toHaveLength(0);
    expect(body.deletes).toHaveLength(1);
    off();
  });

  it("sends a delete when the tab it depended on is gone", async () => {
    // Deleting a tab prunes its dependencies from the local store; the
    // pending ref must still become a tombstone rather than an upsert of
    // something that no longer exists.
    host.dependencies = [dependency(TAB_A, TAB_B)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false }]);
    host.dependencies = [];
    host.workspaces.set(WS, workspace(WS, { tabs: [tab({ id: TAB_A })] }));

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    expect(pushBody().upserts).toHaveLength(0);
    expect(pushBody().deletes).toHaveLength(1);
    off();
  });
});

describe("no sync loop for remote collections and dependencies", () => {
  it("applies a remote collection without queueing it for upload", async () => {
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    const received: unknown[] = [];
    const offRemote = subscribeRemoteEntities((event) => received.push(event));

    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [
          {
            operation: "upsert",
            workspaceId: WS,
            cursor: "11",
            entityType: "collection",
            entityId: COLL_A,
            entity: { id: COLL_A, name: "From server", tabIds: [TAB_A], createdAt: T0, updatedAt: T0 },
          },
        ],
        nextCursor: "11",
        hasMore: false,
      })
    );
    await engine.syncWorkspace(WS);

    // Handed back to the store that owns it...
    expect(received).toHaveLength(1);
    // ...and nothing became dirty, so a second pass pushes nothing. This is
    // the collection equivalent of the Phase 5 tab loop test.
    expect(engine.getState(WS).dirty).toHaveLength(0);

    server.calls.length = 0;
    await engine.syncWorkspace(WS);
    expect(server.pushes).toHaveLength(0);

    offRemote();
    off();
  });

  it("applies a remote dependency without queueing it for upload", async () => {
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    const received: { dependencies?: readonly unknown[] }[] = [];
    const offRemote = subscribeRemoteEntities((event) => received.push(event));

    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [
          {
            operation: "upsert",
            workspaceId: WS,
            cursor: "11",
            entityType: "dependency",
            parentTabId: TAB_A,
            childTabId: TAB_B,
            entity: { parentTabId: TAB_A, childTabId: TAB_B, createdAt: T0, type: "reference" },
          },
        ],
        nextCursor: "11",
        hasMore: false,
      })
    );
    await engine.syncWorkspace(WS);

    expect(received[0]?.dependencies).toHaveLength(1);
    expect(engine.getState(WS).dirty).toHaveLength(0);

    server.calls.length = 0;
    await engine.syncWorkspace(WS);
    expect(server.pushes).toHaveLength(0);

    offRemote();
    off();
  });

  it("does not disturb the stores when a pull carries only tabs", async () => {
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    const received: unknown[] = [];
    const offRemote = subscribeRemoteEntities((event) => received.push(event));

    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [
          {
            operation: "upsert",
            workspaceId: WS,
            cursor: "11",
            entityType: "tab",
            entityId: TAB_A,
            entity: { id: TAB_A, url: `https://example.com/${TAB_A}`, title: "T" },
          },
        ],
        nextCursor: "11",
        hasMore: false,
      })
    );
    await engine.syncWorkspace(WS);

    // Nothing published, so neither store re-renders or re-persists.
    expect(received).toHaveLength(0);
    offRemote();
    off();
  });

  it("never feeds the remote channel back into the dirty channel", () => {
    const engine = makeEngine();
    const off = connect(engine);
    const dirtyEvents: unknown[] = [];
    const offDirty = subscribeSyncDirty((events) => dirtyEvents.push(...events));

    publishRemoteEntities({ collections: [{ id: COLL_A, workspaceId: WS }] });

    // The two channels are separate by construction; a remote publish can
    // never enqueue an upload.
    expect(dirtyEvents).toHaveLength(0);
    offDirty();
    off();
  });
});

describe("offline and restart durability", () => {
  it("keeps a pending collection change when the request fails", async () => {
    host.collections = [collection(COLL_A)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    server.queue(() => Promise.reject(new TypeError("Failed to fetch")));
    await engine.syncWorkspace(WS);

    expect(engine.getState(WS).status).toBe("offline");
    expect(engine.getState(WS).dirty).toHaveLength(1);
    off();
  });

  it("keeps a pending dependency change across a reload", async () => {
    host.dependencies = [dependency(TAB_A, TAB_B)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false }]);
    off();

    // A fresh engine over the same storage — what a reload produces.
    const reloaded = makeEngine();
    const state = reloaded.getState(WS);
    expect(state.dirty).toHaveLength(1);
    expect(state.dirty[0].ref).toEqual({
      entityType: "dependency",
      parentTabId: TAB_A,
      childTabId: TAB_B,
    });
  });

  it("keeps a pending collection DELETE across a reload", async () => {
    // The case a set-based journal has to get right: the tombstone intent
    // must be durable, or the entity silently survives on the server.
    host.collections = [collection(COLL_A)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: true }]);
    off();

    const reloaded = makeEngine();
    expect(reloaded.getState(WS).dirty[0]).toEqual({
      ref: { entityType: "collection", entityId: COLL_A },
      deleted: true,
    });
    expect(loadJournalStore().userId).toBe(USER);
  });
});

describe("multi-workspace and multi-device", () => {
  beforeEach(() => {
    host.workspaces.set(WS_B, workspace(WS_B, { tabs: [tab({ id: "77777777-7777-4777-8777-777777777777" })] }));
  });

  it("keeps collections in different workspaces independent", async () => {
    host.collections = [collection(COLL_A), collection(COLL_B, { workspaceId: WS_B })];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine, WS, "10");
    await migrate(engine, WS_B, "20");

    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    publishSyncDirty([{ entityType: "collection", entityId: COLL_B, workspaceId: WS_B, deleted: false }]);

    expect(engine.getState(WS).dirty).toHaveLength(1);
    expect(engine.getState(WS_B).dirty).toHaveLength(1);
    // Each workspace carries its own cursor and its own queue.
    expect(engine.getState(WS).cursor).toBe("10");
    expect(engine.getState(WS_B).cursor).toBe("20");
    off();
  });

  it("records a same-collection conflict rather than choosing a side", async () => {
    host.collections = [collection(COLL_A, { name: "Mine" })];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    server.queue(() =>
      json(409, {
        error: "Conflict.",
        serverCursor: "12",
        conflicts: [
          { entityType: "collection", entityId: COLL_A, baseCursor: "10", serverCursor: "12", reason: "changed-since-base" },
        ],
      })
    );
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.status).toBe("conflict");
    // The local version is untouched and still queued, so nothing is lost
    // whichever way the user resolves it.
    expect(host.collections[0].name).toBe("Mine");
    expect(state.dirty).toHaveLength(1);
    off();
  });
});

describe("cross-entity operations", () => {
  it("carries a tab, a collection and a dependency in one push", async () => {
    host.collections = [collection(COLL_A, { tabIds: [TAB_A] })];
    host.dependencies = [dependency(TAB_A, TAB_B)];
    const engine = makeEngine();
    const off = connect(engine);
    await migrate(engine);

    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    publishSyncDirty([
      { entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false },
      { entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false },
    ]);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    // One request, one workspace version — a bulk operation stays indivisible.
    expect(server.pushes).toHaveLength(1);
    const types = pushBody().upserts.map((u) => u.entityType);
    expect(types.sort()).toEqual(["collection", "dependency", "tab"]);
    off();
  });

  it("orders tabs before the collections and dependencies that reference them", () => {
    // The server's composite foreign keys require the tab to exist first.
    const { upserts } = buildPush(
      workspace(),
      [
        { ref: { entityType: "collection", entityId: COLL_A }, deleted: false },
        { ref: { entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B }, deleted: false },
        { ref: { entityType: "tab", entityId: TAB_A }, deleted: false },
      ],
      [collection(COLL_A)],
      [dependency(TAB_A, TAB_B)]
    );
    const types = upserts.map((u) => u.entityType);
    expect(types.indexOf("tab")).toBeLessThan(types.indexOf("collection"));
    expect(types.indexOf("tab")).toBeLessThan(types.indexOf("dependency"));
  });
});

describe("the queue stays bounded", () => {
  it("does not grow with repeated edits to the same entities", () => {
    const engine = makeEngine();
    const off = connect(engine);

    // Migrate so the workspace leaves never-synced and accepts dirty marks.
    server.queue(() => json(201, { cursor: "10", created: true }));
    void engine.migrateWorkspace(WS);

    for (let i = 0; i < 500; i++) {
      publishSyncDirty([
        { entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false },
        { entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false },
      ]);
    }

    // A thousand events, two entities. The set-based journal is what keeps
    // this from growing with edit count.
    expect(engine.getState(WS).dirty.length).toBeLessThanOrEqual(2);
    off();
  });
});

describe("the notifier itself", () => {
  it("delivers to every subscriber and unsubscribes cleanly", () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = subscribeSyncDirty((events) => a.push(...events));
    const offB = subscribeSyncDirty((events) => b.push(...events));

    publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    offA();
    publishSyncDirty([{ entityType: "collection", entityId: COLL_B, workspaceId: WS, deleted: false }]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    offB();
  });

  it("does not let one failing subscriber stop the others, or reach the caller", () => {
    const seen: unknown[] = [];
    const offBad = subscribeSyncDirty(() => {
      throw new Error("boom");
    });
    const offGood = subscribeSyncDirty((events) => seen.push(...events));

    // A mutation has already been applied locally by the time this runs; a
    // bookkeeping failure must not surface as a failed edit.
    expect(() =>
      publishSyncDirty([{ entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false }])
    ).not.toThrow();
    expect(seen).toHaveLength(1);

    offBad();
    offGood();
  });

  it("ignores an empty publish", () => {
    const seen: unknown[] = [];
    const off = subscribeSyncDirty((events) => seen.push(...events));
    publishSyncDirty([]);
    publishRemoteEntities({});
    expect(seen).toHaveLength(0);
    off();
  });
});

describe("anonymous users publish nothing to the network", () => {
  it("ignores collection and dependency events with no signed-in user", async () => {
    host.userId = null;
    const engine = makeEngine();
    const off = connect(engine);

    publishSyncDirty([
      { entityType: "collection", entityId: COLL_A, workspaceId: WS, deleted: false },
      { entityType: "dependency", parentTabId: TAB_A, childTabId: TAB_B, deleted: false },
    ]);
    await engine.syncWorkspace(WS);

    expect(server.calls).toHaveLength(0);
    expect(window.localStorage.getItem("tabdump:sync-journal:v1")).toBeNull();
    off();
  });
});
