// @vitest-environment node
/**
 * The real migration, against a real empty PostgreSQL database.
 *
 * This runs `scripts/migrate-auth.mjs` and `scripts/migrate-sync.mjs` as
 * child processes — the same entry points `npm run migrate:auth` and
 * `npm run migrate:sync` invoke in production — rather than applying
 * schema.sql directly. Re-implementing the migration inside the test would
 * verify the test's copy of it, not the thing that actually ships.
 *
 * ./schema.test.ts already checks the schema TEXT structurally. This checks
 * what Postgres actually built from it.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { describePostgres, emptyDatabase } from "../../../test/pg/database";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

async function migrate(script: "migrate-auth.mjs" | "migrate-sync.mjs", url: string) {
  return run(process.execPath, [path.join(REPO_ROOT, "scripts", script)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      POSTGRES_URL: url,
      // The scripts also read .env.local/.env; this test must depend on
      // neither, and must never pick up a developer's real database.
      DATABASE_URL: "",
    },
  });
}

const EXPECTED_TABLES = [
  "tabdump_users",
  "tabdump_sessions",
  "tabdump_workspaces",
  "tabdump_sections",
  "tabdump_groups",
  "tabdump_tabs",
  "tabdump_collections",
  "tabdump_collection_tabs",
  "tabdump_dependencies",
];

const EXPECTED_INDEXES = [
  "tabdump_sessions_user_id_idx",
  "tabdump_sessions_expires_at_idx",
  "tabdump_workspaces_owner_idx",
  "tabdump_sections_changes_idx",
  "tabdump_groups_changes_idx",
  "tabdump_tabs_changes_idx",
  "tabdump_collections_changes_idx",
  "tabdump_collection_tabs_collection_idx",
  "tabdump_dependencies_changes_idx",
  "tabdump_dependencies_child_idx",
];

async function tableNames(pool: import("pg").Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

async function indexNames(pool: import("pg").Pool): Promise<string[]> {
  const { rows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`
  );
  return rows.map((r) => r.indexname);
}

/** Every constraint Postgres actually built, as `table.constraint`. */
async function constraintNames(pool: import("pg").Pool): Promise<string[]> {
  const { rows } = await pool.query<{ rel: string; con: string }>(
    `SELECT rel.relname AS rel, con.conname AS con
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'public' AND rel.relname LIKE 'tabdump_%'
      ORDER BY rel.relname, con.conname`
  );
  return rows.map((r) => `${r.rel}.${r.con}`);
}

describePostgres("the real migration against real PostgreSQL", () => {
  it("turns an empty database into the full schema", async () => {
    const db = await emptyDatabase();
    expect(await tableNames(db.pool)).toEqual([]);

    await migrate("migrate-auth.mjs", db.url);
    await migrate("migrate-sync.mjs", db.url);

    const tables = await tableNames(db.pool);
    for (const table of EXPECTED_TABLES) expect(tables).toContain(table);

    const indexes = await indexNames(db.pool);
    for (const index of EXPECTED_INDEXES) expect(indexes).toContain(index);
  });

  it("refuses to run before the account schema exists, instead of failing confusingly", async () => {
    const db = await emptyDatabase();

    // The sync schema's workspaces table REFERENCES tabdump_users, so this
    // ordering guard is load-bearing rather than cosmetic.
    await expect(migrate("migrate-sync.mjs", db.url)).rejects.toThrow();

    // ...and it must not have left a partial schema behind.
    expect(await tableNames(db.pool)).toEqual([]);
  });

  it("is idempotent: a second run changes nothing and destroys nothing", async () => {
    const db = await emptyDatabase();
    await migrate("migrate-auth.mjs", db.url);
    await migrate("migrate-sync.mjs", db.url);

    const before = {
      tables: await tableNames(db.pool),
      indexes: await indexNames(db.pool),
      constraints: await constraintNames(db.pool),
    };

    // Data must survive a re-run — that is what "never destructive" means.
    const userId = "11111111-1111-4111-8111-111111111111";
    await db.pool.query(
      `INSERT INTO tabdump_users (id, google_sub, email, name, created_at, updated_at)
       VALUES ($1, 'sub-1', 'a@example.com', 'A', 1, 1)`,
      [userId]
    );

    await migrate("migrate-auth.mjs", db.url);
    await migrate("migrate-sync.mjs", db.url);

    expect(await tableNames(db.pool)).toEqual(before.tables);
    expect(await indexNames(db.pool)).toEqual(before.indexes);
    // No duplicated constraints: re-running must not add a second copy of
    // any foreign key or CHECK under a generated name.
    expect(await constraintNames(db.pool)).toEqual(before.constraints);

    const { rows } = await db.pool.query(`SELECT id FROM tabdump_users`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(userId);
  });

  it("builds the composite foreign keys the same-workspace invariant depends on", async () => {
    const db = await emptyDatabase();
    await migrate("migrate-auth.mjs", db.url);
    await migrate("migrate-sync.mjs", db.url);

    const constraints = await constraintNames(db.pool);
    for (const expected of [
      "tabdump_sections.tabdump_sections_parent_same_workspace",
      "tabdump_tabs.tabdump_tabs_section_same_workspace",
      "tabdump_tabs.tabdump_tabs_group_same_workspace",
      "tabdump_collection_tabs.tabdump_collection_tabs_collection_same_workspace",
      "tabdump_collection_tabs.tabdump_collection_tabs_tab_same_workspace",
      "tabdump_dependencies.tabdump_dependencies_parent_same_workspace",
      "tabdump_dependencies.tabdump_dependencies_child_same_workspace",
    ]) {
      expect(constraints).toContain(expected);
    }
  });

  it("marks the optional relationships DEFERRABLE INITIALLY DEFERRED", async () => {
    const db = await emptyDatabase();
    await migrate("migrate-auth.mjs", db.url);
    await migrate("migrate-sync.mjs", db.url);

    // schema.sql explains why: a CASCADE or a reparenting transaction must be
    // allowed to pass through a transiently unsatisfied reference, and
    // ON DELETE SET NULL is unavailable on a multi-column key whose
    // workspace_id is NOT NULL.
    const { rows } = await db.pool.query<{ conname: string; condeferrable: boolean; condeferred: boolean }>(
      `SELECT conname, condeferrable, condeferred FROM pg_constraint
        WHERE conname IN (
          'tabdump_sections_parent_same_workspace',
          'tabdump_tabs_section_same_workspace',
          'tabdump_tabs_group_same_workspace'
        ) ORDER BY conname`
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.condeferrable, row.conname).toBe(true);
      expect(row.condeferred, row.conname).toBe(true);
    }
  });

  it("keeps the dependency identity as the (parent, child) pair with no surrogate id", async () => {
    const db = await emptyDatabase();
    await migrate("migrate-auth.mjs", db.url);
    await migrate("migrate-sync.mjs", db.url);

    const { rows: pk } = await db.pool.query<{ cols: string[] }>(
      // ::text[] because `pg` returns an unparsed literal for name[].
      `SELECT array_agg(att.attname::text ORDER BY att.attname::text) AS cols
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
        WHERE rel.relname = 'tabdump_dependencies' AND con.contype = 'p'`
    );
    expect(pk[0].cols).toEqual(["child_tab_id", "parent_tab_id"]);

    const { rows: columns } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tabdump_dependencies' AND column_name = 'id'`
    );
    expect(columns).toEqual([]);
  });
});
