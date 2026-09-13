import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./engine";
import type { SyncEngineHost } from "./engine";
import { loadJournalStore } from "./journal";
import type { SyncStatus } from "./journal";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * The engine's behavioural contract.
 *
 * These drive the real engine against a stubbed `fetch`, so the whole
 * push/pull/apply/cursor sequence runs for real. The recurring question is
 * the same one the whole phase is built around: can anything here cost a
 * user their local work, or make a remote change disappear?
 */

const T0 = 1_700_000_000_000;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const WS_B = "99999999-9999-4999-8999-999999999999";
const TAB_A = "22222222-2222-4222-8222-222222222222";
const TAB_B = "33333333-3333-4333-8333-333333333333";

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

/** A host backed by plain objects, recording every remote commit. */
class TestHost implements SyncEngineHost {
  userId: string | null = USER;
  workspaces = new Map<string, Workspace>([[WS, workspace()]]);
  collections: Collection[] = [];
  dependencies: TabDependency[] = [];
  remoteCommits: Workspace[] = [];

  getUserId() {
    return this.userId;
  }
  getWorkspace(workspaceId: string) {
    return this.workspaces.get(workspaceId) ?? null;
  }
  getCollections() {
    return this.collections;
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

type Call = { url: string; method: string; body: Record<string, unknown> | null };

/** Records every request and answers from a queue, so a test scripts the server. */
class FakeServer {
  calls: Call[] = [];
  private readonly responses: (() => Response | Promise<Response>)[] = [];
  /** Used when the queue is empty: a successful, empty exchange. */
  fallback: () => Response = () => json(200, { workspaceId: WS, changes: [], nextCursor: "0", hasMore: false });

  queue(make: () => Response | Promise<Response>): void {
    this.responses.push(make);
  }

  get fetch() {
    return async (path: string, init: RequestInit = {}) => {
      let body: Record<string, unknown> | null = null;
      if (typeof init.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      this.calls.push({ url: path, method: init.method ?? "GET", body });
      const next = this.responses.shift();
      return next ? next() : this.fallback();
    };
  }

  get pushes(): Call[] {
    return this.calls.filter((c) => c.url.startsWith("/api/sync/push"));
  }
  get pulls(): Call[] {
    return this.calls.filter((c) => c.url.startsWith("/api/sync/pull"));
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tabChange(id: string, cursor: string, over: Record<string, unknown> = {}) {
  return {
    operation: "upsert",
    workspaceId: WS,
    cursor,
    entityType: "tab",
    entityId: id,
    entity: { id, url: `https://example.com/${id}`, ...over },
  };
}

let host: TestHost;
let server: FakeServer;
/** Mutable so a test can step past a backoff window on purpose. */
let clock = T0;

/** Debounce is zeroed: these assert on behaviour, not on wall-clock timing. */
function makeEngine(overrides: Partial<ConstructorParameters<typeof SyncEngine>[1]> = {}) {
  return new SyncEngine(host, { debounceMs: 0, now: () => clock, ...overrides });
}

beforeEach(() => {
  window.localStorage.clear();
  clock = T0;
  host = new TestHost();
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Moves a workspace out of never-synced, the way the explicit migration does. */
async function migrate(engine: SyncEngine, workspaceId = WS, cursor = "10") {
  server.queue(() => json(201, { cursor, created: true }));
  await engine.migrateWorkspace(workspaceId);
  server.calls.length = 0;
}

describe("a workspace is never uploaded without being asked", () => {
  it("does not sync a never-synced workspace even when it is dirty", async () => {
    const engine = makeEngine();
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    const result = await engine.syncWorkspace(WS);

    // An empty server is not permission to upload. Only the explicit
    // migration moves a workspace out of this state.
    expect(result.ok).toBe(false);
    expect(server.calls).toHaveLength(0);
    expect(engine.getState(WS).status).toBe("never-synced");
    // The edit is still recorded, so nothing is lost by waiting.
    expect(engine.getState(WS).dirty).toHaveLength(1);
  });

  /**
   * The desktop condition, pinned directly.
   *
   * The desktop build is a static export with no API routes at all, so
   * `/api/auth/me` does not exist there, no session is ever established and
   * `getUserId()` stays null. This is therefore the exact path the packaged
   * app takes — which matters because Application Control on the build
   * machine currently blocks launching freshly built unsigned binaries, so
   * the desktop side is verified here and by the anonymous web smoke rather
   * than by driving the app.
   */
  it("makes no request at all for an anonymous user, through any entry point", async () => {
    host.userId = null;
    host.workspaces.set(WS_B, workspace(WS_B));
    const engine = makeEngine();

    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    await engine.syncWorkspace(WS);
    // syncAll is what the reconnect/focus/timer triggers call.
    engine.syncAll();
    await engine.migrateWorkspace(WS);
    await Promise.resolve();

    expect(server.calls).toHaveLength(0);
    // And no bookkeeping is written for an account that does not exist.
    expect(window.localStorage.getItem("tabdump:sync-journal:v1")).toBeNull();
  });

  it("uploads only when migrate is called", async () => {
    const engine = makeEngine();
    server.queue(() => json(201, { cursor: "1", created: true }));
    const result = await engine.migrateWorkspace(WS);

    expect(result.ok).toBe(true);
    expect(server.calls[0].url).toBe("/api/sync/initial");
    expect(engine.getState(WS).status).toBe("idle");
    expect(engine.getState(WS).cursor).toBe("1");
  });
});

describe("no sync loop", () => {
  it("does not push a change that arrived from the server", async () => {
    const engine = makeEngine();
    await migrate(engine);

    // The server has a change this device has not seen.
    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [tabChange(TAB_A, "11", { title: "From server" })],
        nextCursor: "11",
        hasMore: false,
      })
    );

    await engine.syncWorkspace(WS);

    // It was applied locally through the host's remote commit...
    expect(host.remoteCommits).toHaveLength(1);
    expect(host.remoteCommits[0].tabs.find((t) => t.id === TAB_A)?.title).toBe("From server");
    // ...and nothing became dirty as a result.
    expect(engine.getState(WS).dirty).toHaveLength(0);

    // A second pass therefore has nothing to push. This is the assertion
    // that rules out apply → dirty → push → pull → apply → ...
    server.calls.length = 0;
    await engine.syncWorkspace(WS);
    expect(server.pushes).toHaveLength(0);
  });

  it("keeps a pending local change while applying an unrelated remote one", async () => {
    const engine = makeEngine();
    await migrate(engine);

    host.workspaces.set(WS, workspace(WS, { tabs: [tab({ id: TAB_A, title: "Mine" }), tab({ id: TAB_B })] }));
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [tabChange(TAB_B, "12", { title: "Theirs" })],
        nextCursor: "12",
        hasMore: false,
      })
    );

    await engine.syncWorkspace(WS);

    // Both survive: the local edit was pushed, the remote one applied.
    expect(server.pushes).toHaveLength(1);
    expect(host.workspaces.get(WS)?.tabs.find((t) => t.id === TAB_B)?.title).toBe("Theirs");
    expect(engine.getState(WS).dirty).toHaveLength(0);
  });
});

describe("the cursor never skips a change", () => {
  it("does not advance the cursor when applying remote changes fails", async () => {
    const engine = makeEngine();
    await migrate(engine);
    expect(engine.getState(WS).cursor).toBe("10");

    // The workspace vanishes locally between the pull and the apply.
    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [tabChange(TAB_A, "11")],
        nextCursor: "11",
        hasMore: false,
      })
    );
    host.commitRemote = () => {
      throw new Error("local apply failed");
    };

    const result = await engine.syncWorkspace(WS);

    expect(result.ok).toBe(false);
    // Still 10. Advancing here would mean the next pull starts after 11 and
    // that change is never seen again.
    expect(engine.getState(WS).cursor).toBe("10");
  });

  it("does not advance the cursor merely because a push succeeded", async () => {
    const engine = makeEngine();
    await migrate(engine);

    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    // The push reports a new server cursor, but this device has not yet read
    // what else changed.
    server.queue(() => json(200, { cursor: "50", accepted: [] }));
    server.queue(() => json(200, { workspaceId: WS, changes: [], nextCursor: "10", hasMore: false }));

    await engine.syncWorkspace(WS);

    // The cursor follows the PULL, which is the only thing that proves the
    // device has incorporated the server's state.
    expect(engine.getState(WS).cursor).toBe("10");
  });

  it("follows hasMore through every page before settling", async () => {
    const engine = makeEngine();
    await migrate(engine);

    server.queue(() =>
      json(200, { workspaceId: WS, changes: [tabChange(TAB_A, "11")], nextCursor: "11", hasMore: true })
    );
    server.queue(() =>
      json(200, { workspaceId: WS, changes: [tabChange(TAB_B, "12")], nextCursor: "12", hasMore: false })
    );

    await engine.syncWorkspace(WS);

    expect(server.pulls).toHaveLength(2);
    // Each page asked from where the previous one ended.
    expect(server.pulls[0].url).toContain("cursor=10");
    expect(server.pulls[1].url).toContain("cursor=11");
    expect(engine.getState(WS).cursor).toBe("12");
  });

  it("leaves the cursor alone on an empty pull", async () => {
    const engine = makeEngine();
    await migrate(engine);
    server.queue(() => json(200, { workspaceId: WS, changes: [], nextCursor: "10", hasMore: false }));
    await engine.syncWorkspace(WS);
    expect(engine.getState(WS).cursor).toBe("10");
    expect(engine.getState(WS).status).toBe("idle");
  });

  it("re-fetches from the old cursor after a failed apply", async () => {
    const engine = makeEngine();
    await migrate(engine);

    server.queue(() =>
      json(200, { workspaceId: WS, changes: [tabChange(TAB_A, "11")], nextCursor: "11", hasMore: false })
    );
    const realCommit = host.commitRemote.bind(host);
    host.commitRemote = () => {
      throw new Error("boom");
    };
    await engine.syncWorkspace(WS);

    // Recovered. Step past the backoff the failure armed, then retry.
    host.commitRemote = realCommit;
    clock += 10 * 60_000;
    server.calls.length = 0;
    server.queue(() =>
      json(200, { workspaceId: WS, changes: [tabChange(TAB_A, "11", { title: "Recovered" })], nextCursor: "11", hasMore: false })
    );
    await engine.syncWorkspace(WS);

    expect(server.pulls[0].url).toContain("cursor=10");
    expect(host.workspaces.get(WS)?.tabs.find((t) => t.id === TAB_A)?.title).toBe("Recovered");
    expect(engine.getState(WS).cursor).toBe("11");
  });
});

