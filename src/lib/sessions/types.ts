/**
 * Sessions: a named snapshot of the tabs open in Chrome, kept so the person
 * can close everything and pick the work up again later.
 *
 * A session is a snapshot, not a live view. Nothing about the tabs that are
 * open now changes it: closing them, navigating them or saving the window
 * again leaves the stored list exactly as it was until the person explicitly
 * edits it or replaces it. Only what is needed to reopen a tab is kept — its
 * address, the title it had and Chrome's icon. No page content, cookies or
 * form values.
 *
 * Local-first: sessions live in this browser's storage, partitioned per
 * account like every other piece of personal content (see
 * src/lib/storage/namespace.ts). They do not sync between devices.
 */

/** One saved tab. `id` is minted when it is saved and only identifies it inside its session. */
export type SavedTab = {
  id: string
  url: string
  /** The title the page had when it was saved. May be empty: the list then shows the address. */
  title: string
  /** Chrome's icon for the page, http(s) only. */
  favicon?: string
  pinned?: boolean
}

export type TabSession = {
  id: string
  name: string
  /** In the order they were open in Chrome. Never empty. */
  tabs: SavedTab[]
  createdAt: number
  /** When the saved tabs last changed: saved, edited or replaced. Renaming does not count. */
  updatedAt: number
  /** The last time its tabs were opened from Hubble. */
  lastRestoredAt?: number
  /** A project (workspace) it belongs to. Dropped from view when that project is deleted. */
  workspaceId?: string
  /** Bumped by every write, so an edit made against an older copy is refused instead of overwriting a newer one. */
  revision: number
}

export const SESSIONS_SCHEMA_VERSION = 1

export type SessionsState = {
  version: typeof SESSIONS_SCHEMA_VERSION
  sessions: TabSession[]
}

/** A tab as it arrives to be saved — from the extension, or read from Chrome by this page. */
export type CapturedTab = {
  url: string
  title?: string
  favicon?: string
  pinned?: boolean
}

/** Why a write was refused. Every write either succeeds or changes nothing. */
export type SessionWriteError =
  | "empty"
  | "too-many-tabs"
  | "too-many-sessions"
  | "missing"
  | "conflict"
  | "storage-failed"
  | "read-only"

export type SessionWrite<T = undefined> = { ok: true; state: SessionsState; value: T } | { ok: false; error: SessionWriteError }

/** The most tabs one session holds, and the most one launch opens. */
export const MAX_SESSION_TABS = 200
export const MAX_SESSIONS = 300
export const MAX_SESSION_NAME_CHARS = 120
export const MAX_SAVED_TITLE_CHARS = 300
/** A launch this large asks before opening anything. */
export const CONFIRM_OPEN_ABOVE = 15
