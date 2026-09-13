import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverWorkspaces, initialSync, pullChanges, pushChanges } from "./client";
import { buildWorkspaceUpserts, fromTabPayload, toTabPayload, toWorkspacePayload } from "./serialize";
import {
  clearSyncMeta,
  defaultSyncMetaStore,
  getWorkspaceSyncMeta,
  loadSyncMeta,
  saveSyncMeta,
  setWorkspaceSyncMeta,
} from "./metadata";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * The browser half: serialization, the network service, and the device-local
 * bookkeeping.
 *
 * The recurring assertion is that failure costs nothing. Every network
 * outcome — offline, 500, 409, 401 — has to come back as a result the caller
 * can act on, never as an exception and never as a reason to touch local
 * data.
 */

const T0 = 1_700_000_000_000;
const WS = "11111111-1111-4111-8111-111111111111";
const TAB_A = "22222222-2222-4222-8222-222222222222";
const TAB_B = "33333333-3333-4333-8333-333333333333";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com/a",
    normalizedUrl: "https://example.com/a",
    domain: "example.com",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function workspace(): Workspace {
  return {
    id: WS,
    name: "W",
    createdAt: T0,
    updatedAt: T0,
    sections: [{ id: "44444444-4444-4444-8444-444444444444", parentId: null, name: "S", source: "ai", createdAt: T0, updatedAt: T0 }],
    groups: [{ id: "55555555-5555-4555-8555-555555555555", name: "G", createdAt: T0, updatedAt: T0 }],
    tabs: [tab({ id: TAB_A }), tab({ id: TAB_B, url: "https://example.com/a" })],
  };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serialization drops what the wire deliberately omits", () => {
  it("does not send derived fields", () => {
    const payload = toTabPayload(
      tab({ id: TAB_A, title: "T", isDuplicate: true, favicon: "https://example.com/icon.png" })
    );
    // Phase 3 decided these four are derived or unread; sending them would
    // invite the server to store something the client recomputes anyway.
    expect(payload).not.toHaveProperty("normalizedUrl");
    expect(payload).not.toHaveProperty("domain");
    expect(payload).not.toHaveProperty("isDuplicate");
    expect(payload).not.toHaveProperty("favicon");
    expect(payload.title).toBe("T");
  });

  it("keeps a tab's identity and URL exactly", () => {
    const url = "https://example.com/foo_bar?x=1#frag";
    const payload = toTabPayload(tab({ id: TAB_A, url }));
    expect(payload.id).toBe(TAB_A);
    expect(payload.url).toBe(url);
  });

  it("round-trips a tab without changing its id or URL", () => {
    // The identity test: a client UUID goes out and the same UUID comes back.
    // No remapping happens merely because the entity visited the server.
    const original = tab({ id: TAB_A, url: "https://example.com/foo_bar", title: "T", isFavorite: true });
    const restored = fromTabPayload(toTabPayload(original))!;
    expect(restored.id).toBe(TAB_A);
    expect(restored.url).toBe("https://example.com/foo_bar");
    expect(restored.title).toBe("T");
    expect(restored.isFavorite).toBe(true);
    expect(restored.createdAt).toBe(T0);
    // Recomputed locally rather than transported.
    expect(restored.domain).toBe("example.com");
    expect(restored.normalizedUrl).toBeTruthy();
  });

  it("refuses to restore a tab whose URL is not http(s)", () => {
    expect(fromTabPayload({ id: TAB_A, url: "javascript:alert(1)" })).toBeNull();
  });

  it("orders upserts so references exist before the entities that use them", () => {
    const upserts = buildWorkspaceUpserts({ workspace: workspace(), collections: [], dependencies: [] });
    const types = upserts.map((u) => u.entityType);
    expect(types.indexOf("section")).toBeLessThan(types.indexOf("tab"));
    expect(types.indexOf("group")).toBeLessThan(types.indexOf("tab"));
  });

  it("keeps two tabs with the same URL as two upserts", () => {
    const upserts = buildWorkspaceUpserts({ workspace: workspace(), collections: [], dependencies: [] });
    const tabs = upserts.filter((u) => u.entityType === "tab");
    expect(tabs).toHaveLength(2);
  });

  it("skips a tab the app itself would refuse to open, without failing the workspace", () => {
    const ws = workspace();
    ws.tabs.push(tab({ id: "66666666-6666-4666-8666-666666666666", url: "javascript:alert(1)" }));
    const upserts = buildWorkspaceUpserts({ workspace: ws, collections: [], dependencies: [] });
    // A legacy unsafe URL must not make the other two tabs unsyncable.
    expect(upserts.filter((u) => u.entityType === "tab")).toHaveLength(2);
  });

  it("drops a dependency whose endpoint was skipped", () => {
    const ws = workspace();
    const unsafe = "66666666-6666-4666-8666-666666666666";
    ws.tabs.push(tab({ id: unsafe, url: "javascript:alert(1)" }));
    const upserts = buildWorkspaceUpserts({
      workspace: ws,
      collections: [],
      dependencies: [{ id: `dep-${TAB_A}::${unsafe}`, parentTabId: TAB_A, childTabId: unsafe, createdAt: T0 }],
    });
    // Sending it would be a foreign key violation that fails the whole upload.
    expect(upserts.filter((u) => u.entityType === "dependency")).toHaveLength(0);
  });

  it("omits a workspace logo that is absent rather than sending null", () => {
    expect(toWorkspacePayload(workspace())).not.toHaveProperty("logo");
  });
});

