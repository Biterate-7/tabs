import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresAuthStore, postgresConnectionString } from "./postgres";

/**
 * These exercise the adapter against a recording fake rather than a real
 * Postgres — there is no database in this environment. That bounds what
 * they can prove: they pin the SQL shape, the parameterization, and the
 * row-to-object mapping (the defect class that actually bites — snake_case
 * columns and BIGINT-as-string), but they do NOT prove the schema applies
 * or that the queries run. Applying schema.sql and signing in once against
 * a real database is still a required manual step.
 */

type Recorded = { text: string; values: unknown[] };

class FakePool {
  readonly queries: Recorded[] = [];
  private responses: Record<string, unknown>[][] = [];

  /** Queues the rows the next query resolves with. */
  willReturn(rows: Record<string, unknown>[]): void {
    this.responses.push(rows);
  }

  async query(text: string, values: unknown[]) {
    this.queries.push({ text, values });
    return { rows: this.responses.shift() ?? [] };
  }

  get last(): Recorded {
    return this.queries[this.queries.length - 1];
  }

  /** Normalized to one line, so assertions don't depend on how the SQL is wrapped. */
  get lastSql(): string {
    return this.last.text.replace(/\s+/g, " ").trim();
  }
}

let pool: FakePool;
let store: PostgresAuthStore;

/** Epoch-ms columns come back from `pg` as strings, because the column is BIGINT. The fixtures say so on purpose. */
const USER_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  google_sub: "115625890123456789012",
  email: "ada@example.com",
  name: "Ada Lovelace",
  avatar_url: "https://lh3.googleusercontent.com/ada",
  created_at: "1757000000000",
  updated_at: "1757000000001",
};

const SESSION_ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  user_id: "11111111-1111-4111-8111-111111111111",
  token_hash: "a".repeat(64),
  created_at: "1757000000000",
  expires_at: "1759592000000",
  last_used_at: "1757000000500",
};

beforeEach(() => {
  pool = new FakePool();
  store = new PostgresAuthStore(pool as unknown as Pool);
});

describe("row mapping", () => {
  it("maps a user row onto the app's camelCase shape with numeric timestamps", async () => {
    pool.willReturn([USER_ROW]);

    const user = await store.findUserById(USER_ROW.id);

    expect(user).toEqual({
      id: USER_ROW.id,
      googleSub: USER_ROW.google_sub,
      email: "ada@example.com",
      name: "Ada Lovelace",
      avatarUrl: "https://lh3.googleusercontent.com/ada",
      createdAt: 1757000000000,
      updatedAt: 1757000000001,
    });
    // Not the string pg handed back — an expiry comparison against a string
    // would silently do the wrong thing.
    expect(typeof user?.createdAt).toBe("number");
  });

  it("maps a NULL avatar to null rather than undefined", async () => {
    pool.willReturn([{ ...USER_ROW, avatar_url: null }]);
    expect((await store.findUserById(USER_ROW.id))?.avatarUrl).toBeNull();
  });

  it("maps a session row, keeping expiry numeric", async () => {
    pool.willReturn([SESSION_ROW]);

    const session = await store.findSessionByTokenHash(SESSION_ROW.token_hash);

    expect(session).toEqual({
      id: SESSION_ROW.id,
      userId: SESSION_ROW.user_id,
      tokenHash: SESSION_ROW.token_hash,
      createdAt: 1757000000000,
      expiresAt: 1759592000000,
      lastUsedAt: 1757000000500,
    });
    expect(typeof session?.expiresAt).toBe("number");
  });

  it("returns null, not undefined, when nothing matches", async () => {
    expect(await store.findUserById("nobody")).toBeNull();
    expect(await store.findUserByGoogleSub("nobody")).toBeNull();
    expect(await store.findSessionByTokenHash("nothing")).toBeNull();
  });
});