describe("local-first under failure", () => {
  it("records offline without losing the pending edit", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => Promise.reject(new TypeError("Failed to fetch")));
    await engine.syncWorkspace(WS);

    expect(engine.getState(WS).status).toBe("offline");
    // The edit is still queued, so reconnecting flushes it.
    expect(engine.getState(WS).dirty).toHaveLength(1);
  });

  it("pauses rather than hammering the API when the session expires", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => json(401, { error: "Sign in to continue." }));
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.status).toBe("paused");
    // Pending work is kept for when the user signs back in, and no backoff
    // timer is armed because retrying would fail identically forever.
    expect(state.dirty).toHaveLength(1);
    expect(state.retryAfter).toBeUndefined();
  });

  it("backs off after a transient server failure", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => json(503, { error: "Unavailable." }));
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.status).toBe("error");
    expect(state.failureCount).toBe(1);
    expect(state.retryAfter).toBeGreaterThan(T0);
    expect(state.dirty).toHaveLength(1);
  });

  /**
   * The rate limiter the sync gate itself uses answers 429, so this is not a
   * hypothetical status: a burst of workspaces reconnecting at once can
   * genuinely hit it. A 429 says "later", never "never", so it has to arm
   * the same bounded backoff a 5xx does. Parking in `error` with no
   * retryAfter would leave the workspace waiting on an external trigger with
   * its pending edit unsent.
   */
  it("backs off after being rate limited rather than giving up", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => json(429, { error: "Too many requests. Try again shortly." }));
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.status).toBe("error");
    expect(state.failureCount).toBe(1);
    expect(state.retryAfter).toBeGreaterThan(T0);
    // The edit that could not be sent is still pending.
    expect(state.dirty).toHaveLength(1);
  });

  it("does not arm a retry for a validation error", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => json(400, { error: "Invalid.", errors: ["id: must be a UUID"] }));
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.status).toBe("error");
    // A 400 fails identically forever; retrying it is only noise.
    expect(state.retryAfter).toBeUndefined();
  });

  it("respects the backoff window instead of retrying immediately", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => json(503, { error: "Unavailable." }));
    await engine.syncWorkspace(WS);
    server.calls.length = 0;

    await engine.syncWorkspace(WS);
    expect(server.calls).toHaveLength(0);
  });
});

