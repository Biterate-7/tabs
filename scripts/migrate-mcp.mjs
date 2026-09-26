#!/usr/bin/env node
/**
 * Applies the MCP access-token schema (src/lib/mcp/schema.sql).
 *
 *   npm run migrate:mcp
 *
 * Required before a deployment can issue Claude Desktop (MCP) connections.
 * Without the table, /api/mcp/tokens cannot mint a token and /api/mcp refuses
 * every request. Depends on tabdump_users, so run migrate:auth first on a new
 * database.
 *
 * Additive and idempotent: every statement is IF NOT EXISTS, so this creates
 * what is missing and touches nothing else, and running it twice is a no-op.
 *
 * Reads the connection string from POSTGRES_URL or DATABASE_URL. The variable
 * NAME is printed; its value never is.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "mcp", "schema.sql");
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
    // leave half a schema behind.
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
    // The variable NAME is safe to print; its value is a credential, so it
    // never is.
    console.log(`MCP token schema applied (via ${connection.name}).`);
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
