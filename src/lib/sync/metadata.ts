/**
 * Device-local synchronization bookkeeping.
 *
 * Deliberately its OWN localStorage blob rather than fields on Workspace,
 * for three reasons that all point the same way:
 *
 *  - A cursor is not the user's data. It says how far THIS browser has read
 *    the server's change stream. A laptop at cursor 42 and a desktop at 57
 *    are both correct, and storing one number on the shared workspace would
 *    make them fight over it.
 *  - Workspace data is exported. `parseWorkspaceExport` reads back exactly
 *    what `Workspace` holds, so a cursor living there would travel into a
 *    .json file and then into whatever machine imported it, where it would
 *    be actively wrong. Keeping it here means the export format needs no
 *    change at all.
 *  - It is scoped per account as well as per device: signing in as someone
 *    else must not inherit the previous account's cursors.
 *
 * Nothing here is authoritative about workspace content. Losing this blob
 * costs a full re-pull, never data.
 */

import type { SyncCursor } from "./types";
import { SYNC_CURSOR_START } from "./types";

const STORAGE_KEY = "tabdump:sync-meta:v1";

/**
 * Where one workspace stands with the server, from this device's point of
 * view.
 *
 *  - `never-synced`  — the server has not been told about this workspace.
 *                      NOT the same as "the server deleted it": absence is
 *                      never deletion (see SYNC_INITIAL_POLICY).
 *  - `synced`        — cursor is meaningful and up to date as of lastSyncedAt.
 *  - `conflict`      — a push was refused because the server moved on. The
 *                      local workspace is untouched and still usable.
 *  - `error`         — the last attempt failed (offline, 500, timeout). Also
 *                      non-destructive; the cursor still reflects the last
 *                      good read.
 */
export type SyncState = "never-synced" | "syncing" | "synced" | "conflict" | "error";

export type WorkspaceSyncMeta = {
  /** The LOCAL workspace id this entry describes. */
  workspaceId: string;
  /**
   * The server-side id, when a legacy-id workspace was renumbered on upload.
   * Equal to workspaceId in the ordinary case.
   */
  serverWorkspaceId: string;
  state: SyncState;
  /** How far this device has read the server's stream. Meaningless unless state has reached "synced" at least once. */
  cursor: SyncCursor;
  /** Epoch ms of the last successful exchange, or undefined if there has never been one. */
  lastSyncedAt?: number;
  /** Short, user-facing reason for the last failure. Never a stack trace or a server internal. */
  lastError?: string;
};

export type SyncMetaStore = {
  version: 1;
  /** Which account these cursors belong to; a different user id invalidates the whole blob. */
  userId: string | null;
  workspaces: Record<string, WorkspaceSyncMeta>;
};

export function defaultSyncMetaStore(): SyncMetaStore {
  return { version: 1, userId: null, workspaces: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATES: readonly SyncState[] = ["never-synced", "syncing", "synced", "conflict", "error"];

/**
 * Reads one entry defensively.
 *
 * This blob is untrusted persisted input like any other (see
 * src/lib/tabs/sanitize.ts's reasoning), and a malformed entry must not
 * prevent the app from starting. A bad entry is dropped, which costs a
 * re-pull and nothing else.
 */
function readEntry(value: unknown): WorkspaceSyncMeta | null {
  if (!isRecord(value)) return null;
  const { workspaceId, serverWorkspaceId, state, cursor, lastSyncedAt, lastError } = value;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  if (typeof state !== "string" || !STATES.includes(state as SyncState)) return null;
  if (typeof cursor !== "string") return null;
  return {
    workspaceId,
    serverWorkspaceId: typeof serverWorkspaceId === "string" ? serverWorkspaceId : workspaceId,
    state: state as SyncState,
    cursor,
    ...(typeof lastSyncedAt === "number" && Number.isFinite(lastSyncedAt) ? { lastSyncedAt } : {}),
    ...(typeof lastError === "string" ? { lastError } : {}),
  };
}

export function loadSyncMeta(): SyncMetaStore {
  if (typeof window === "undefined") return defaultSyncMetaStore();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSyncMetaStore();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return defaultSyncMetaStore();

    const workspaces: Record<string, WorkspaceSyncMeta> = {};
    if (isRecord(parsed.workspaces)) {
      for (const [key, value] of Object.entries(parsed.workspaces)) {
        const entry = readEntry(value);
        if (entry) workspaces[key] = entry;
      }
    }
    return {
      version: 1,
      userId: typeof parsed.userId === "string" ? parsed.userId : null,
      workspaces,
    };
  } catch {
    return defaultSyncMetaStore();
  }
}

export function saveSyncMeta(store: SyncMetaStore): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    // Storage unavailable or full. Sync bookkeeping is a convenience; the
    // workspace itself is stored elsewhere and is unaffected.
    return false;
  }
}

/**
 * Everything this device knows about one workspace, for a given account.
 *
 * A mismatched `userId` reads as "never synced" rather than as the previous
 * account's cursor — a cursor from another account would ask the server for
 * changes to a workspace this user does not own.
 */
export function getWorkspaceSyncMeta(
  store: SyncMetaStore,
  userId: string,
  workspaceId: string
): WorkspaceSyncMeta {
  if (store.userId !== userId) {
    return { workspaceId, serverWorkspaceId: workspaceId, state: "never-synced", cursor: SYNC_CURSOR_START };
  }
  return (
    store.workspaces[workspaceId] ?? {
      workspaceId,
      serverWorkspaceId: workspaceId,
      state: "never-synced",
      cursor: SYNC_CURSOR_START,
    }
  );
}

/**
 * Returns a NEW store with one workspace's entry replaced.
 *
 * Pure, like the domain reducers: the caller decides when to persist, so
 * this never writes and never reads the clock. Switching accounts clears
 * every entry rather than merging, because cursors are account-scoped.
 */
export function setWorkspaceSyncMeta(
  store: SyncMetaStore,
  userId: string,
  meta: WorkspaceSyncMeta
): SyncMetaStore {
  const base: SyncMetaStore =
    store.userId === userId ? store : { version: 1, userId, workspaces: {} };
  return {
    version: 1,
    userId,
    workspaces: { ...base.workspaces, [meta.workspaceId]: meta },
  };
}

/** Forgets every cursor. Used on sign-out, so the next account starts clean. */
export function clearSyncMeta(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to recover: the blob is a cache of server positions.
  }
}