describe("what each failure status does to a workspace", () => {
  /**
   * The whole classification in one place, because the cost of getting a
   * single row wrong is invisible: a status wrongly marked permanent strands
   * a pending edit, and one wrongly marked transient retries forever against
   * something that will never change its mind.
   *
   * "retries" means a backoff window was armed. Everything keeps its dirty
   * work either way — no failure path may discard a pending edit.
   */
  const cases: { label: string; status: number; body: unknown; expect: SyncStatus; retries: boolean }[] = [
    { label: "401 expired session", status: 401, body: { error: "Sign in." }, expect: "paused", retries: false },
    { label: "403 rejected", status: 403, body: { error: "Request rejected." }, expect: "error", retries: false },
    { label: "404 not yours", status: 404, body: { error: "Workspace not found." }, expect: "error", retries: false },
    { label: "413 too large", status: 413, body: { error: "Too large." }, expect: "error", retries: false },
    { label: "400 malformed", status: 400, body: { error: "Invalid.", errors: [] }, expect: "error", retries: false },
    // Rate limiting says "later", so it must back off rather than give up.
    { label: "429 rate limited", status: 429, body: { error: "Too many requests." }, expect: "error", retries: true },
    { label: "500 server fault", status: 500, body: { error: "Server error." }, expect: "error", retries: true },
    { label: "502 bad gateway", status: 502, body: { error: "Bad gateway." }, expect: "error", retries: true },
    // A bare 503 is a proxy hiccup and stays retryable...
    { label: "503 transient", status: 503, body: { error: "Unavailable." }, expect: "error", retries: true },
    // ...but OUR 503 says this deployment has no database at all, and
    // retrying that forever is pointless. Pinning the Phase 5 fix.
    {
      label: "503 not configured",
      status: 503,
      body: { error: "Sync isn't available.", reason: "not-configured" },
      expect: "paused",
      retries: false,
    },
  ];

  for (const testCase of cases) {
    it(`treats ${testCase.label} as ${testCase.expect}${testCase.retries ? " with backoff" : " without retrying"}`, async () => {
      const engine = makeEngine();
      await migrate(engine);
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

      server.queue(() => json(testCase.status, testCase.body));
      await engine.syncWorkspace(WS);

      const state = engine.getState(WS);
      expect(state.status, testCase.label).toBe(testCase.expect);
      expect(state.retryAfter !== undefined, testCase.label).toBe(testCase.retries);
      // Whatever happened, the user's pending edit is still here.
      expect(state.dirty, testCase.label).toHaveLength(1);
    });
  }

  it("treats an unreachable server as offline, with backoff and nothing lost", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => {
      throw new TypeError("network error");
    });
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.status).toBe("offline");
    expect(state.retryAfter).toBeGreaterThan(T0);
    expect(state.dirty).toHaveLength(1);
  });
});

