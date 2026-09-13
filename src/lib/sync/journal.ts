/**
 * Durable per-workspace sync bookkeeping: what is dirty, what conflicted,
 * and how far this device has read the server.
 *
 * Its own localStorage blob, separate from workspace data — the same
 * separation Phase 4 established for cursors, for the same three reasons:
 * it is device-local, it is account-scoped, and it must never travel into a
 * workspace export.
 *
 * All of the functions are pure. Loading and saving are explicit, so a
 * caller decides when to persist and nothing here writes as a side effect.
 *
 *
 * ## Why a dirty SET rather than a mutation log
 *
 * A push carries the current state of an entity, not a delta (see
 * ./diff.ts). So the durable record only needs entity identity plus whether
 * it was deleted. That makes the journal naturally coalescing — twenty edits
 * to one tab are one entry — and naturally idempotent, since replaying it
 * sends whatever the workspace currently holds however many times it runs.
 *
 * The alternative, an event log, would need ordering, compaction and replay
 * semantics to achieve exactly the same push.
 */

import { refKey } from "./diff";
import type { DirtyRef } from "./diff";
import type { LocalSyncConflict } from "./conflicts";
import type { SyncCursor } from "./types";
import { SYNC_CURSOR_START } from "./types";

const STORAGE_KEY = "tabdump:sync-journal:v1";

/**
 * Where one workspace stands.
 *
 *  - `never-synced`  the server has not been told about this workspace. NOT
 *                    "the server deleted it" — absence is never deletion, so
 *                    this state never triggers an upload on its own. Leaving
 *                    it requires the explicit initial migration.
 *  - `idle`          synced and nothing pending.
 *  - `queued`        dirty, waiting for the debounce or a free slot.
 *  - `syncing`       a request is in flight.
 *  - `offline`       the last attempt could not reach the server.
 *  - `error`         the last attempt failed for a reason worth retrying.
 *  - `paused`        authentication expired. Retrying would be pointless and
 *                    noisy; pending work is kept untouched until sign-in.
 *  - `conflict`      at least one unresolved conflict. Local state is intact.
 */
export type SyncStatus =
  | "never-synced"
  | "idle"
  | "queued"
  | "syncing"
  | "offline"
  | "error"
  | "paused"
  | "conflict";

export type WorkspaceJournal = {
  workspaceId: string;
  status: SyncStatus;
  /** How far this device has read the server's stream for this workspace. */
  cursor: SyncCursor;
  /** Entities changed locally and not yet accepted by the server. */
  dirty: DirtyRef[];
  /** Unresolved conflicts, keyed by their deterministic id. */
  conflicts: LocalSyncConflict[];
  /** Consecutive retryable failures, for backoff. Reset on success. */
  failureCount: number;
  /** Epoch ms before which no retry should be attempted. */
  retryAfter?: number;
  lastSyncedAt?: number;
  /** Short, user-facing reason. Never a stack trace or a server internal. */
  lastError?: string;
};

export type SyncJournalStore = {
  version: 1;
  /** Which account this belongs to. A different user invalidates the whole blob. */
  userId: string | null;
  workspaces: Record<string, WorkspaceJournal>;
};

export function defaultJournal(workspaceId: string): WorkspaceJournal {
  return {
    workspaceId,
    status: "never-synced",
    cursor: SYNC_CURSOR_START,
    dirty: [],
    conflicts: [],
    failureCount: 0,
  };
}