describe("network failure never costs local data", () => {
  it("reports offline rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await pullChanges(WS, "0");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("offline");
    // The message a user could actually be shown.
    expect(result.failure.message).toContain("safe on this device");
  });

  it("reports a 500 as a server failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(500, { error: "boom" })));
    const result = await pushChanges(WS, "1", [], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("server");
  });

  it("survives a non-JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }))
    );
    const result = await pullChanges(WS, "0");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("server");
  });

  it("distinguishes the failures a caller must handle differently", async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: "Sign in." }, "unauthenticated"],
      // Only OUR 503 carries `reason`, and only that one means "this
      // deployment has no database". A bare 503 is a proxy or load balancer
      // hiccup and stays retryable — see the switch in ./client.ts.
      [503, { error: "Not configured.", reason: "not-configured" }, "not-configured"],
      [503, { error: "Service Unavailable" }, "server"],
      [404, { error: "Workspace not found." }, "not-found"],
      [400, { error: "Invalid.", errors: ["id: must be a UUID"] }, "invalid"],
      [409, { error: "Stale.", reason: "stale-base", serverCursor: "18" }, "stale-base"],
      [409, { error: "Conflict.", conflicts: [] }, "conflict"],
      // A 409 whose reason says the account already owns the workspace is
      // not a disagreement: the caller adopts rather than resolving.
      [409, { error: "Already there.", reason: "already-exists", serverCursor: "7" }, "already-exists"],
    ];
    for (const [status, body, kind] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(status, body)));
      const result = await pushChanges(WS, "17", [], []);
      expect(result.ok, kind).toBe(false);
      if (result.ok) continue;
      expect(result.failure.kind).toBe(kind);
    }
  });

  it("surfaces the server cursor when the workspace already exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(409, { error: "Already there.", reason: "already-exists", serverCursor: "7" }))
    );
    const result = await initialSync({ workspace: workspace(), collections: [], dependencies: [] }, null);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure).toMatchObject({ kind: "already-exists", serverCursor: "7" });
  });

  it("surfaces the server cursor on a stale base so the caller can pull", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(respond(409, { error: "Stale.", reason: "stale-base", serverCursor: "18" }))
    );
    const result = await pushChanges(WS, "17", [], []);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure).toMatchObject({ kind: "stale-base", serverCursor: "18" });
  });
});

describe("requests", () => {
  it("sends the session cookie and nothing resembling a user id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(201, { cursor: "1", created: true }));
    vi.stubGlobal("fetch", fetchMock);

    await initialSync({ workspace: workspace(), collections: [], dependencies: [] }, null);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/sync/initial");
    expect(init.credentials).toBe("same-origin");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Identity comes from the cookie; there is no field here to forge.
    expect(body).not.toHaveProperty("userId");
    expect(body.workspace).toMatchObject({ id: WS });
  });

  it("passes knownCursor so a retry is idempotent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { cursor: "5", created: false }));
    vi.stubGlobal("fetch", fetchMock);

    await initialSync({ workspace: workspace(), collections: [], dependencies: [] }, "5");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.knownCursor).toBe("5");
  });

  it("discovers workspaces with a bare authenticated GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      respond(200, { workspaces: [{ id: WS, name: "W", createdAt: 1, updatedAt: 2 }], truncated: false })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverWorkspaces();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ id: WS, name: "W", createdAt: 1, updatedAt: 2 }]);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/sync/workspaces");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    // Identity rides the HttpOnly cookie; nothing here names a user.
    expect(init.credentials).toBe("same-origin");
    expect(JSON.stringify(init)).not.toContain(USER);
  });

  it("drops a malformed discovery row rather than losing the whole list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond(200, {
          workspaces: [{ id: WS, name: "Good", createdAt: 1, updatedAt: 2 }, { name: "no id" }, null, "nonsense"],
        })
      )
    );

    const result = await discoverWorkspaces();
    if (!result.ok) throw new Error("expected success");
    expect(result.value.map((w) => w.id)).toEqual([WS]);
  });

  it("reports a discovery failure rather than pretending the account is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));

    const result = await discoverWorkspaces();

    // Emphatically not `{ ok: true, value: [] }` — "I could not ask" and
    // "you own nothing" must never look the same to a caller deciding
    // whether to offer adoption.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("offline");
  });

  it("pulls with a query string and never a body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(respond(200, { workspaceId: WS, changes: [], nextCursor: "7", hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pullChanges(WS, "3");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/sync/pull?workspaceId=${WS}&cursor=3`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextCursor).toBe("7");
  });
});

