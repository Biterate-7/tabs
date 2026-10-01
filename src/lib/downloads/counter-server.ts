import "server-only";
import { getPool, postgresConnectionString } from "@/lib/auth/store/postgres";
import { createPostgresDownloadCounter, type DownloadCounter } from "./counter";

let resolved: Promise<DownloadCounter | undefined> | undefined;

/**
 * The deployment's download counter, on the same Postgres pool as the rest
 * of Hubble's server state — or `undefined` with no database, in which case
 * downloads still redirect and are simply not counted.
 */
export async function getDownloadCounter(): Promise<DownloadCounter | undefined> {
  resolved ??= (async () => {
    const connectionString = postgresConnectionString();
    if (!connectionString) return undefined;
    return createPostgresDownloadCounter(await getPool(connectionString));
  })().catch((error) => {
    resolved = undefined;
    throw error;
  });
  return resolved;
}
