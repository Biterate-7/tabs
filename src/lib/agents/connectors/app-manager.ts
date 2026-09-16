import { defaultConnectorCatalog } from "./catalog";
import { createConnectorManager } from "./manager";
import { clearAllSessionCredentials } from "./session-credentials";
import type { ConnectorManager } from "./manager";

/**
 * The application's single connector manager.
 *
 * Module-level rather than React state, for the same reason
 * src/lib/storage/namespace.ts holds the active account that way: two
 * independent surfaces need it — the settings page and the workspace — and
 * they mount and unmount on completely different schedules. A manager owned
 * by one of them would be destroyed when that surface closed, taking the
 * other's connection with it; a manager per surface would mean two poll loops
 * reading the user's machine and two sets of runs that disagree.
 *
 * Created lazily, on first use, so importing this module costs nothing and
 * server rendering never builds one.
 */

let instance: ConnectorManager | null = null;

export function getConnectorManager(): ConnectorManager {
  if (!instance) {
    instance = createConnectorManager({
      registrations: defaultConnectorCatalog(),
      // The browser is the only place a user's intent is worth remembering,
      // and the only place there is storage to remember it in.
      persist: typeof window !== "undefined",
    });
  }
  return instance;
}

/**
 * Tears the manager down and forgets it.
 *
 * Called when the account changes — signing in or out re-scopes every storage
 * key, so the connectors the previous namespace had enabled must not keep
 * running against the new one. Session credentials go with it: they belong to
 * whoever entered them, and carrying one across a sign-out would be the
 * single worst thing this layer could do.
 */
export function resetConnectorManager(): void {
  instance?.dispose();
  instance = null;
  clearAllSessionCredentials();
}
