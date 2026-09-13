/**
 * The per-test half of the PostgreSQL harness.
 *
 * `describePostgres` is the entry point every integration suite uses: it
 * behaves like `describe`, but skips the whole block with a printed reason
 * when no real cluster booted. That keeps "this was verified against real
 * Postgres" and "this could not be verified here" visibly different in the
 * test output instead of quietly identical.
 */

import { afterEach, describe, inject } from "vitest";
import type { Pool } from "pg";
import { createDatabaseFromTemplate, createEmptyDatabase } from "./cluster";

function connection(): { adminUrl: string; urlFor: (db: string) => string } | null {
  const adminUrl = inject("pgAdminUrl");
  const template = inject("pgUrlTemplate");
  if (!adminUrl || !template) return null;
  return { adminUrl, urlFor: (db: string) => template.replace("{db}", db) };
}

export function postgresUnavailableReason(): string | null {
  if (connection()) return null;
  return inject("pgUnavailableReason") ?? "no cluster";
}

/**
 * `describe` for suites that require a real database.
 *
 * Skips rather than fails when Postgres could not be started, so the rest of
 * the suite still runs on a machine that cannot host one.
 */
export const describePostgres: (name: string, fn: () => void) => void = (name, fn) => {
  const reason = postgresUnavailableReason();
  if (reason) {
    describe.skip(`${name} [SKIPPED: real PostgreSQL unavailable — ${reason}]`, fn);
    return;
  }
  describe(name, fn);
};

type TestDatabase = {
  readonly url: string;
  readonly pool: Pool;
  /** A second, independent pool — for tests that need two racing clients. */
  openPool(): Promise<Pool>;
};

const openPools: Pool[] = [];

afterEach(async () => {
  // Every pool any test opened is closed here, so a leaked client shows up
  // as a hanging test rather than as a mystery in a later one.
  const pools = openPools.splice(0, openPools.length);
  await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
});

async function poolFor(url: string): Promise<Pool> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 8 });
  openPools.push(pool);
  return pool;
}

/** A fresh database with both schemas already applied. */
export async function freshDatabase(): Promise<TestDatabase> {
  const conn = connection();
  if (!conn) throw new Error("no PostgreSQL cluster; guard the suite with describePostgres");
  const { url } = await createDatabaseFromTemplate(conn.adminUrl, conn.urlFor);
  return {
    url,
    pool: await poolFor(url),
    openPool: () => poolFor(url),
  };
}

/**
 * Inserts an account row and returns its id.
 *
 * Workspaces reference `tabdump_users`, so ownership and account-isolation
 * tests need real users rather than invented uuids — a foreign key would
 * reject those, and a test that works around the FK is not testing ownership.
 */
export async function seedUser(pool: Pool, label: string): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  await pool.query(
    `INSERT INTO tabdump_users (id, google_sub, email, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [id, `sub-${label}-${id}`, `${label}@example.test`, label, Date.now()]
  );
  return id;
}

/** A fresh database with NO tables — the starting point for migration tests. */
export async function emptyDatabase(): Promise<TestDatabase> {
  const conn = connection();
  if (!conn) throw new Error("no PostgreSQL cluster; guard the suite with describePostgres");
  const { url } = await createEmptyDatabase(conn.adminUrl, conn.urlFor);
  return {
    url,
    pool: await poolFor(url),
    openPool: () => poolFor(url),
  };
}
