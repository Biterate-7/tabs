import type { Pool } from "pg";
import type { DesktopOs } from "@/lib/desktop/release";

/**
 * Hubble Desktop download counts (aggregate only — see ./schema.sql).
 *
 * A download is one number added to the row for its UTC day, platform and
 * version. Nothing about who downloaded is accepted by this interface, so
 * nothing about them can be stored through it.
 */

export type DownloadKey = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  platform: DesktopOs;
  version: string;
};

export type DownloadRow = DownloadKey & { downloads: number };

export type DownloadCounter = {
  /** Adds one download. */
  record(key: DownloadKey): Promise<void>;
  /** Every row, oldest day first. For the report script and tests. */
  rows(): Promise<DownloadRow[]>;
};

/** The UTC day a moment falls on, as the table stores it. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function createPostgresDownloadCounter(pool: Pool): DownloadCounter {
  return {
    async record({ day, platform, version }) {
      // One statement, so two concurrent downloads can never lose a count.
      await pool.query(
        `INSERT INTO tabdump_desktop_downloads (day, platform, version, downloads)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (day, platform, version)
         DO UPDATE SET downloads = tabdump_desktop_downloads.downloads + 1`,
        [day, platform, version]
      );
    },

    async rows() {
      const result = await pool.query<{ day: string; platform: DesktopOs; version: string; downloads: string | number }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, platform, version, downloads
           FROM tabdump_desktop_downloads
          ORDER BY day, platform, version`
      );
      return result.rows.map((row) => ({ ...row, downloads: Number(row.downloads) }));
    },
  };
}

/** In-memory, for tests and for a deployment with no database. */
export function createMemoryDownloadCounter(): DownloadCounter {
  const counts = new Map<string, DownloadRow>();
  return {
    async record(key) {
      const id = `${key.day}|${key.platform}|${key.version}`;
      const row = counts.get(id) ?? { ...key, downloads: 0 };
      counts.set(id, { ...row, downloads: row.downloads + 1 });
    },
    async rows() {
      return [...counts.values()].sort((a, b) =>
        `${a.day}|${a.platform}|${a.version}`.localeCompare(`${b.day}|${b.platform}|${b.version}`)
      );
    },
  };
}
