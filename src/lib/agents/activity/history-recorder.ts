import type { AgentHistoryRecord, AgentHistorySession } from "./history";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { AgentHistoryRecordInput, AgentHistoryStore } from "./history-store";

/**
 * What the runtime host writes agent history through.
 *
 *     runtime ─▶ canonical event ─┬─▶ journal ─▶ live Activity Timeline
 *                                 └─▶ recorder ─▶ agent history store
 *
 * ## Never in the live path's way
 *
 * Recording is observational. Writes are queued and flushed after the
 * current tick in one batch per owner, so a burst of events costs one
 * transaction, and the event the journal just accepted reaches its listeners
 * without waiting on a database. A store that fails — down, unmigrated,
 * full — is logged once a minute and otherwise ignored: the agent keeps
 * working, the live timeline keeps updating, and history simply has a gap.
 *
 * ## Cheap when nothing changed
 *
 * The host offers the session's state on every event and every command that
 * names it. A session identical to the one last written is not written
 * again, and a record already written by this process is not offered to the
 * store again (`seen` is shared across hosts, because a remote host is built
 * per request and re-reads its sandbox log from the start each time). The
 * store is idempotent regardless; these only save it the round trip.
 */

export type AgentHistoryRecorder = {
  /** The session as the runtime now holds it. */
  session(ownerId: string, session: AgentHistorySession): void;
  /** Records of a session already offered through `session`. */
  records(ownerId: string, sessionId: string, records: readonly AgentHistoryRecord[]): void;
  /** A handoff that ended (Hubble 1.4). Its source session must already have been offered. */
  handoff(ownerId: string, handoff: SessionHandoff): void;
  /** Resolves once everything offered so far has been written (or has failed). Never rejects. */
  flush(): Promise<void>;
};

/** Bounded memory of what was already written, by key. Insertion-ordered so the oldest go first. */
export type AgentHistorySeen = { has(key: string): boolean; add(key: string): void };

export function createHistorySeen(max = 20_000): AgentHistorySeen {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    add(key) {
      keys.delete(key);
      keys.add(key);
      while (keys.size > max) {
        const oldest = keys.values().next().value;
        if (oldest === undefined) break;
        keys.delete(oldest);
      }
    },
  };
}

const WARN_INTERVAL_MS = 60_000;

export function createAgentHistoryRecorder(options: {
  store: AgentHistoryStore;
  seen?: AgentHistorySeen;
  /** Where a failed write is reported. Defaults to one console warning a minute. */
  onError?: (error: unknown) => void;
}): AgentHistoryRecorder {
  const { store } = options;
  const seen = options.seen ?? createHistorySeen();
  let lastWarning = -Infinity;
  const onError =
    options.onError ??
    ((error: unknown) => {
      const at = Date.now();
      if (at - lastWarning < WARN_INTERVAL_MS) return;
      lastWarning = at;
      // The code, never the error's detail: a database error can quote the row.
      const code = (error as { code?: unknown } | null)?.code;
      console.warn(`Hubble could not record agent history${typeof code === "string" ? ` (${code})` : ""}. Live activity is unaffected.`);
    });

  type Pending = {
    sessions: Map<string, { session: AgentHistorySession; key: string }>;
    records: AgentHistoryRecordInput[];
    keys: string[];
    handoffs: Map<string, SessionHandoff>;
  };
  const pending = new Map<string, Pending>();
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;

  const pendingFor = (ownerId: string): Pending => {
    let entry = pending.get(ownerId);
    if (!entry) {
      entry = { sessions: new Map(), records: [], keys: [], handoffs: new Map() };
      pending.set(ownerId, entry);
    }
    return entry;
  };

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void drain();
    }, 0);
  }

  function drain(): Promise<void> {
    const batches = [...pending.entries()];
    pending.clear();
    if (batches.length === 0) return chain;
    chain = chain.then(async () => {
      for (const [ownerId, batch] of batches) {
        try {
          await store.write(ownerId, {
            sessions: [...batch.sessions.values()].map((entry) => entry.session),
            records: batch.records,
            ...(batch.handoffs.size > 0 ? { handoffs: [...batch.handoffs.values()] } : {}),
          });
          // Remembered only once written, so a failed write is offered again.
          for (const entry of batch.sessions.values()) seen.add(entry.key);
          for (const key of batch.keys) seen.add(key);
          for (const id of batch.handoffs.keys()) seen.add(id);
        } catch (error) {
          onError(error);
        }
      }
    });
    return chain;
  }

  return {
    session(ownerId, session) {
      const key = `s\u0000${ownerId}\u0000${session.sessionId}\u0000${JSON.stringify(session)}`;
      if (seen.has(key)) return;
      pendingFor(ownerId).sessions.set(session.sessionId, { session, key });
      schedule();
    },

    records(ownerId, sessionId, records) {
      let added = false;
      for (const record of records) {
        // A plan's outcome can move on; everything else is written once.
        const identity = `r\u0000${ownerId}\u0000${sessionId}\u0000${record.kind}\u0000${record.key}${record.kind === "plan_outcome" ? `\u0000${JSON.stringify(record.data)}` : ""}`;
        if (seen.has(identity)) continue;
        const entry = pendingFor(ownerId);
        if (entry.keys.includes(identity)) continue;
        entry.records.push({ ...record, sessionId });
        entry.keys.push(identity);
        added = true;
      }
      if (added) schedule();
    },

    handoff(ownerId, handoff) {
      // Written once: a handoff does not change after it ends.
      const identity = `h\u0000${ownerId}\u0000${handoff.handoffId}`;
      if (seen.has(identity)) return;
      pendingFor(ownerId).handoffs.set(identity, structuredClone(handoff));
      schedule();
    },

    flush() {
      return drain().catch(() => undefined);
    },
  };
}
