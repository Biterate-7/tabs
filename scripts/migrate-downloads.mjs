#!/usr/bin/env node
/**
 * Applies the Hubble Desktop download-count schema (src/lib/downloads/schema.sql).
 *
 *   node --env-file=<file holding POSTGRES_URL> scripts/migrate-downloads.mjs --expect-host=<endpoint>
 *
 * Required before /api/download can count downloads. Without the table the
 * endpoint still redirects every download, and logs that it could not count
 * it. References no other table, so it can be applied in any order.
 *
 * Additive and idempotent: every statement is IF NOT EXISTS, so this creates
 * what is missing and touches nothing else, and running it twice is a no-op.
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
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "downloads", "schema.sql");

async function main() {
  const resolved = await resolveDatabaseTarget("scripts/migrate-downloads.mjs");
  if (!resolved) return;
  const { client, target, variable } = resolved;

  const schema = readFileSync(SCHEMA_PATH, "utf8");

  await client.connect();
  try {
    // One transaction: either the whole schema is present afterwards or
    // none of this run's statements are, so a failure halfway through can't
    // leave half a schema behind.
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
    console.log(`Desktop download schema applied to ${target.host}/${target.database} (via ${variable}).`);
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
