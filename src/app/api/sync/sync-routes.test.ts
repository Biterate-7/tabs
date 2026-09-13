import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAuthStoreForTests, MemoryAuthStore } from "@/lib/auth/store";
import { __setSyncServiceForTests } from "@/lib/sync/store";
import { __clearRateLimitsForTests } from "@/lib/ai/server/rate-limit";
import type { SyncService } from "@/lib/sync/service";

/**
 * The security matrix for the sync API, exercised through the real route
 * handlers.
 *
 * The database is faked here, so these do NOT prove SQL behaviour —
 * ./sync-routes.pg.test.ts drives the same handlers against a real
 * PostgreSQL server with real session rows for that. What they DO prove is
 * everything that happens
 * before and around it: that an unauthenticated request never reaches the
 * service, that a body-supplied user id is ignored, that ownership decides
 * 404, that oversized and malformed payloads are refused, and that the CSRF
 * shape matches the existing auth routes. That is where an API-level
 * security defect actually lives.
 */

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const TAB = "22222222-2222-4222-8222-222222222222";
const T0 = 1_700_000_000_000;

/** Records what the routes asked the service to do, and answers however a test wants. */
class FakeSyncService {
  initialCalls: { userId: string; workspaceId: string; knownCursor: string | null }[] = [];
  pushCalls: { userId: string; workspaceId: string; baseCursor: string }[] = [];
  pullCalls: { userId: string; workspaceId: string; cursor: string }[] = [];
  listCalls: { userId: string }[] = [];

  initialResult: unknown = { ok: true, workspace: { id: WS }, cursor: "1", created: true };
  pushResult: unknown = { ok: true, cursor: "2", accepted: [] };
  pullResult: unknown = { workspaceId: WS, changes: [], nextCursor: "0", hasMore: false };
  listResult: { id: string; name: string; createdAt: number; updatedAt: number }[] = [
    { id: WS, name: "W", createdAt: T0, updatedAt: T0 },
  ];

  async initial(payload: { workspace: { id: string } }, userId: string, knownCursor: string | null) {
    this.initialCalls.push({ userId, workspaceId: payload.workspace.id, knownCursor });
    return this.initialResult;
  }
  async push(workspaceId: string, userId: string, baseCursor: string) {
    this.pushCalls.push({ userId, workspaceId, baseCursor });
    return this.pushResult;
  }
  async pull(workspaceId: string, userId: string, cursor: string) {
    this.pullCalls.push({ userId, workspaceId, cursor });
    return this.pullResult;
  }
  async listWorkspaces(userId: string) {
    this.listCalls.push({ userId });
    return this.listResult;
  }
}

let service: FakeSyncService;
let store: MemoryAuthStore;
let sessionCookie: string;

/** A real session in the real MemoryAuthStore, so requireUser resolves exactly as it does in production. */
async function signIn(): Promise<string> {
  const { createSession } = await import("@/lib/auth/session");
  const { SESSION_COOKIE } = await import("@/lib/auth/config");
  const user = await store.createUser({
    id: USER_A,
    googleSub: "sub-a",
    email: "a@example.com",
    name: "A",
    avatarUrl: null,
  });
  const { token } = await createSession(store, user.id);
  return `${SESSION_COOKIE}=${token}`;
}

