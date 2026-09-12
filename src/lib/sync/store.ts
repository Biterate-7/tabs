import "server-only";
import { getPool, postgresConnectionString, POSTGRES_ENV_VAR_NAMES } from "@/lib/auth/store/postgres";
import { SyncService } from "./service";

/**
 * Resolves the sync service for this process, or explains why it cannot.
 *
 * Mirrors src/lib/auth/store/index.ts's shape on purpose, including its
 * central judgement: when there is no database, say so plainly rather than
 * falling back to something that appears to work. The auth store refuses an
 * unrevocable stateless session for that reason; the equivalent mistake here
 * would be pretending a workspace was stored when it was not, which the user
 * would discover only when their other device showed nothing.
 *
 * There is deliberately NO in-memory fallback. An in-memory sync store would
 * accept an upload, report success, and lose it on the next deploy — and the
 * client would by then have recorded a cursor saying the server had the
 * data. "Sync isn't configured" is a far kinder failure, and the app keeps
 * working locally either way.
 */

export type SyncServiceResult =
  | { ok: true; service: SyncService }
  | { ok: false; reason: "not-configured"; detail: string };

let cached: SyncService | undefined;
let warned = false;

/** Test seam, matching __setAuthStoreForTests. Never called by application code. */
export function __setSyncServiceForTests(service: SyncService | undefined): void {
  cached = service;
}

export async function getSyncService(): Promise<SyncServiceResult> {
  if (cached) return { ok: true, service: cached };

  const connectionString = postgresConnectionString();
  if (!connectionString) {
    const detail =
      `Workspace sync needs a database. Set one of ${POSTGRES_ENV_VAR_NAMES.join(" / ")} to a Postgres ` +
      `connection string and apply src/lib/sync/schema.sql (npm run migrate:sync).`;

    // Once per process, like getAuthStore: every sync attempt would
    // otherwise put a line in the deployment's logs and bury everything
    // else. Callers get the detail in the result and must never return it
    // to a browser.
    if (!warned) {
      warned = true;
      console.error(`[sync] ${detail}`);
    }
    return { ok: false, reason: "not-configured", detail };
  }

  cached = new SyncService(await getPool(connectionString));
  return { ok: true, service: cached };
}
