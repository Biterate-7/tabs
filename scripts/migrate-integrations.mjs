#!/usr/bin/env node
/**
 * Applies the AI integrations schema (src/lib/integrations/schema.sql).
 *
 *   node --env-file=<file holding POSTGRES_URL> scripts/migrate-integrations.mjs --expect-host=<endpoint>
 *
 * Required before a deployment can connect ChatGPT, Claude, Gemini or Grok
 * to Hubble: OAuth clients, connections, credentials, proposals, saved
 * project context, notes and the audit log live in these tables. Without
 * them, /api/mcp still serves older read-only tokens and the OAuth and
 * integration routes answer 503. Depends on tabdump_users, so run
 * migrate:auth first on a new database.
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
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "integrations", "schema.sql");

async function main() {
  const resolved = await resolveDatabaseTarget("scripts/migrate-integrations.mjs");
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
    console.log(`AI integrations schema applied to ${target.host}/${target.database} (via ${variable}).`);
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
