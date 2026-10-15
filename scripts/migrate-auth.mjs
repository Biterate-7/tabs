#!/usr/bin/env node
/**
 * Applies the account-system schema (src/lib/auth/store/schema.sql).
 *
 *   node --env-file=<file holding POSTGRES_URL> scripts/migrate-auth.mjs --expect-host=<endpoint>
 *
 * Additive and idempotent: every statement in the schema is IF NOT EXISTS,
 * so this creates what is missing and touches nothing else. It never drops
 * a table, never rewrites a column, and never deletes a row — running it
 * against a populated production database is safe, and running it twice is
 * a no-op.
 *
 * The target is never implied: see ./db-target.mjs. .env.local and .env are
 * not read (they have held the production database), and --expect-host must
 * name the host the connection string in the real environment points at.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactConnectionStrings, resolveDatabaseTarget } from "./db-target.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "auth", "store", "schema.sql");

async function main() {
  const resolved = await resolveDatabaseTarget("scripts/migrate-auth.mjs");
  if (!resolved) return;
  const { client, target, variable } = resolved;

  const schema = readFileSync(SCHEMA_PATH, "utf8");

  await client.connect();
  try {
    // One transaction: either the whole schema is present afterwards or
    // none of this run's statements are, so a failure halfway through can't
    // leave a users table without its sessions table.
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
    console.log(`Account schema applied to ${target.host}/${target.database} (via ${variable}).`);
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
