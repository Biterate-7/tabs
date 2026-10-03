import "server-only";
import { postgresConnectionString } from "@/lib/auth/store/postgres";
import { createHistorySeen } from "./history-recorder";
import { createPostgresAgentHistoryStore } from "./history-store-postgres";
import type { AgentHistorySeen } from "./history-recorder";
import type { AgentHistoryStore } from "./history-store";

/**
 * This process's agent history, for the runtime host.
 *
 * ## Postgres or nothing
 *
 * There is deliberately no in-memory fallback: history kept in this
 * process's memory would vanish with the runtime — precisely the restart it
 * exists to survive — while looking, until then, exactly like history that
 * is kept. A Hubble with no database configured gets no history at all
 * (`undefined` here), and says "Agent history unavailable"; its live
 * sessions work exactly as before. So does the desktop app, whose runtime
 * sidecar has no database (lib/agents/runtime/desktop.ts).
 *
 * ## Resolved per use, not once
 *
 * With a database configured, the store is looked up on each use and cached
 * only once it exists — so a database that was down at startup, or had not
 * yet had `npm run migrate:agent-history`, starts keeping history as soon as
 * it is ready, without the local runtime (which is built once per process)
 * being restarted. Until then every use fails, which the host reports as
 * `history_unavailable` and the recorder as one warning a minute.
 */

let resolved: Promise<AgentHistoryStore | undefined> | undefined;

function resolveStore(): Promise<AgentHistoryStore | undefined> {
  resolved ??= createPostgresAgentHistoryStore().then(
    (store) => {
      if (!store) resolved = undefined;
      return store;
    },
    () => {
      resolved = undefined;
      return undefined;
    }
  );
  return resolved;
}

class HistoryUnavailableError extends Error {
  readonly code = "history_unavailable";
  constructor() {
    super("Agent history is not available.");
  }
}

async function ready(): Promise<AgentHistoryStore> {
  const store = await resolveStore();
  if (!store) throw new HistoryUnavailableError();
  return store;
}

/** The store, looked up on every call. See the note above. */
const lazyStore: AgentHistoryStore = {
  write: async (...args) => (await ready()).write(...args),
  listSessions: async (...args) => (await ready()).listSessions(...args),
  readSession: async (...args) => (await ready()).readSession(...args),
  hasAppliedChange: async (...args) => (await ready()).hasAppliedChange(...args),
};

/** What this process has already written, shared by every host it builds (a remote host is built per request). */
const seen: AgentHistorySeen = createHistorySeen();

/** The runtime host's `history` option, or `undefined` when no database is configured. */
export function agentHistoryOption(): { store: AgentHistoryStore; seen: AgentHistorySeen } | undefined {
  return postgresConnectionString() ? { store: lazyStore, seen } : undefined;
}

/** Forgets the cached store. For tests. */
export function resetAgentHistoryStore(): void {
  resolved = undefined;
}