function post(path: string, body: unknown, opts: { cookie?: string; contentType?: string; origin?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
    origin: opts.origin ?? "http://localhost:3000",
    // A real request always carries Host; without it isSameOrigin has no
    // target to compare an Origin against and correctly declines to guess.
    host: "localhost:3000",
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function get(path: string, opts: { cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: "http://localhost:3000", host: "localhost:3000" };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`http://localhost:3000${path}`, { method: "GET", headers });
}

function workspacePayload() {
  return { id: WS, name: "W", createdAt: T0, updatedAt: T0 };
}

beforeEach(async () => {
  __clearRateLimitsForTests();
  store = new MemoryAuthStore();
  __setAuthStoreForTests(store);
  service = new FakeSyncService();
  __setSyncServiceForTests(service as unknown as SyncService);
  sessionCookie = await signIn();
});

afterEach(() => {
  __setAuthStoreForTests(undefined);
  __setSyncServiceForTests(undefined);
  vi.restoreAllMocks();
});

describe("authentication", () => {
  it("refuses an unauthenticated push with 401 and never reaches the service", async () => {
    const { POST } = await import("./push/route");
    const response = await POST(post("/api/sync/push", { workspaceId: WS, baseCursor: "1" }));
    expect(response.status).toBe(401);
    expect(service.pushCalls).toHaveLength(0);
  });

  it("refuses an unauthenticated initial sync", async () => {
    const { POST } = await import("./initial/route");
    const response = await POST(post("/api/sync/initial", { workspace: workspacePayload() }));
    expect(response.status).toBe(401);
    expect(service.initialCalls).toHaveLength(0);
  });

  it("refuses an unauthenticated pull", async () => {
    const { GET } = await import("./pull/route");
    const response = await GET(get(`/api/sync/pull?workspaceId=${WS}&cursor=0`));
    expect(response.status).toBe(401);
    expect(service.pullCalls).toHaveLength(0);
  });

  it("lets an authenticated owner through", async () => {
    const { POST } = await import("./push/route");
    const response = await POST(
      post("/api/sync/push", { workspaceId: WS, baseCursor: "1", upserts: [], deletes: [] }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(200);
    expect(service.pushCalls[0].userId).toBe(USER_A);
  });
});

describe("workspace discovery", () => {
  it("refuses an unauthenticated request and never reaches the service", async () => {
    const { GET } = await import("./workspaces/route");
    const response = await GET(get("/api/sync/workspaces"));
    expect(response.status).toBe(401);
    expect(service.listCalls).toHaveLength(0);
  });

  it("lists for the session's user, never one named by the request", async () => {
    const { GET } = await import("./workspaces/route");
    const response = await GET(
      get("/api/sync/workspaces?userId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { cookie: sessionCookie })
    );

    expect(response.status).toBe(200);
    // The query parameter is not merely rejected — it is never consulted.
    expect(service.listCalls).toEqual([{ userId: USER_A }]);
    const body = (await response.json()) as { workspaces: { id: string }[] };
    expect(body.workspaces.map((w) => w.id)).toEqual([WS]);
  });

  it("refuses an expired session", async () => {
    const { SESSION_TTL_MS } = await import("@/lib/auth/config");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    try {
      const { GET } = await import("./workspaces/route");
      const response = await GET(get("/api/sync/workspaces", { cookie: sessionCookie }));
      expect(response.status).toBe(401);
      expect(service.listCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Bounded: a list endpoint must not become an unbounded response. */
  it("caps how many workspaces it will return", async () => {
    const { MAX_DISCOVERED_WORKSPACES, GET } = await import("./workspaces/route");
    service.listResult = Array.from({ length: MAX_DISCOVERED_WORKSPACES + 5 }, (_, i) => ({
      id: WS,
      name: `W${i}`,
      createdAt: T0,
      updatedAt: T0,
    }));

    const response = await GET(get("/api/sync/workspaces", { cookie: sessionCookie }));
    const body = (await response.json()) as { workspaces: unknown[]; truncated: boolean };

    expect(body.workspaces).toHaveLength(MAX_DISCOVERED_WORKSPACES);
    expect(body.truncated).toBe(true);
  });

  it("answers 500 without leaking the internal error", async () => {
    const { GET } = await import("./workspaces/route");
    service.listWorkspaces = async () => {
      throw new Error("connection to 10.0.0.5:5432 refused");
    };

    const response = await GET(get("/api/sync/workspaces", { cookie: sessionCookie }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("5432");
  });

  it("shares the rate limiter the other sync routes use", async () => {
    const { AUTH_RATE_LIMIT } = await import("@/lib/auth/rate-limit");
    const { GET } = await import("./workspaces/route");

    const request = () =>
      new Request("http://localhost:3000/api/sync/workspaces", {
        method: "GET",
        headers: {
          origin: "http://localhost:3000",
          host: "localhost:3000",
          cookie: sessionCookie,
          "x-forwarded-for": "203.0.113.44",
        },
      });

    let limited: Response | null = null;
    for (let i = 0; i < AUTH_RATE_LIMIT.limit + 1; i++) {
      const response = await GET(request());
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("an existing workspace is not a conflict", () => {
  /**
   * The distinction the client depends on: `already-exists` means "this
   * account owns it, adopt it", while `conflict` means "something
   * disagrees". Collapsing them sent a second device into conflict handling
   * with nothing to resolve.
   */
  it("answers already-exists rather than conflict when the workspace is there", async () => {
    service.initialResult = { ok: false, reason: "already-exists", serverCursor: "7" };
    const { POST } = await import("./initial/route");

    const response = await POST(
      post("/api/sync/initial", { workspace: workspacePayload() }, { cookie: sessionCookie })
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; serverCursor: string };
    expect(body.reason).toBe("already-exists");
    expect(body.serverCursor).toBe("7");
  });

  it("still answers conflict for a genuine one", async () => {
    service.initialResult = { ok: false, reason: "conflict", serverCursor: "7" };
    const { POST } = await import("./initial/route");

    const response = await POST(
      post("/api/sync/initial", { workspace: workspacePayload() }, { cookie: sessionCookie })
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { reason: string }).reason).toBe("conflict");
  });
});

describe("a session that is no longer good", () => {
  /**
   * Expiry is decided server-side from the stored session, never from
   * anything the client sends, so this is the real check rather than a
   * cookie attribute a browser could be talked out of honouring.
   */
  it("refuses an expired session and never reaches the service", async () => {
    const { SESSION_TTL_MS } = await import("@/lib/auth/config");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    try {
      const { POST } = await import("./push/route");
      const response = await POST(
        post("/api/sync/push", { workspaceId: WS, baseCursor: "1" }, { cookie: sessionCookie })
      );
      expect(response.status).toBe(401);
      expect(service.pushCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The property that matters is not that every 401 is byte-identical — a
   * caller always knows whether it sent a cookie at all. It is that a
   * cookie which WAS presented and refused reveals nothing about WHY:
   * forged, expired and revoked must be indistinguishable, or the endpoint
   * becomes an oracle for which tokens once existed.
   */
  it("does not say whether a presented session was forged, expired or revoked", async () => {
    const { SESSION_COOKIE, SESSION_TTL_MS } = await import("@/lib/auth/config");
    const { createSession } = await import("@/lib/auth/session");
    const { POST } = await import("./push/route");

    const attempt = async (cookie: string) => {
      const response = await POST(post("/api/sync/push", { workspaceId: WS, baseCursor: "1" }, { cookie }));
      expect(response.status).toBe(401);
      return JSON.stringify(await response.json());
    };

    const forged = await attempt(`${SESSION_COOKIE}=not-a-real-token`);

    // A genuine token whose session was revoked elsewhere.
    const revokedSession = await createSession(store, USER_A);
    await store.deleteSessionsForUser(USER_A);
    const revoked = await attempt(`${SESSION_COOKIE}=${revokedSession.token}`);

    // A genuine token that simply ran out.
    const expiringSession = await createSession(store, USER_A);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    let expired: string;
    try {
      expired = await attempt(`${SESSION_COOKIE}=${expiringSession.token}`);
    } finally {
      vi.useRealTimers();
    }

    expect(new Set([forged, revoked, expired]).size).toBe(1);
    expect(service.pushCalls).toHaveLength(0);
  });

  /** Signing out on another device revokes the session this one is holding. */
  it("refuses a session revoked from another device", async () => {
    await store.deleteSessionsForUser(USER_A);
    const { GET } = await import("./pull/route");
    const response = await GET(get(`/api/sync/pull?workspaceId=${WS}&cursor=0`, { cookie: sessionCookie }));
    expect(response.status).toBe(401);
    expect(service.pullCalls).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  /**
   * The sync gate shares the auth limiter, so a client CAN rate-limit
   * itself. What matters is that the refusal is a 429 carrying retry-after —
   * the shape a client can back off from — rather than something it would
   * treat as permanent.
   */
  it("answers 429 with a retry-after once the window is exhausted", async () => {
    const { AUTH_RATE_LIMIT } = await import("@/lib/auth/rate-limit");
    const { GET } = await import("./pull/route");
    const ip = { "x-forwarded-for": "203.0.113.9" };

    const request = () => {
      const headers: Record<string, string> = {
        origin: "http://localhost:3000",
        host: "localhost:3000",
        cookie: sessionCookie,
        ...ip,
      };
      return new Request(`http://localhost:3000/api/sync/pull?workspaceId=${WS}&cursor=0`, {
        method: "GET",
        headers,
      });
    };

    let limited: Response | null = null;
    for (let i = 0; i < AUTH_RATE_LIMIT.limit + 1; i++) {
      const response = await GET(request());
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("identity comes from the session, never the body", () => {
  it("ignores a forged userId in a push body", async () => {
    const { POST } = await import("./push/route");
    await POST(
      post(
        "/api/sync/push",
        { workspaceId: WS, baseCursor: "1", upserts: [], deletes: [], userId: "victim", user_id: "victim" },
        { cookie: sessionCookie }
      )
    );
    // The only identity that reached the service is the session's.
    expect(service.pushCalls[0].userId).toBe(USER_A);
  });

  it("ignores a forged userId in an initial sync body", async () => {
    const { POST } = await import("./initial/route");
    await POST(
      post(
        "/api/sync/initial",
        { workspace: { ...workspacePayload(), userId: "victim" }, upserts: [], userId: "victim" },
        { cookie: sessionCookie }
      )
    );
    expect(service.initialCalls[0].userId).toBe(USER_A);
  });

  it("ignores a userId query parameter on pull", async () => {
    const { GET } = await import("./pull/route");
    await GET(get(`/api/sync/pull?workspaceId=${WS}&cursor=0&userId=victim`, { cookie: sessionCookie }));
    expect(service.pullCalls[0].userId).toBe(USER_A);
  });
});

describe("ownership does not disclose existence", () => {
  it("answers 404 for a workspace that is not the caller's", async () => {
    service.pushResult = { ok: false, reason: "not-found" };
    const { POST } = await import("./push/route");
    const response = await POST(
      post("/api/sync/push", { workspaceId: WS, baseCursor: "1", upserts: [], deletes: [] }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    // Same wording whether it is someone else's or does not exist — a
    // guessed id must not become an existence oracle.
    expect(body.error).toBe("Workspace not found.");
  });

  it("answers 404 on pull for a workspace the caller does not own", async () => {
    service.pullResult = null;
    const { GET } = await import("./pull/route");
    const response = await GET(get(`/api/sync/pull?workspaceId=${WS}&cursor=0`, { cookie: sessionCookie }));
    expect(response.status).toBe(404);
  });
});

describe("CSRF and origin", () => {
  it("rejects a cross-origin push", async () => {
    const { POST } = await import("./push/route");
    const response = await POST(
      post(
        "/api/sync/push",
        { workspaceId: WS, baseCursor: "1" },
        { cookie: sessionCookie, origin: "https://evil.example" }
      )
    );
    expect(response.status).toBe(403);
    expect(service.pushCalls).toHaveLength(0);
  });

  it("rejects a push that is not application/json", async () => {
    // A cross-site form/img/script can only produce a simple content type;
    // requiring JSON forces a preflight nothing here answers permissively.
    const { POST } = await import("./push/route");
    const response = await POST(
      post(
        "/api/sync/push",
        { workspaceId: WS, baseCursor: "1" },
        { cookie: sessionCookie, contentType: "text/plain" }
      )
    );
    expect(response.status).toBe(403);
  });

  it("rejects a cross-origin initial sync", async () => {
    const { POST } = await import("./initial/route");
    const response = await POST(
      post("/api/sync/initial", { workspace: workspacePayload() }, { cookie: sessionCookie, origin: "https://evil.example" })
    );
    expect(response.status).toBe(403);
  });

  it("exposes no mutating verb on pull", async () => {
    const route = await import("./pull/route");
    expect(route).not.toHaveProperty("POST");
    expect(route).not.toHaveProperty("PUT");
    expect(route).not.toHaveProperty("DELETE");
  });
});

describe("payload validation", () => {
  it("rejects an invalid workspace UUID", async () => {
    const { POST } = await import("./push/route");
    const response = await POST(
      post("/api/sync/push", { workspaceId: "not-a-uuid", baseCursor: "1" }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(400);
    expect(service.pushCalls).toHaveLength(0);
  });

  it("rejects an unsafe tab URL", async () => {
    const { POST } = await import("./push/route");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const response = await POST(
        post(
          "/api/sync/push",
          {
            workspaceId: WS,
            baseCursor: "1",
            upserts: [{ entityType: "tab", entity: { id: TAB, url } }],
          },
          { cookie: sessionCookie }
        )
      );
      expect(response.status, url).toBe(400);
    }
    expect(service.pushCalls).toHaveLength(0);
  });

  it("rejects a legacy non-UUID entity id with a precise reason", async () => {
    const { POST } = await import("./initial/route");
    const response = await POST(
      post("/api/sync/initial", { workspace: { ...workspacePayload(), id: "ws-1699123456789-1" } }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: string[] };
    expect(body.errors.join(" ")).toContain("legacy");
  });

  it("rejects a malformed cursor", async () => {
    const { POST } = await import("./push/route");
    const response = await POST(
      post("/api/sync/push", { workspaceId: WS, baseCursor: "not-a-cursor" }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    const { POST } = await import("./push/route");
    const request = new Request("http://localhost:3000/api/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000", cookie: sessionCookie },
      body: "{ not json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body with 413 before parsing it", async () => {
    const { POST } = await import("./push/route");
    const request = new Request("http://localhost:3000/api/sync/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        host: "localhost:3000",
        cookie: sessionCookie,
        "content-length": String(64 * 1024 * 1024),
      },
      body: JSON.stringify({ workspaceId: WS, baseCursor: "1" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(service.pushCalls).toHaveLength(0);
  });

  it("rejects too many changes in one push", async () => {
    const { POST } = await import("./push/route");
    const upserts = Array.from({ length: 2001 }, (_, i) => ({
      entityType: "tab",
      entity: { id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, url: "https://example.com/x" },
    }));
    const response = await POST(
      post("/api/sync/push", { workspaceId: WS, baseCursor: "1", upserts }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(400);
    expect(service.pushCalls).toHaveLength(0);
  });

  it("rejects a self-dependency", async () => {
    const { POST } = await import("./push/route");
    const response = await POST(
      post(
        "/api/sync/push",
        {
          workspaceId: WS,
          baseCursor: "1",
          upserts: [
            { entityType: "dependency", entity: { parentTabId: TAB, childTabId: TAB, createdAt: T0 } },
          ],
        },
        { cookie: sessionCookie }
      )
    );
    expect(response.status).toBe(400);
  });
});

describe("conflict responses", () => {
  it("reports a stale base as 409 with the server cursor", async () => {
    service.pushResult = { ok: false, reason: "stale-base", serverCursor: "18" };
    const { POST } = await import("./push/route");
    const response = await POST(
      post("/api/sync/push", { workspaceId: WS, baseCursor: "17", upserts: [], deletes: [] }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; serverCursor: string };
    expect(body.reason).toBe("stale-base");
    expect(body.serverCursor).toBe("18");
  });

  it("reports per-entity conflicts with enough detail to explain them", async () => {
    service.pushResult = {
      ok: false,
      reason: "conflict",
      serverCursor: "17",
      conflicts: [{ entityType: "tab", entityId: TAB, baseCursor: "17", serverCursor: "19", reason: "locked-section" }],
    };
    const { POST } = await import("./push/route");
    const response = await POST(
      post("/api/sync/push", { workspaceId: WS, baseCursor: "17", upserts: [], deletes: [] }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { conflicts: { entityId: string; reason: string }[] };
    expect(body.conflicts[0].entityId).toBe(TAB);
    expect(body.conflicts[0].reason).toBe("locked-section");
  });

  it("reports an existing workspace on initial sync as 409 rather than overwriting", async () => {
    service.initialResult = { ok: false, reason: "conflict", serverCursor: "12" };
    const { POST } = await import("./initial/route");
    const response = await POST(
      post("/api/sync/initial", { workspace: workspacePayload(), upserts: [] }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(409);
  });
});

describe("idempotent retry", () => {
  it("passes the client's knownCursor through so a retry updates in place", async () => {
    const { POST } = await import("./initial/route");
    await POST(
      post("/api/sync/initial", { workspace: workspacePayload(), upserts: [], knownCursor: "5" }, { cookie: sessionCookie })
    );
    expect(service.initialCalls[0].knownCursor).toBe("5");
  });

  it("treats a first attempt as knownCursor null", async () => {
    const { POST } = await import("./initial/route");
    await POST(post("/api/sync/initial", { workspace: workspacePayload(), upserts: [] }, { cookie: sessionCookie }));
    expect(service.initialCalls[0].knownCursor).toBeNull();
  });
});

describe("server failure", () => {
  it("answers 500 without leaking the internal error", async () => {
    const failing = {
      async push() {
        throw new Error("connection terminated unexpectedly at 10.0.0.5:5432");
      },
    };
    __setSyncServiceForTests(failing as unknown as SyncService);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("./push/route");
    const response = await POST(
      post("/api/sync/push", { workspaceId: WS, baseCursor: "1", upserts: [], deletes: [] }, { cookie: sessionCookie })
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain("10.0.0.5");
    expect(body.error).not.toContain("connection terminated");
  });
});
