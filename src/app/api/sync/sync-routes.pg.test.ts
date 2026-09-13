// @vitest-environment node
/**
 * The sync API end to end: real route handlers, real Postgres-backed
 * sessions, real SyncService, real database.
 *
 * ./sync-routes.test.ts covers the same surface with a MemoryAuthStore and a
 * recording fake service, which is the right tool for the API-shaped rules
 * (CSRF shape, status codes, what the routes forward). It cannot show what
 * happens when the DATABASE refuses something — whether a constraint
 * violation becomes a sanitized 500 or leaks a table name, whether an
 * expired session row is really rejected, whether a body-supplied user id
 * can reach real rows. Those are what this file is for.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { describePostgres, freshDatabase } from "../../../../test/pg/database";

const T0 = 1_700_000_000_000;
const ORIGIN = "http://localhost:3000";
/** checkAuthRateLimit deliberately skips a caller it cannot identify, so the limiter is only exercised when a client IP is present. */
const CLIENT_IP = "203.0.113.7";

function uuid() {
  return crypto.randomUUID();
}

/** Everything a route needs in a request: same-origin, JSON, and a session cookie. */
function post(path: string, body: unknown, cookie: string | null): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-forwarded-for": CLIENT_IP,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie: string | null): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "GET",
    headers: { origin: ORIGIN, "x-forwarded-for": CLIENT_IP, ...(cookie ? { cookie } : {}) },
  });
}

