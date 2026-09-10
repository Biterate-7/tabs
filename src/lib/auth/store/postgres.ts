import "server-only";
import type { Pool, QueryResultRow } from "pg";
import type { AuthSession, AuthStore, AuthUser } from "../types";

/**
 * The durable AuthStore. Talks to any Postgres — Vercel Postgres/Neon,
 * Supabase's database, RDS, a local `postgres:16` container — through the
 * standard `pg` driver, against the schema in ./schema.sql.
 *
 * `pg` is imported dynamically (see getPool) so a deployment that never
 * configures a database doesn't pull the driver into its server bundle.
 */

/** How the connection string is spelled, in the order it is looked for. `POSTGRES_URL` is what Vercel Postgres injects; `DATABASE_URL` is the near-universal alternative. */
const CONNECTION_ENV_VARS = ["POSTGRES_URL", "DATABASE_URL"] as const;

export function postgresConnectionString(): string | undefined {
  for (const name of CONNECTION_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The names checked above, for the "how do I configure this?" half of a diagnostic message. Never the values. */
export const POSTGRES_ENV_VAR_NAMES: readonly string[] = CONNECTION_ENV_VARS;

/**
 * Epoch-millisecond columns come back from `pg` as strings, because BIGINT
 * exceeds what a JS number can hold *in general*. Epoch ms does not (it
 * stays exact for another quarter of a million years), so a plain Number()
 * is lossless for every value this schema can hold.
 */
function toMillis(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

type UserRow = {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: string | number;
  updated_at: string | number;
};

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string | number;
  expires_at: string | number;
  last_used_at: string | number;
};

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    googleSub: row.google_sub,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function toSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: toMillis(row.created_at),
    expiresAt: toMillis(row.expires_at),
    lastUsedAt: toMillis(row.last_used_at),
  };
}

const USER_COLUMNS = "id, google_sub, email, name, avatar_url, created_at, updated_at";
const SESSION_COLUMNS = "id, user_id, token_hash, created_at, expires_at, last_used_at";

export class PostgresAuthStore implements AuthStore {
  readonly kind = "postgres";
  readonly durable = true;

  constructor(private readonly pool: Pool) {}

  private async query<R extends QueryResultRow>(text: string, values: unknown[]): Promise<R[]> {
    const result = await this.pool.query<R>(text, values);
    return result.rows;
  }

  async findUserByGoogleSub(googleSub: string): Promise<AuthUser | null> {
    const rows = await this.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM tabdump_users WHERE google_sub = $1`,
      [googleSub]
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const rows = await this.query<UserRow>(`SELECT ${USER_COLUMNS} FROM tabdump_users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async createUser(input: Omit<AuthUser, "createdAt" | "updatedAt">): Promise<AuthUser> {
    const now = Date.now();
    // ON CONFLICT, not a pre-check: this is what makes two simultaneous
    // first-time logins for the same Google account converge on one row.
    // The conflict branch returns the row that already exists (keeping its
    // original id and created_at) with the freshly asserted profile
    // applied, so the caller cannot tell which request inserted.
    const rows = await this.query<UserRow>(
      `INSERT INTO tabdump_users (id, google_sub, email, name, avatar_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (google_sub) DO UPDATE
         SET email = EXCLUDED.email,
             name = EXCLUDED.name,
             avatar_url = EXCLUDED.avatar_url,
             updated_at = EXCLUDED.updated_at
       RETURNING ${USER_COLUMNS}`,
      [input.id, input.googleSub, input.email, input.name, input.avatarUrl, now]
    );
    return toUser(rows[0]);
  }

  async updateUserProfile(
    id: string,
    profile: Pick<AuthUser, "email" | "name" | "avatarUrl">
  ): Promise<AuthUser> {
    const rows = await this.query<UserRow>(
      `UPDATE tabdump_users
          SET email = $2, name = $3, avatar_url = $4, updated_at = $5
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [id, profile.email, profile.name, profile.avatarUrl, Date.now()]
    );
    if (!rows[0]) throw new Error("auth: user not found");
    return toUser(rows[0]);
  }

  async createSession(session: AuthSession): Promise<void> {
    await this.query(
      `INSERT INTO tabdump_sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt, session.lastUsedAt]
    );
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    const rows = await this.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM tabdump_sessions WHERE token_hash = $1`,
      [tokenHash]
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async touchSession(id: string, lastUsedAt: number, expiresAt?: number): Promise<void> {
    // COALESCE keeps this one statement for both shapes: pass no new expiry
    // and the existing expires_at is written back unchanged.
    await this.query(
      `UPDATE tabdump_sessions SET last_used_at = $2, expires_at = COALESCE($3, expires_at) WHERE id = $1`,
      [id, lastUsedAt, expiresAt ?? null]
    );
  }

  async deleteSession(id: string): Promise<void> {
    await this.query(`DELETE FROM tabdump_sessions WHERE id = $1`, [id]);
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    await this.query(`DELETE FROM tabdump_sessions WHERE user_id = $1`, [userId]);
  }

  async deleteExpiredSessions(now: number): Promise<void> {
    await this.query(`DELETE FROM tabdump_sessions WHERE expires_at <= $1`, [now]);
  }
}

/**
 * The in-flight or settled pool, cached as a *promise* rather than as the
 * resolved Pool.
 *
 * Caching the resolved value would leak connections on a cold start: two
 * concurrent requests both find the cache empty, both await the dynamic
 * `import("pg")` (a real suspension point), and both construct a Pool. One
 * of them is then overwritten and orphaned — still holding open backends
 * that nothing will ever call `end()` on. Caching the promise means the
 * second caller awaits the first caller's construction instead of starting
 * its own.
 */
let poolPromise: Promise<Pool> | undefined;

/**
 * One pool per server process, reused across warm invocations.
 *
 * `max` is deliberately small: on a serverless platform the number of
 * concurrent instances is the thing that multiplies, so a generous
 * per-instance pool is how a Postgres connection limit gets exhausted.
 * Three is enough for the two or three queries a sign-in makes while
 * leaving room for many instances. Point the connection string at a pooled
 * endpoint (Vercel Postgres/Neon provide one) if you expect real traffic.
 *
 * TLS is left entirely to the connection string (`?sslmode=require`) rather
 * than overridden here — hard-coding `rejectUnauthorized: false` in code is
 * how a deployment silently loses certificate verification.
 */
function getPool(connectionString: string): Promise<Pool> {
  poolPromise ??= (async () => {
    const { Pool: PgPool } = await import("pg");
    const created = new PgPool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // A pool-level error (a backend closing an idle connection, a network
    // blip) is emitted on the pool itself; without a listener Node treats
    // it as an unhandled 'error' event and takes the process down.
    created.on("error", (error: Error) => {
      console.error("[auth] postgres pool error:", error.message);
    });
    return created;
  })().catch((error) => {
    // A failed construction is not cached: the next request gets a fresh
    // attempt rather than inheriting one bad startup forever.
    poolPromise = undefined;
    throw error;
  });

  return poolPromise;
}

export async function createPostgresAuthStore(connectionString: string): Promise<PostgresAuthStore> {
  return new PostgresAuthStore(await getPool(connectionString));
}
