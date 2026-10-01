// @vitest-environment node
/**
 * The download counter against real PostgreSQL, from an empty database — the
 * state `npm run migrate:downloads` meets in production.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresDownloadCounter } from "./counter";
import { describePostgres, emptyDatabase } from "../../../test/pg/database";

const SCHEMA = readFileSync(path.join(__dirname, "schema.sql"), "utf8");

describePostgres("Desktop download counts against real PostgreSQL", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = (await emptyDatabase()).pool;
    await pool.query(SCHEMA);
  });

  it("applies twice without error (idempotent migration)", async () => {
    await pool.query(SCHEMA);
  });

  it("counts every concurrent download exactly once", async () => {
    const counter = createPostgresDownloadCounter(pool);
    await Promise.all(Array.from({ length: 25 }, () => counter.record({ day: "2026-10-01", platform: "windows", version: "0.1.0" })));
    await counter.record({ day: "2026-10-02", platform: "windows", version: "0.1.0" });
    expect(await counter.rows()).toEqual([
      { day: "2026-10-01", platform: "windows", version: "0.1.0", downloads: 25 },
      { day: "2026-10-02", platform: "windows", version: "0.1.0", downloads: 1 },
    ]);
  });

  it("has columns for day, platform, version and a count — nothing that could identify a person", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'tabdump_desktop_downloads' ORDER BY ordinal_position`
    );
    expect(rows.map((row) => row.column_name)).toEqual(["day", "platform", "version", "downloads"]);
  });

  it("refuses an unknown platform or a malformed version at the database too", async () => {
    const counter = createPostgresDownloadCounter(pool);
    await expect(
      counter.record({ day: "2026-10-01", platform: "banana" as never, version: "0.1.0" })
    ).rejects.toThrow(/check constraint/);
    await expect(counter.record({ day: "2026-10-01", platform: "windows", version: "latest" })).rejects.toThrow(/check constraint/);
  });
});
