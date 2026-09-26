#!/usr/bin/env node
/**
 * Applies the provider connection schema (src/lib/agents/credentials/schema.sql).
 *
 *   npm run migrate:credentials
 *
 * Required before a deployment with a database can hold user-owned provider
 * credentials. Without these tables the credential layer falls back to an
 * in-memory store: it still works and still encrypts, but every connection is
 * lost on restart, and the settings page says so rather than pretending
 * otherwise.
 *
 * ## The other half: an encryption key
 *
 * Rows here are useless without `TABDUMP_CREDENTIAL_KEY` — 32 bytes, base64 —
 * which never enters the database. Generate one with:
 *
 *   node scripts/migrate-credentials.mjs --key
 *
 * Without it the application refuses to store or read a credential at all.
 * That is the fail-closed direction and it is deliberate: a deployment that
 * cannot encrypt a credential has no business holding one, and falling back to
 * plaintext would be exactly the invented guarantee this codebase refuses
 * elsewhere.
 *
 * **Rotating the key is not supported by this script, and it is not free.**
 * Every sealed record is bound to the key that sealed it, so changing the key
 * makes existing credentials unreadable and every user reconnects. Losing the
 * key has the same effect. Back it up where you back up your database
 * password — and not beside the database.
 *
 * Additive and idempotent: every statement in the schema is IF NOT EXISTS,
 * so this creates what is missing and touches nothing else. It never drops
 * a table, never rewrites a column, and never deletes a row — running it
 * against a populated production database is safe, and running it twice is
 * a no-op.
 *
 * Reads the connection string from POSTGRES_URL or DATABASE_URL, the same
 * two names the app itself checks (see src/lib/auth/store/postgres.ts). The
 * credential schema shares that database and that connection pool
 * deliberately.
 * When neither is set it says so and exits non-zero rather than guessing at
 * a local database.
 *
 * `.env.local` is loaded when present so this works the same way `next dev`
 * does, without needing the variable exported in the shell first.
 */

import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "agents", "credentials", "schema.sql");
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
  // `--key` prints a fresh key and exits. It touches no database and reads no
  // configuration, so it is safe to run anywhere — including before a database
  // exists, which is when an operator usually needs it.
  if (process.argv.includes("--key")) {
    console.log(randomBytes(32).toString("base64"));
    return;
  }

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

  // Warn, do not refuse. Creating the tables is useful on its own — a
  // deployment often migrates before its secrets are configured — and an
  // operator told now will not discover this from a support ticket later.
  if (!process.env.TABDUMP_CREDENTIAL_KEY?.trim()) {
    console.warn(
      "Warning: TABDUMP_CREDENTIAL_KEY is not set. The tables will be created, but " +
        "Hubble will refuse to store or read provider credentials until it is. " +
        "Generate one with: node scripts/migrate-credentials.mjs --key"
    );
  }

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
    console.log(`Provider connection schema applied (via ${connection.name}).`);
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