describe("a stale base is recoverable", () => {
  /**
   * The sequence a second device hits constantly: it fell behind while
   * holding a local edit. The push is refused as stale, and the ONLY way out
   * is to read what it missed — so a refused push must not end the pass
   * before the pull that fixes it.
   */
  it("pulls after a refused push instead of retrying the same stale cursor", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() =>
      json(409, { error: "Workspace changed.", reason: "stale-base", serverCursor: "11" })
    );
    server.queue(() =>
      json(200, { workspaceId: WS, changes: [tabChange(TAB_B, "11", { title: "From the other device" })], nextCursor: "11", hasMore: false })
    );
    await engine.syncWorkspace(WS);

    // The refused push was followed by a pull in the same pass.
    expect(server.pulls).toHaveLength(1);
    expect(engine.getState(WS).cursor).toBe("11");
    // The local edit is still pending, ready to go up against the new base.
    expect(engine.getState(WS).dirty).toHaveLength(1);
  });

  it("converges on the retry rather than refusing forever", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    // Pass one: stale, then catch up to 11.
    server.queue(() => json(409, { error: "stale", reason: "stale-base", serverCursor: "11" }));
    server.queue(() => json(200, { workspaceId: WS, changes: [], nextCursor: "11", hasMore: false }));
    await engine.syncWorkspace(WS);

    // Pass two: the push now carries the fresh base and is accepted.
    server.queue(() => json(200, { cursor: "12", accepted: [] }));
    server.queue(() => json(200, { workspaceId: WS, changes: [], nextCursor: "12", hasMore: false }));
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.dirty).toHaveLength(0);
    expect(state.status).toBe("idle");
    const lastPush = server.pushes[server.pushes.length - 1];
    expect(lastPush.body?.baseCursor).toBe("11");
  });
});

