#!/usr/bin/env node
/**
 * Applies the workspace sync schema (src/lib/sync/schema.sql).
 *
 *   npm run migrate:sync
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
 * Reads the connection string from POSTGRES_URL or DATABASE_URL, the same
 * two names the app itself checks (see src/lib/auth/store/postgres.ts).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "sync", "schema.sql");
const CONNECTION_ENV_VARS = ["POSTGRES_URL", "DATABASE_URL"];

/** Same minimal .env reader as migrate-auth.mjs: enough for `KEY=value`, never overriding a real environment variable. */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function connectionString() {
  for (const name of CONNECTION_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

async function main() {
  loadEnvFile(path.join(ROOT, ".env.local"));
  loadEnvFile(path.join(ROOT, ".env"));

  const connection = connectionString();
  if (!connection) {
    console.error(
      `No database configured. Set one of ${CONNECTION_ENV_VARS.join(" or ")} to a Postgres ` +
        `connection string (in .env.local for local development, or in your hosting provider's ` +
        `environment settings) and run this again.`
    );
    process.exitCode = 1;
    return;
  }

  const schema = readFileSync(SCHEMA_PATH, "utf8");

  const { Client } = await import("pg");
  const client = new Client({ connectionString: connection.value });

  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT to_regclass('public.tabdump_users') IS NOT NULL AS present`
    );
    if (!rows[0]?.present) {
      console.error(
        "The account schema isn't applied yet. Workspaces reference tabdump_users, so run " +
          "`npm run migrate:auth` first, then this again."
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
    // The variable NAME is safe to print; its value is a credential.
    console.log(`Workspace sync schema applied (via ${connection.name}).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
