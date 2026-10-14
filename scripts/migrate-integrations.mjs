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
 * The target is never implied. Unlike the older migrate:* scripts, this one
 * does not read .env.local or .env: a `vercel env pull` writes the
 * Development database there, so the file a developer happens to have would
 * silently become the target. The connection string must be in the real
 * environment (POSTGRES_URL, else DATABASE_URL) — supply it on purpose, e.g.
 * with `node --env-file=<file>` — and --expect-host must name the database
 * host it points at: the endpoint label (`ep-…`, with or without `-pooler`)
 * or the full host name. A mismatch stops before connecting.
 *
 * Prints the variable NAME, the host and the database name. Never the
 * connection string, the user or the password.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "integrations", "schema.sql");
const CONNECTION_ENV_VARS = ["POSTGRES_URL", "DATABASE_URL"];

function connectionString() {
  for (const name of CONNECTION_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

/** `--expect-host=x` or `--expect-host x`. */
function expectedHost(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--expect-host=")) return argv[i].slice("--expect-host=".length).trim();
    if (argv[i] === "--expect-host") return (argv[i + 1] ?? "").trim();
  }
  return "";
}

/**
 * The parts of the target that are safe to print and to match on, taken from
 * the client pg will actually connect with: a `?host=` parameter or PGHOST can
 * make the driver dial a host other than the one the URL shows, so the URL
 * alone proves nothing. Null when the two disagree.
 */
function describeTarget(value, client) {
  const urlHost = new URL(value).hostname.toLowerCase();
  const host = String(client.host ?? "").toLowerCase();
  if (!host || host !== urlHost) return null;
  const endpoint = host.split(".")[0].replace(/-pooler$/, "");
  return { host, endpoint, database: client.database || "(default)" };
}

function matchesTarget(target, expected) {
  const want = expected.toLowerCase().replace(/-pooler$/, "");
  return want === target.host || want === target.endpoint;
}

async function main() {
  const connection = connectionString();
  if (!connection) {
    console.error(
      `No database configured. Set ${CONNECTION_ENV_VARS.join(" or ")} in the environment of this command ` +
        `(for example \`node --env-file=<file> scripts/migrate-integrations.mjs --expect-host=<host>\`). ` +
        `.env.local and .env are not read: name the target explicitly.`
    );
    process.exitCode = 1;
    return;
  }

  const { Client } = await import("pg");
  let client;
  let target;
  try {
    client = new Client({ connectionString: connection.value });
    target = describeTarget(connection.value, client);
  } catch {
    console.error(`${connection.name} is not a valid connection URL.`);
    process.exitCode = 1;
    return;
  }
  if (!target) {
    console.error(
      `Refusing to run: the driver would not connect to the host in ${connection.name} ` +
        `(a host= parameter or PGHOST overrides it). Nothing was changed.`
    );
    process.exitCode = 1;
    return;
  }

  const expected = expectedHost(process.argv.slice(2));
  console.log(`Target (via ${connection.name}): host ${target.host}, database ${target.database}.`);
  if (!expected) {
    console.error(`Refusing to run without --expect-host. Pass the host above (or its ${target.endpoint} label) once you have confirmed it is the database you mean.`);
    process.exitCode = 1;
    return;
  }
  if (!matchesTarget(target, expected)) {
    console.error(`Refusing to run: --expect-host is ${expected}, but ${connection.name} points at ${target.host}. Nothing was changed.`);
    process.exitCode = 1;
    return;
  }

  const schema = readFileSync(SCHEMA_PATH, "utf8");

  await client.connect();
  try {
    // One transaction: either the whole schema is present afterwards or
    // none of this run's statements are, so a failure halfway through can't
    // leave half a schema behind.
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
    console.log(`AI integrations schema applied to ${target.host}/${target.database} (via ${connection.name}).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // A driver message can quote the connection string; never print one.
  const message = error instanceof Error ? error.message : String(error);
  console.error("Migration failed:", message.replace(/postgres(ql)?:\/\/\S+/gi, "<connection string>"));
  process.exitCode = 1;
});