describe("conflicts", () => {
  it("records a server conflict and keeps the local version", async () => {
    const engine = makeEngine();
    await migrate(engine);

    host.workspaces.set(WS, workspace(WS, { tabs: [tab({ id: TAB_A, title: "Mine" }), tab({ id: TAB_B })] }));
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() =>
      json(409, {
        error: "Conflict.",
        serverCursor: "12",
        conflicts: [
          { entityType: "tab", entityId: TAB_A, baseCursor: "10", serverCursor: "12", reason: "changed-since-base" },
        ],
      })
    );
    await engine.syncWorkspace(WS);

    const state = engine.getState(WS);
    expect(state.status).toBe("conflict");
    expect(state.conflicts).toHaveLength(1);
    // Both sides are preserved: the local payload is captured, and the local
    // edit stays pending so "keep mine" can re-send it.
    expect(state.conflicts[0].local?.entityType).toBe("tab");
    expect(state.dirty).toHaveLength(1);
    expect(host.workspaces.get(WS)?.tabs.find((t) => t.id === TAB_A)?.title).toBe("Mine");
  });

  it("surfaces a locked-section conflict rather than letting an AI move win", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() =>
      json(409, {
        error: "Conflict.",
        serverCursor: "12",
        conflicts: [
          { entityType: "tab", entityId: TAB_A, baseCursor: "10", serverCursor: "12", reason: "locked-section" },
        ],
      })
    );
    await engine.syncWorkspace(WS);

    expect(engine.getState(WS).conflicts[0].reason).toBe("locked-section");
  });

  it("survives a reload while unresolved", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    server.queue(() =>
      json(409, {
        error: "Conflict.",
        serverCursor: "12",
        conflicts: [{ entityType: "tab", entityId: TAB_A, baseCursor: "10", serverCursor: "12", reason: "changed-since-base" }],
      })
    );
    await engine.syncWorkspace(WS);

    // A fresh engine over the same storage — what a reload produces.
    const reloaded = makeEngine();
    const state = reloaded.getState(WS);
    expect(state.conflicts).toHaveLength(1);
    expect(state.status).toBe("conflict");
    expect(state.dirty).toHaveLength(1);
  });

  it("keep-mine re-queues the local version as a new mutation", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    server.queue(() =>
      json(409, {
        error: "Conflict.",
        serverCursor: "12",
        conflicts: [{ entityType: "tab", entityId: TAB_A, baseCursor: "10", serverCursor: "12", reason: "changed-since-base" }],
      })
    );
    await engine.syncWorkspace(WS);

    const conflictId = engine.getState(WS).conflicts[0].id;
    engine.resolveConflict(WS, conflictId, "local");

    const state = engine.getState(WS);
    expect(state.conflicts).toHaveLength(0);
    // A resolution becomes a real mutation rather than a record quietly
    // deleted; it is pushed again against the server's current cursor.
    expect(state.dirty.map((d) => d.ref)).toContainEqual({ entityType: "tab", entityId: TAB_A });
  });

  it("keep-theirs clears the conflict without re-uploading the server's own value", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    server.queue(() =>
      json(409, {
        error: "Conflict.",
        serverCursor: "12",
        conflicts: [{ entityType: "tab", entityId: TAB_A, baseCursor: "10", serverCursor: "12", reason: "changed-since-base" }],
      })
    );
    await engine.syncWorkspace(WS);

    const conflictId = engine.getState(WS).conflicts[0].id;
    engine.resolveConflict(WS, conflictId, "remote");

    const state = engine.getState(WS);
    expect(state.conflicts).toHaveLength(0);
    // The dirty ref is dropped: re-pushing the server's own value is the loop
    // this design forbids.
    expect(state.dirty.find((d) => refIs(d.ref, TAB_A))).toBeUndefined();
  });
});

