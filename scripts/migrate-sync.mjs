#!/usr/bin/env node
/**
 * Applies the workspace sync schema (src/lib/sync/schema.sql).
 *
 *   node --env-file=<file holding POSTGRES_URL> scripts/migrate-sync.mjs --expect-host=<endpoint>
 *
 * Deliberately a sibling of scripts/migrate-auth.mjs rather than a rewrite
 * of it: the two schemas are applied independently, and the auth one must
 * keep working exactly as it does whatever happens here.
 *
 * Ordering matters in one direction only. The sync schema's workspaces table
 * REFERENCES tabdump_users, so the auth schema has to exist first; this
 * checks for that table and says so plainly rather than letting Postgres
 * report a confusing missing-relation error. It never creates or alters an
 * auth table itself.
 *
 * Additive and idempotent: every statement in the schema is IF NOT EXISTS,
 * so this creates what is missing and touches nothing else. It never drops a
 * table, never rewrites a column, and never deletes a row — including
 * tombstones, which this phase deliberately never purges.
 *
 * The target is never implied: see ./db-target.mjs. .env.local and .env are
 * not read, and --expect-host must name the host the connection string in
 * the real environment points at.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactConnectionStrings, resolveDatabaseTarget } from "./db-target.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "sync", "schema.sql");

async function main() {
  const resolved = await resolveDatabaseTarget("scripts/migrate-sync.mjs");
  if (!resolved) return;
  const { client, target, variable } = resolved;

  const schema = readFileSync(SCHEMA_PATH, "utf8");

  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT to_regclass('public.tabdump_users') IS NOT NULL AS present`
    );
    if (!rows[0]?.present) {
      console.error(
        "The account schema isn't applied yet. Workspaces reference tabdump_users, so run " +
          "scripts/migrate-auth.mjs first, then this again."
      );
      process.exitCode = 1;
      return;
    }

    // One transaction: either every table, constraint and index in this run
    // is present afterwards or none of them is, so a failure halfway can't
    // leave a tabs table whose foreign keys were never created.
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
    console.log(`Workspace sync schema applied to ${target.host}/${target.database} (via ${variable}).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", redactConnectionStrings(error));
  process.exitCode = 1;
});
