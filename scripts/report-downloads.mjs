#!/usr/bin/env node
/**
 * Prints Hubble Desktop download counts (src/lib/downloads/schema.sql).
 *
 *   node --env-file=<file holding POSTGRES_URL> scripts/report-downloads.mjs --expect-host=<endpoint>
 *
 * Read-only: one SELECT, no writes. The counts are aggregate (day, platform,
 * version → number), so there is nothing personal to print. They are not
 * served by any route; this script, run by someone who holds the database
 * credential, is how they are read.
 *
 * The target is never implied: see ./db-target.mjs. .env.local and .env are
 * not read, and --expect-host must name the host the connection string in
 * the real environment points at.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactConnectionStrings, resolveDatabaseTarget } from "./db-target.mjs";

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
  const resolved = await resolveDatabaseTarget("scripts/report-downloads.mjs");
  if (!resolved) return;
  const { client, target, variable } = resolved;

  await client.connect();
  try {
    const result = await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, platform, version, downloads
         FROM tabdump_desktop_downloads
        ORDER BY day, platform, version`
    );
    const rows = result.rows.map((row) => ({ ...row, downloads: Number(row.downloads) }));
    const summary = summarise(rows);
    console.log(`Hubble Desktop downloads from ${target.host}/${target.database} (via ${variable})`);
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
    console.error("Report failed:", redactConnectionStrings(error));
    process.exitCode = 1;
  });
}