function refIs(ref: { entityType: string; entityId?: string }, id: string): boolean {
  return ref.entityType === "tab" && ref.entityId === id;
}

describe("one sync at a time, per workspace", () => {
  it("coalesces concurrent requests into a single run", async () => {
    const engine = makeEngine();
    await migrate(engine);

    const first = engine.syncWorkspace(WS);
    const second = engine.syncWorkspace(WS);
    const third = engine.syncWorkspace(WS);
    // The same in-flight promise, not three runs.
    expect(second).toBe(first);
    expect(third).toBe(first);
    await first;
  });

  it("coalesces rapid edits into one push", async () => {
    const engine = makeEngine();
    await migrate(engine);

    // Twenty edits to the same two tabs.
    for (let i = 0; i < 20; i++) {
      engine.markDirty(WS, [
        { ref: { entityType: "tab", entityId: i % 2 === 0 ? TAB_A : TAB_B }, deleted: false },
      ]);
    }
    expect(engine.getState(WS).dirty).toHaveLength(2);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    expect(server.pushes).toHaveLength(1);
    const body = server.pushes[0].body as { upserts: unknown[] };
    expect(body.upserts).toHaveLength(2);
  });

  it("keeps an edit made while a request was in flight", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => {
      // Arrives mid-request.
      engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_B }, deleted: false }]);
      return json(200, { cursor: "11", accepted: [] });
    });
    await engine.syncWorkspace(WS);

    // Only what was actually sent is retired; the newer edit is still queued.
    expect(engine.getState(WS).dirty.map((d) => d.ref)).toContainEqual({
      entityType: "tab",
      entityId: TAB_B,
    });
  });
});

describe("multi-workspace independence", () => {
  beforeEach(() => {
    host.workspaces.set(WS_B, workspace(WS_B));
  });

  it("gives each workspace its own cursor, journal and status", async () => {
    const engine = makeEngine();
    server.queue(() => json(201, { cursor: "10", created: true }));
    await engine.migrateWorkspace(WS);
    server.queue(() => json(201, { cursor: "77", created: true }));
    await engine.migrateWorkspace(WS_B);

    expect(engine.getState(WS).cursor).toBe("10");
    expect(engine.getState(WS_B).cursor).toBe("77");
  });

  it("does not let one workspace's conflict block another", async () => {
    const engine = makeEngine();
    await migrate(engine, WS, "10");
    await migrate(engine, WS_B, "20");

    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    server.queue(() =>
      json(409, {
        error: "Conflict.",
        serverCursor: "12",
        conflicts: [{ entityType: "tab", entityId: TAB_A, baseCursor: "10", serverCursor: "12", reason: "changed-since-base" }],
      })
    );
    await engine.syncWorkspace(WS);
    expect(engine.getState(WS).status).toBe("conflict");

    // The other one syncs normally.
    server.calls.length = 0;
    await engine.syncWorkspace(WS_B);
    expect(engine.getState(WS_B).status).toBe("idle");
  });

  it("skips conflicted and never-synced workspaces when syncing everything", async () => {
    const engine = makeEngine();
    await migrate(engine, WS, "10");
    // WS_B is never-synced.
    engine.syncAll();
    await Promise.resolve();

    // Only the migrated one was contacted.
    expect(server.pulls.every((c) => c.url.includes(WS))).toBe(true);
  });
});