describePostgres("the sync API against real PostgreSQL", () => {
  let pool: Pool;
  let cookie: string;
  let userId: string;
  let store: import("@/lib/auth/types").AuthStore;

  beforeEach(async () => {
    const db = await freshDatabase();
    pool = db.pool;

    const { PostgresAuthStore } = await import("@/lib/auth/store/postgres");
    const { __setAuthStoreForTests } = await import("@/lib/auth/store");
    const { __setSyncServiceForTests } = await import("@/lib/sync/store");
    const { SyncService } = await import("@/lib/sync/service");
    const { createSession } = await import("@/lib/auth/session");
    const { SESSION_COOKIE } = await import("@/lib/auth/config");
    const { __clearRateLimitsForTests } = await import("@/lib/ai/server/rate-limit");
    __clearRateLimitsForTests();

    // The REAL Postgres-backed session store, not the memory one.
    //
    // Constructed directly on this test's pool rather than through
    // createPostgresAuthStore, which memoizes ONE pool per process. That
    // memoization is right in production, where a process has a single
    // connection string, but here it would pin every test after the first to
    // the FIRST test's database while its sync service used its own.
    store = new PostgresAuthStore(pool);
    __setAuthStoreForTests(store);
    __setSyncServiceForTests(new SyncService(pool));

    const user = await store.createUser({
      id: uuid(),
      googleSub: `sub-${uuid()}`,
      email: "a@example.test",
      name: "A",
      avatarUrl: null,
    });
    userId = user.id;
    const { token } = await createSession(store, user.id);
    cookie = `${SESSION_COOKIE}=${token}`;
  });

  afterEach(async () => {
    const { __setAuthStoreForTests } = await import("@/lib/auth/store");
    const { __setSyncServiceForTests } = await import("@/lib/sync/store");
    __setAuthStoreForTests(undefined);
    __setSyncServiceForTests(undefined);
    vi.restoreAllMocks();
  });

  const workspaceBody = (id: string) => ({
    workspace: { id, name: "Work", createdAt: T0, updatedAt: T0 },
    upserts: [],
  });

  async function createWorkspace(id = uuid()) {
    const { POST } = await import("./initial/route");
    const response = await POST(post("/api/sync/initial", workspaceBody(id), cookie));
    expect(response.status).toBe(201);
    return { id, cursor: (await response.json()).cursor as string };
  }

  // -------------------------------------------------------------------------
  // §14 Session security, against real session rows
  // -------------------------------------------------------------------------

  it("rejects a request with no session before touching the database", async () => {
    const { POST } = await import("./initial/route");
    const response = await POST(post("/api/sync/initial", workspaceBody(uuid()), null));
    expect(response.status).toBe(401);

    const { rows } = await pool.query(`SELECT id FROM tabdump_workspaces`);
    expect(rows).toEqual([]);
  });

  it("rejects an expired session and removes the row", async () => {
    const ws = uuid();
    // Expire the session in the database, exactly as time passing would.
    await pool.query(`UPDATE tabdump_sessions SET expires_at = $1`, [Date.now() - 1000]);

    const { POST } = await import("./initial/route");
    const response = await POST(post("/api/sync/initial", workspaceBody(ws), cookie));
    expect(response.status).toBe(401);

    const sessions = await pool.query(`SELECT id FROM tabdump_sessions`);
    expect(sessions.rows).toEqual([]);
    const workspaces = await pool.query(`SELECT id FROM tabdump_workspaces`);
    expect(workspaces.rows).toEqual([]);
  });

  it("rejects a revoked session", async () => {
    await pool.query(`DELETE FROM tabdump_sessions`);

    const { POST } = await import("./initial/route");
    const response = await POST(post("/api/sync/initial", workspaceBody(uuid()), cookie));
    expect(response.status).toBe(401);
  });

  it("rejects a forged token that was never issued", async () => {
    const { SESSION_COOKIE } = await import("@/lib/auth/config");
    const { POST } = await import("./initial/route");
    const response = await POST(
      post("/api/sync/initial", workspaceBody(uuid()), `${SESSION_COOKIE}=not-a-real-token`)
    );
    expect(response.status).toBe(401);
  });

  it("stores only the hash of a session token, never the token itself", async () => {
    const { rows } = await pool.query<{ token_hash: string }>(`SELECT token_hash FROM tabdump_sessions`);
    expect(rows).toHaveLength(1);
    const raw = cookie.split("=")[1];
    expect(rows[0].token_hash).not.toBe(raw);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // §13 A client-supplied user id is never honoured
  // -------------------------------------------------------------------------

  it("ignores a userId smuggled in the body and writes as the session's user", async () => {
    const other = await store.createUser({
      id: uuid(),
      googleSub: `sub-${uuid()}`,
      email: "b@example.test",
      name: "B",
      avatarUrl: null,
    });

    const ws = uuid();
    const { POST } = await import("./initial/route");
    const response = await POST(
      post(
        "/api/sync/initial",
        { ...workspaceBody(ws), userId: other.id, user_id: other.id, ownerId: other.id },
        cookie
      )
    );
    expect(response.status).toBe(201);

    const { rows } = await pool.query(`SELECT user_id FROM tabdump_workspaces WHERE id = $1`, [ws]);
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].user_id).not.toBe(other.id);
  });

  // -------------------------------------------------------------------------
  // §15 SQL injection attempts are stored as data
  // -------------------------------------------------------------------------

  it("stores SQL metacharacters verbatim instead of executing them", async () => {
    const ws = await createWorkspace();
    const nasty = "'; DROP TABLE tabdump_tabs; --";

    const { POST } = await import("./push/route");
    const tabId = uuid();
    const response = await POST(
      post(
        "/api/sync/push",
        {
          workspaceId: ws.id,
          baseCursor: ws.cursor,
          deletedAt: T0,
          upserts: [
            {
              entityType: "tab",
              entity: {
                id: tabId,
                url: `https://example.com/${encodeURIComponent(nasty)}`,
                title: nasty,
                notes: `${nasty} /* ${nasty} */`,
                createdAt: T0,
                updatedAt: T0,
              },
            },
          ],
          deletes: [],
        },
        cookie
      )
    );
    expect(response.status).toBe(200);

    // The table still exists and the string round-tripped as a value.
    const { rows } = await pool.query<{ title: string; notes: string }>(
      `SELECT title, notes FROM tabdump_tabs WHERE id = $1`,
      [tabId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(nasty);
    expect(rows[0].notes).toContain(nasty);
  });

  it("treats an injection attempt in the cursor and limit as invalid input, not SQL", async () => {
    const ws = await createWorkspace();
    const { GET } = await import("./pull/route");

    for (const cursor of ["0; DROP TABLE tabdump_tabs", "1 OR 1=1", "'--"]) {
      const response = await GET(
        get(`/api/sync/pull?workspaceId=${ws.id}&cursor=${encodeURIComponent(cursor)}`, cookie)
      );
      expect([400, 200]).toContain(response.status);
    }

    const { rows } = await pool.query(`SELECT to_regclass('public.tabdump_tabs') IS NOT NULL AS present`);
    expect(rows[0].present).toBe(true);
  });

  // -------------------------------------------------------------------------
  // §21 Database failures become clean API semantics
  // -------------------------------------------------------------------------

  it("answers a second upload of the same workspace with already-exists, not an error", async () => {
    const ws = await createWorkspace();
    const { POST } = await import("./initial/route");

    const again = await POST(post("/api/sync/initial", workspaceBody(ws.id), cookie));
    expect(again.status).toBe(409);
    const body = await again.json();
    expect(body.reason).toBe("already-exists");
    expect(body.serverCursor).toBe(ws.cursor);
  });

  it("answers a stale base with a distinguishable conflict", async () => {
    const ws = await createWorkspace();
    const { POST } = await import("./push/route");

    const body = {
      // The cursor the client legitimately holds after its first upload.
      workspaceId: ws.id,
      baseCursor: ws.cursor,
      deletedAt: T0,
      upserts: [
        { entityType: "tab", entity: { id: uuid(), url: "https://example.com/a", createdAt: T0, updatedAt: T0 } },
      ],
      deletes: [],
    };
    // First push moves the cursor; the second reuses the now-stale base.
    expect((await POST(post("/api/sync/push", body, cookie))).status).toBe(200);
    const stale = await POST(post("/api/sync/push", body, cookie));
    expect(stale.status).toBe(409);
    expect((await stale.json()).reason).toBe("stale-base");
  });

  it("answers another account's workspace with an indistinguishable 404", async () => {
    const ws = await createWorkspace();

    const { createSession } = await import("@/lib/auth/session");
    const { SESSION_COOKIE } = await import("@/lib/auth/config");
    const other = await store.createUser({
      id: uuid(),
      googleSub: `sub-${uuid()}`,
      email: "b@example.test",
      name: "B",
      avatarUrl: null,
    });
    const { token } = await createSession(store, other.id);
    const otherCookie = `${SESSION_COOKIE}=${token}`;

    const { GET } = await import("./pull/route");
    const real = await GET(get(`/api/sync/pull?workspaceId=${ws.id}&cursor=0`, otherCookie));
    const imaginary = await GET(get(`/api/sync/pull?workspaceId=${uuid()}&cursor=0`, otherCookie));

    expect(real.status).toBe(404);
    expect(imaginary.status).toBe(404);
    // Byte-identical: a guessed id must not become an existence oracle.
    expect(await real.text()).toBe(await imaginary.text());
  });

  it("sanitizes a genuine database failure into a 500 that leaks nothing", async () => {
    const ws = await createWorkspace();
    // A section id that does not exist violates a composite foreign key deep
    // inside the transaction — a real Postgres error on the write path.
    const { POST } = await import("./push/route");
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));

    const response = await POST(
      post(
        "/api/sync/push",
        {
          workspaceId: ws.id,
          baseCursor: ws.cursor,
          deletedAt: T0,
          upserts: [
            {
              entityType: "tab",
              entity: {
                id: uuid(),
                url: "https://example.com/a",
                sectionId: uuid(),
                createdAt: T0,
                updatedAt: T0,
              },
            },
          ],
          deletes: [],
        },
        cookie
      )
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    // No SQL, no table names, no constraint names, no connection details.
    for (const leak of [
      "tabdump_",
      "constraint",
      "violates",
      "INSERT",
      "SELECT",
      "postgres",
      "127.0.0.1",
      "password",
      "at SyncRepository",
    ]) {
      expect(text.toLowerCase(), `leaked ${leak}`).not.toContain(leak.toLowerCase());
    }
    // The failure was still logged server-side rather than swallowed.
    expect(errors.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // §23 Rate limiting still applies, and never mutates sync state
  // -------------------------------------------------------------------------

  it("returns 429 with retry-after and writes nothing while limited", async () => {
    const ws = await createWorkspace();
    const { POST } = await import("./push/route");
    const { checkAuthRateLimit } = await import("@/lib/auth/rate-limit");

    // Exhaust the shared limiter the same way a flood of requests would.
    let limited = false;
    for (let i = 0; i < 200 && !limited; i += 1) {
      limited = !checkAuthRateLimit(
        new Request(`${ORIGIN}/api/sync/push`, {
          headers: { origin: ORIGIN, "x-forwarded-for": CLIENT_IP },
        }),
        "sync"
      ).allowed;
    }
    expect(limited).toBe(true);

    const before = await pool.query(`SELECT sync_counter FROM tabdump_workspaces WHERE id = $1`, [ws.id]);
    const response = await POST(
      post(
        "/api/sync/push",
        {
          workspaceId: ws.id,
          baseCursor: ws.cursor,
          deletedAt: T0,
          upserts: [
            { entityType: "tab", entity: { id: uuid(), url: "https://example.com/a", createdAt: T0, updatedAt: T0 } },
          ],
          deletes: [],
        },
        cookie
      )
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();

    // The refused request must not have advanced the workspace or written a row.
    const after = await pool.query(`SELECT sync_counter FROM tabdump_workspaces WHERE id = $1`, [ws.id]);
    expect(after.rows[0].sync_counter).toBe(before.rows[0].sync_counter);
    const tabs = await pool.query(`SELECT id FROM tabdump_tabs WHERE workspace_id = $1`, [ws.id]);
    expect(tabs.rows).toEqual([]);
  });
});
