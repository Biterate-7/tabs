import "server-only";
import { isProduction } from "../config";
import type { AuthStore } from "../types";
import { MemoryAuthStore } from "./memory";
import { POSTGRES_ENV_VAR_NAMES, createPostgresAuthStore, postgresConnectionString } from "./postgres";

/**
 * Picks the AuthStore this process should use, and — just as importantly —
 * refuses to pick one that would quietly break.
 *
 * There is exactly ONE session model in TabDump (opaque random token in an
 * HttpOnly cookie, SHA-256 of it stored server-side, revocable by deleting
 * the row). What varies is only where those rows live. A "stateless signed
 * cookie" fallback would make production work with no database at all, but
 * at the cost of a session nobody can revoke — logout would clear a cookie
 * and leave a still-valid token in the wild. That is a worse outcome than
 * saying plainly that accounts aren't configured yet, so it isn't offered.
 */

export type AuthStoreResult =
  | { ok: true; store: AuthStore }
  | { ok: false; reason: "not-configured"; detail: string };

let cached: AuthStore | undefined;
let warnedAboutMemoryStore = false;
let warnedAboutMissingStore = false;

/** Test seam: lets a test drive the whole auth stack against a MemoryAuthStore it controls. Never called by application code. */
export function __setAuthStoreForTests(store: AuthStore | undefined): void {
  cached = store;
}

export async function getAuthStore(): Promise<AuthStoreResult> {
  if (cached) return { ok: true, store: cached };

  const connectionString = postgresConnectionString();
  if (connectionString) {
    cached = await createPostgresAuthStore(connectionString);
    return { ok: true, store: cached };
  }

  if (isProduction()) {
    // Serverless invocations don't share memory, so a MemoryAuthStore here
    // would issue a session on one instance that simply doesn't exist for
    // the next request — an intermittent, near-undebuggable "randomly
    // signed out". Failing loudly and early is the kinder failure.
    const detail =
      `Accounts need a database. Set one of ${POSTGRES_ENV_VAR_NAMES.join(" / ")} to a Postgres ` +
      `connection string and apply src/lib/auth/store/schema.sql (npm run migrate:auth).`;

    // Logged here, once per process, rather than at each call site: every
    // page load asks for the store, so a per-request log would put one
    // error line per visitor per navigation into the deployment's logs and
    // bury everything else. Callers get the detail in the result and must
    // not re-log it — and must never return it to a browser.
    if (!warnedAboutMissingStore) {
      warnedAboutMissingStore = true;
      console.error(`[auth] ${detail}`);
    }

    return { ok: false, reason: "not-configured", detail };
  }

  if (!warnedAboutMemoryStore) {
    warnedAboutMemoryStore = true;
    console.warn(
      "[auth] No POSTGRES_URL/DATABASE_URL set — using the in-memory account store. " +
        "Sessions and accounts last only as long as this dev server process."
    );
  }
  cached = new MemoryAuthStore();
  return { ok: true, store: cached };
}

export { MemoryAuthStore } from "./memory";
export { POSTGRES_ENV_VAR_NAMES, postgresConnectionString } from "./postgres";
