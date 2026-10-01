#!/usr/bin/env node
/**
 * Prints Hubble Desktop download counts (src/lib/downloads/schema.sql).
 *
 *   npm run downloads:report
 *
 * Read-only: one SELECT, no writes. The counts are aggregate (day, platform,
 * version → number), so there is nothing personal to print. They are not
 * served by any route; this script, run by someone who holds the database
 * credential, is how they are read.
 *
 * Reads the connection string from POSTGRES_URL or DATABASE_URL (or
 * .env.local / .env). The variable NAME is printed; its value never is.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTION_ENV_VARS = ["POSTGRES_URL", "DATABASE_URL"];

/** The same minimal .env reader as the migrate:* scripts. Never overrides a real environment variable. */
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

/** Totals from rows, as the report prints them. Exported for the test. */
export function summarise(rows) {
  const total = rows.reduce((sum, row) => sum + row.downloads, 0);
  const by = (key) => {
    const out = {};
    for (const row of rows) out[row[key]] = (out[row[key]] ?? 0) + row.downloads;
    return out;
  };
  return { total, byPlatform: by("platform"), byVersion: by("version"), byDay: by("day") };
}

async function main() {
  loadEnvFile(path.join(ROOT, ".env.local"));
  loadEnvFile(path.join(ROOT, ".env"));

  const connection = connectionString();
  if (!connection) {
    console.error(`No database configured. Set ${CONNECTION_ENV_VARS.join(" or ")} and run this again.`);
    process.exitCode = 1;
    return;
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: connection.value });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, platform, version, downloads
         FROM tabdump_desktop_downloads
        ORDER BY day, platform, version`
    );
    const rows = result.rows.map((row) => ({ ...row, downloads: Number(row.downloads) }));
    const summary = summarise(rows);
    console.log(`Hubble Desktop downloads (via ${connection.name})`);
    console.log(`Total: ${summary.total}`);
    console.log("By platform:", summary.byPlatform);
    console.log("By version:", summary.byVersion);
    console.log("By day (UTC):", summary.byDay);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ rows, ...summary }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Report failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
