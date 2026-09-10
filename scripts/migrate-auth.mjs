#!/usr/bin/env node
/**
 * Applies the account-system schema (src/lib/auth/store/schema.sql).
 *
 *   npm run migrate:auth
 *
 * Additive and idempotent: every statement in the schema is IF NOT EXISTS,
 * so this creates what is missing and touches nothing else. It never drops
 * a table, never rewrites a column, and never deletes a row — running it
 * against a populated production database is safe, and running it twice is
 * a no-op.
 *
 * Reads the connection string from POSTGRES_URL or DATABASE_URL, the same
 * two names the app itself checks (see src/lib/auth/store/postgres.ts).
 * When neither is set it says so and exits non-zero rather than guessing at
 * a local database.
 *
 * `.env.local` is loaded when present so this works the same way `next dev`
 * does, without needing the variable exported in the shell first.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "auth", "store", "schema.sql");
const CONNECTION_ENV_VARS = ["POSTGRES_URL", "DATABASE_URL"];

/**
 * A deliberately minimal .env reader: enough for `KEY=value` and
 * `KEY="value"` lines, which is all a connection string needs. Never
 * overrides a variable already present in the real environment, so a
 * deliberate `POSTGRES_URL=… npm run migrate:auth` still wins.
 */
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
    // One transaction: either the whole schema is present afterwards or
    // none of this run's statements are, so a failure halfway through can't
    // leave a users table without its sessions table.
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
    // The variable NAME is safe to print; its value is a credential, so it
    // never is.
    console.log(`Account schema applied (via ${connection.name}).`);
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