describe("query shape", () => {
  it("never interpolates a value into the SQL text", async () => {
    // Every value must travel as a bound parameter. A googleSub containing
    // SQL punctuation is the canary.
    const hostile = "'; DROP TABLE tabdump_users; --";
    pool.willReturn([]);

    await store.findUserByGoogleSub(hostile);

    expect(pool.lastSql).not.toContain("DROP TABLE");
    expect(pool.last.values).toEqual([hostile]);
    expect(pool.lastSql).toContain("google_sub = $1");
  });

  it("looks a user up by google_sub, never by email", async () => {
    pool.willReturn([]);
    await store.findUserByGoogleSub("sub-1");
    expect(pool.lastSql).toContain("WHERE google_sub = $1");
    expect(pool.lastSql).not.toContain("email =");
  });

  it("resolves a session by its token hash", async () => {
    pool.willReturn([]);
    await store.findSessionByTokenHash("hash-1");
    expect(pool.lastSql).toContain("FROM tabdump_sessions WHERE token_hash = $1");
    expect(pool.last.values).toEqual(["hash-1"]);
  });

  it("upserts on the google_sub constraint rather than pre-checking", async () => {
    // This is what makes two concurrent first sign-ins converge on one row.
    pool.willReturn([USER_ROW]);

    await store.createUser({
      id: "new-id",
      googleSub: "115625890123456789012",
      email: "ada@example.com",
      name: "Ada Lovelace",
      avatarUrl: null,
    });

    expect(pool.lastSql).toContain("INSERT INTO tabdump_users");
    expect(pool.lastSql).toContain("ON CONFLICT (google_sub) DO UPDATE");
    // The conflict branch refreshes the profile but must not touch identity
    // or the original creation time.
    expect(pool.lastSql).toContain("SET email = EXCLUDED.email");
    expect(pool.lastSql).not.toContain("SET id =");
    expect(pool.lastSql).not.toContain("google_sub = EXCLUDED");
    expect(pool.lastSql).not.toContain("created_at = EXCLUDED");
  });

  it("returns the row the database actually kept, not the one we proposed", async () => {
    // On conflict that is the *existing* id — which is precisely why the
    // caller must use the returned row rather than its own input.
    pool.willReturn([USER_ROW]);

    const user = await store.createUser({
      id: "the-id-we-generated",
      googleSub: USER_ROW.google_sub,
      email: "ada@example.com",
      name: "Ada Lovelace",
      avatarUrl: null,
    });

    expect(user.id).toBe(USER_ROW.id);
    expect(user.id).not.toBe("the-id-we-generated");
  });

  it("leaves expiry alone when touchSession is given no new one", async () => {
    await store.touchSession("session-1", 1757000000999);

    expect(pool.lastSql).toContain("expires_at = COALESCE($3, expires_at)");
    expect(pool.last.values).toEqual(["session-1", 1757000000999, null]);
  });

  it("moves expiry when touchSession is given one", async () => {
    await store.touchSession("session-1", 1757000000999, 1759592000000);
    expect(pool.last.values).toEqual(["session-1", 1757000000999, 1759592000000]);
  });

  it("deletes a single session by id, and a user's sessions by user_id", async () => {
    await store.deleteSession("session-1");
    expect(pool.lastSql).toBe("DELETE FROM tabdump_sessions WHERE id = $1");

    await store.deleteSessionsForUser("user-1");
    expect(pool.lastSql).toBe("DELETE FROM tabdump_sessions WHERE user_id = $1");
    expect(pool.last.values).toEqual(["user-1"]);
  });

  it("purges only rows already past their expiry", async () => {
    await store.deleteExpiredSessions(1757000000000);
    expect(pool.lastSql).toBe("DELETE FROM tabdump_sessions WHERE expires_at <= $1");
    expect(pool.last.values).toEqual([1757000000000]);
  });

  it("updates a profile without touching identity columns", async () => {
    pool.willReturn([USER_ROW]);

    await store.updateUserProfile(USER_ROW.id, {
      email: "ada@newjob.example",
      name: "A. Lovelace",
      avatarUrl: null,
    });

    expect(pool.lastSql).toContain("UPDATE tabdump_users SET email = $2, name = $3, avatar_url = $4");
    expect(pool.lastSql).toContain("WHERE id = $1");
    expect(pool.lastSql).not.toContain("google_sub =");
  });

  it("throws rather than silently succeeding when a profile update matches no row", async () => {
    pool.willReturn([]);
    await expect(
      store.updateUserProfile("ghost", { email: "x@y.z", name: "x", avatarUrl: null })
    ).rejects.toThrow();
  });
});

describe("store identity", () => {
  it("declares itself durable, which is what lets production use it", () => {
    expect(store.durable).toBe(true);
    expect(store.kind).toBe("postgres");
  });
});

describe("postgresConnectionString", () => {
  it("prefers POSTGRES_URL, falls back to DATABASE_URL, and is undefined otherwise", async () => {
    const { vi } = await import("vitest");

    vi.stubEnv("POSTGRES_URL", "postgres://a");
    vi.stubEnv("DATABASE_URL", "postgres://b");
    expect(postgresConnectionString()).toBe("postgres://a");

    vi.stubEnv("POSTGRES_URL", "");
    expect(postgresConnectionString()).toBe("postgres://b");

    vi.stubEnv("DATABASE_URL", "   ");
    expect(postgresConnectionString()).toBeUndefined();

    vi.unstubAllEnvs();
  });
});