export function defaultJournalStore(): SyncJournalStore {
  return { version: 1, userId: null, workspaces: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUSES: readonly SyncStatus[] = [
  "never-synced",
  "idle",
  "queued",
  "syncing",
  "offline",
  "error",
  "paused",
  "conflict",
];

/**
 * Reads one entry defensively.
 *
 * This blob is untrusted persisted input like any other. A malformed entry
 * is dropped rather than allowed to prevent startup: the cost is a re-pull,
 * and workspace data lives elsewhere and is unaffected.
 *
 * `syncing` is deliberately NOT restored. A request cannot still be in
 * flight across a reload, and restoring it would leave a workspace stuck in
 * a state nothing clears. It reads back as `queued`, which is exactly what
 * it is: work that still needs doing.
 */
function readJournal(value: unknown): WorkspaceJournal | null {
  if (!isRecord(value)) return null;
  const workspaceId = value.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;

  const rawStatus = typeof value.status === "string" && STATUSES.includes(value.status as SyncStatus)
    ? (value.status as SyncStatus)
    : "idle";

  const dirty: DirtyRef[] = Array.isArray(value.dirty)
    ? value.dirty.filter((entry): entry is DirtyRef => {
        if (!isRecord(entry) || !isRecord(entry.ref)) return false;
        const ref = entry.ref;
        if (ref.entityType === "dependency") {
          return typeof ref.parentTabId === "string" && typeof ref.childTabId === "string";
        }
        return typeof ref.entityType === "string" && typeof ref.entityId === "string";
      })
    : [];

  const conflicts: LocalSyncConflict[] = Array.isArray(value.conflicts)
    ? value.conflicts.filter(
        (entry): entry is LocalSyncConflict =>
          isRecord(entry) && typeof entry.id === "string" && typeof entry.entityId === "string"
      )
    : [];

  return {
    workspaceId,
    status: rawStatus === "syncing" ? "queued" : rawStatus,
    cursor: typeof value.cursor === "string" ? value.cursor : SYNC_CURSOR_START,
    dirty,
    conflicts,
    failureCount: typeof value.failureCount === "number" && Number.isFinite(value.failureCount) ? value.failureCount : 0,
    ...(typeof value.retryAfter === "number" && Number.isFinite(value.retryAfter) ? { retryAfter: value.retryAfter } : {}),
    ...(typeof value.lastSyncedAt === "number" && Number.isFinite(value.lastSyncedAt)
      ? { lastSyncedAt: value.lastSyncedAt }
      : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

export function loadJournalStore(): SyncJournalStore {
  if (typeof window === "undefined") return defaultJournalStore();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultJournalStore();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return defaultJournalStore();

    const workspaces: Record<string, WorkspaceJournal> = {};
    if (isRecord(parsed.workspaces)) {
      for (const [key, value] of Object.entries(parsed.workspaces)) {
        const entry = readJournal(value);
        if (entry) workspaces[key] = entry;
      }
    }
    return { version: 1, userId: typeof parsed.userId === "string" ? parsed.userId : null, workspaces };
  } catch {
    return defaultJournalStore();
  }
}

export function saveJournalStore(store: SyncJournalStore): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    // Storage full or unavailable. Pending work is lost on reload, which
    // costs a re-push of current state — never local data.
    return false;
  }
}

export function clearJournalStore(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to recover: this is bookkeeping, not content.
  }
}

/**
 * One workspace's journal for a given account.
 *
 * A mismatched user reads as a fresh `never-synced` entry rather than the
 * previous account's cursor and pending work — using those would push one
 * user's edits at another user's workspace.
 */
export function getJournal(store: SyncJournalStore, userId: string, workspaceId: string): WorkspaceJournal {
  if (store.userId !== userId) return defaultJournal(workspaceId);
  return store.workspaces[workspaceId] ?? defaultJournal(workspaceId);
}

export function setJournal(
  store: SyncJournalStore,
  userId: string,
  journal: WorkspaceJournal
): SyncJournalStore {
  // Switching accounts starts a clean blob rather than merging: cursors,
  // dirty refs and conflicts are all account-scoped.
  const base = store.userId === userId ? store : { version: 1 as const, userId, workspaces: {} };
  return { version: 1, userId, workspaces: { ...base.workspaces, [journal.workspaceId]: journal } };
}

/**
 * Adds dirty refs, keeping one entry per entity.
 *
 * The last word wins for the `deleted` flag: an entity edited and then
 * deleted is a deletion, and one deleted and then re-created is an upsert.
 * Either way exactly one entry survives, which is what keeps the journal
 * bounded however many times a user edits the same tab.
 */
export function addDirty(journal: WorkspaceJournal, refs: readonly DirtyRef[]): WorkspaceJournal {
  if (refs.length === 0) return journal;
  const byKey = new Map(journal.dirty.map((entry) => [refKey(entry.ref), entry]));
  for (const entry of refs) byKey.set(refKey(entry.ref), entry);
  return { ...journal, dirty: [...byKey.values()] };
}

/**
 * Removes refs the server accepted.
 *
 * Deliberately NOT "clear everything": an edit made while the request was in
 * flight is still pending, and clearing the whole set would lose it
 * silently. Only what was actually sent is retired, and only when its
 * current value still matches what was sent.
 */
export function clearDirty(journal: WorkspaceJournal, accepted: readonly DirtyRef[]): WorkspaceJournal {
  if (accepted.length === 0) return journal;
  const acceptedKeys = new Set(accepted.map((entry) => refKey(entry.ref)));
  return { ...journal, dirty: journal.dirty.filter((entry) => !acceptedKeys.has(refKey(entry.ref))) };
}

/** Replaces or inserts a conflict by its deterministic id, so re-detecting one does not accumulate duplicates. */
export function upsertConflicts(
  journal: WorkspaceJournal,
  conflicts: readonly LocalSyncConflict[]
): WorkspaceJournal {
  if (conflicts.length === 0) return journal;
  const byId = new Map(journal.conflicts.map((c) => [c.id, c]));
  for (const conflict of conflicts) byId.set(conflict.id, conflict);
  return { ...journal, conflicts: [...byId.values()], status: "conflict" };
}

export function removeConflict(journal: WorkspaceJournal, conflictId: string): WorkspaceJournal {
  const conflicts = journal.conflicts.filter((c) => c.id !== conflictId);
  if (conflicts.length === journal.conflicts.length) return journal;
  return {
    ...journal,
    conflicts,
    // Leaving the last conflict returns the workspace to ordinary work
    // rather than stranding it in a state nothing clears.
    status: conflicts.length === 0 ? (journal.dirty.length > 0 ? "queued" : "idle") : "conflict",
  };
}

/** Exponential backoff with jitter, capped. Bounded on purpose: an unbounded retry loop is a denial of service aimed at our own server. */
export function backoffDelayMs(failureCount: number, random = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, failureCount - 1), 5 * 60_000);
  // Jitter spreads a fleet of reconnecting clients rather than having them
  // all retry on the same second.
  return Math.round(base * (0.5 + random() * 0.5));
}