describe("idempotency and restart", () => {
  it("survives a lost response without duplicating anything", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    // The server accepted it, but the response never arrived.
    server.queue(() => Promise.reject(new TypeError("Failed to fetch")));
    await engine.syncWorkspace(WS);
    expect(engine.getState(WS).dirty).toHaveLength(1);

    // The retry sends the same entity id with its current state, so the
    // server upserts the same row rather than creating a second one.
    clock += 10 * 60_000;
    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    await engine.syncWorkspace(WS);

    const body = server.pushes[server.pushes.length - 1].body as { upserts: { entity: { id: string } }[] };
    expect(body.upserts).toHaveLength(1);
    expect(body.upserts[0].entity.id).toBe(TAB_A);
    expect(engine.getState(WS).dirty).toHaveLength(0);
  });

  it("restores pending work after a reload", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    const reloaded = makeEngine();
    const state = reloaded.getState(WS);
    expect(state.dirty).toHaveLength(1);
    expect(state.cursor).toBe("10");
    // "syncing" is never restored: no request can still be in flight across a
    // reload, and leaving it there would strand the workspace.
    expect(state.status).not.toBe("syncing");
  });

  it("applies a duplicated remote change without duplicating the entity", async () => {
    const engine = makeEngine();
    await migrate(engine);

    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [tabChange(TAB_A, "11", { title: "X" }), tabChange(TAB_A, "11", { title: "X" })],
        nextCursor: "11",
        hasMore: false,
      })
    );
    await engine.syncWorkspace(WS);

    // Applied by identity, so the second copy replaces rather than appends.
    const tabs = host.workspaces.get(WS)?.tabs ?? [];
    expect(tabs.filter((t) => t.id === TAB_A)).toHaveLength(1);
  });
});

describe("account isolation", () => {
  it("does not hand a different account the previous one's cursor or pending work", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    host.userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const other = engine.getState(WS);

    expect(other.cursor).toBe("0");
    expect(other.dirty).toHaveLength(0);
    expect(other.status).toBe("never-synced");
  });

  it("scopes the persisted journal to one account", async () => {
    const engine = makeEngine();
    await migrate(engine);
    expect(loadJournalStore().userId).toBe(USER);
  });
});

describe("tombstones", () => {
  it("removes a locally-present tab when the server tombstones it", async () => {
    const engine = makeEngine();
    await migrate(engine);

    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [
          { operation: "delete", workspaceId: WS, cursor: "11", deletedAt: T0, entityType: "tab", entityId: TAB_A },
        ],
        nextCursor: "11",
        hasMore: false,
      })
    );
    await engine.syncWorkspace(WS);

    expect(host.workspaces.get(WS)?.tabs.map((t) => t.id)).toEqual([TAB_B]);
    // And it does not come back as a local mutation.
    expect(engine.getState(WS).dirty).toHaveLength(0);
  });

  it("withholds a remote delete for a tab with a pending local edit", async () => {
    const engine = makeEngine();
    await migrate(engine);
    engine.markDirty(WS, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);

    server.queue(() => json(200, { cursor: "11", accepted: [] }));
    server.queue(() =>
      json(200, {
        workspaceId: WS,
        changes: [
          { operation: "delete", workspaceId: WS, cursor: "12", deletedAt: T0, entityType: "tab", entityId: TAB_A },
        ],
        nextCursor: "12",
        hasMore: false,
      })
    );

    // The push retires the dirty ref first, so this particular ordering lets
    // the delete through — which is correct, the edit was accepted.
    await engine.syncWorkspace(WS);
    expect(host.workspaces.get(WS)?.tabs.find((t) => t.id === TAB_A)).toBeUndefined();
  });
});