describe("device-local sync metadata", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts as never-synced, which is not the same as deleted", () => {
    const meta = getWorkspaceSyncMeta(defaultSyncMetaStore(), USER, WS);
    expect(meta.state).toBe("never-synced");
    expect(meta.cursor).toBe("0");
  });

  it("round-trips through localStorage", () => {
    const store = setWorkspaceSyncMeta(defaultSyncMetaStore(), USER, {
      workspaceId: WS,
      serverWorkspaceId: WS,
      state: "synced",
      cursor: "42",
      lastSyncedAt: T0,
    });
    expect(saveSyncMeta(store)).toBe(true);
    expect(getWorkspaceSyncMeta(loadSyncMeta(), USER, WS)).toMatchObject({ state: "synced", cursor: "42" });
  });

  it("does not hand one account another account's cursor", () => {
    const store = setWorkspaceSyncMeta(defaultSyncMetaStore(), USER, {
      workspaceId: WS,
      serverWorkspaceId: WS,
      state: "synced",
      cursor: "42",
    });
    // A cursor from another account would ask the server about a workspace
    // this user does not own.
    const other = getWorkspaceSyncMeta(store, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", WS);
    expect(other.state).toBe("never-synced");
    expect(other.cursor).toBe("0");
  });

  it("keeps separate cursors per workspace, and per device by construction", () => {
    let store = setWorkspaceSyncMeta(defaultSyncMetaStore(), USER, {
      workspaceId: WS,
      serverWorkspaceId: WS,
      state: "synced",
      cursor: "42",
    });
    store = setWorkspaceSyncMeta(store, USER, {
      workspaceId: TAB_A,
      serverWorkspaceId: TAB_A,
      state: "synced",
      cursor: "57",
    });
    expect(getWorkspaceSyncMeta(store, USER, WS).cursor).toBe("42");
    expect(getWorkspaceSyncMeta(store, USER, TAB_A).cursor).toBe("57");
  });

  it("is pure — setWorkspaceSyncMeta writes nothing", () => {
    const before = defaultSyncMetaStore();
    setWorkspaceSyncMeta(before, USER, {
      workspaceId: WS,
      serverWorkspaceId: WS,
      state: "synced",
      cursor: "42",
    });
    expect(before.workspaces).toEqual({});
    expect(window.localStorage.getItem("tabdump:sync-meta:v1")).toBeNull();
  });

  it("survives a corrupted blob rather than preventing startup", () => {
    window.localStorage.setItem("tabdump:sync-meta:v1", "{ not json");
    expect(loadSyncMeta()).toEqual(defaultSyncMetaStore());

    window.localStorage.setItem(
      "tabdump:sync-meta:v1",
      JSON.stringify({ version: 1, userId: USER, workspaces: { [WS]: { nonsense: true } } })
    );
    // The bad entry is dropped, costing a re-pull and nothing else.
    expect(loadSyncMeta().workspaces).toEqual({});
  });

  it("lives outside workspace data, so it cannot reach an export", () => {
    saveSyncMeta(
      setWorkspaceSyncMeta(defaultSyncMetaStore(), USER, {
        workspaceId: WS,
        serverWorkspaceId: WS,
        state: "synced",
        cursor: "42",
      })
    );
    // Its own key: the export reads tabdump:workspaces:v1 and knows nothing
    // about this one, so the file format needs no change.
    expect(window.localStorage.getItem("tabdump:sync-meta:v1")).toBeTruthy();
    expect(window.localStorage.getItem("tabdump:workspaces:v1")).toBeNull();
  });

  it("forgets everything on sign-out", () => {
    saveSyncMeta(
      setWorkspaceSyncMeta(defaultSyncMetaStore(), USER, {
        workspaceId: WS,
        serverWorkspaceId: WS,
        state: "synced",
        cursor: "42",
      })
    );
    clearSyncMeta();
    expect(window.localStorage.getItem("tabdump:sync-meta:v1")).toBeNull();
  });
});
