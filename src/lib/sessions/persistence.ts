import { createId } from "@/lib/id"
import { scopedKey } from "@/lib/storage/namespace"
import { emptySessionsState, readSessionsState } from "./model"
import { SESSIONS_SCHEMA_VERSION } from "./types"
import type { SessionWrite, SessionsState } from "./types"

/**
 * Where sessions are kept: this browser's localStorage, under the signed-in
 * account's namespace when there is one (listed in SCOPED_STORAGE_KEYS).
 *
 * Every write is read-modify-write against what is stored *now*, not against
 * a copy a component read earlier: the extension can save a session into a
 * Hubble tab in the background while another Hubble tab is open, and neither
 * may erase the other's work. A write that cannot be stored changes nothing
 * — the previous copy stays exactly as it was and the caller is told.
 */
export const SESSIONS_STORAGE_KEY = "tabdump:tab-sessions:v1"

/** A copy of unreadable stored data, taken once before it would first be overwritten. */
const CORRUPT_BACKUP_SUFFIX = ":unreadable-backup"

const EMPTY: SessionsState = Object.freeze({ version: SESSIONS_SCHEMA_VERSION, sessions: Object.freeze([]) as never }) as SessionsState

type Snapshot = { key: string; raw: string | null; state: SessionsState; readOnly: boolean }

let cache: Snapshot | null = null
const listeners = new Set<() => void>()

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function parse(raw: string | null): { state: SessionsState; readOnly: boolean; corrupt: boolean } {
  if (raw === null) return { state: EMPTY, readOnly: false, corrupt: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: EMPTY, readOnly: false, corrupt: true }
  }
  // Written by a newer Hubble than this one: shown as far as it can be read, never rewritten in an older shape.
  const version = (parsed as { version?: unknown } | null)?.version
  if (typeof version === "number" && version > SESSIONS_SCHEMA_VERSION) {
    return { state: readSessionsState(parsed, createId), readOnly: true, corrupt: false }
  }
  if (!parsed || typeof parsed !== "object") return { state: EMPTY, readOnly: false, corrupt: true }
  return { state: readSessionsState(parsed, createId), readOnly: false, corrupt: false }
}

/**
 * The stored sessions, as one stable object for as long as storage holds the
 * same text — what useSyncExternalStore needs (a new object every call would
 * re-render forever). Never throws.
 */
export function getSessionsSnapshot(): SessionsState {
  if (typeof window === "undefined") return EMPTY
  const key = scopedKey(SESSIONS_STORAGE_KEY)
  const raw = readRaw(key)
  if (cache && cache.key === key && cache.raw === raw) return cache.state
  const { state, readOnly } = parse(raw)
  cache = { key, raw, state, readOnly }
  return state
}

/** The server render (and any render before storage can be read) has no sessions. */
export function getServerSessionsSnapshot(): SessionsState {
  return EMPTY
}

/** True when the stored sessions were written by a newer version of Hubble and must not be overwritten. */
export function sessionsAreReadOnly(): boolean {
  getSessionsSnapshot()
  return cache?.readOnly ?? false
}

function notify() {
  for (const listener of listeners) listener()
}

/**
 * Re-renders on a change made here and on one made in another tab of this
 * origin (the `storage` event), which is how a session saved from the
 * extension into a background Hubble tab appears in the one on screen.
 */
export function subscribeSessions(listener: () => void): () => void {
  listeners.add(listener)
  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === scopedKey(SESSIONS_STORAGE_KEY)) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/**
 * Applies `change` to the stored sessions and stores the result.
 *
 * Re-reads storage first; the change is pure (see ./model.ts). When it is
 * refused, or storage refuses the write (quota, storage disabled), nothing is
 * stored and the caller gets the reason.
 */
export function writeSessions<T>(change: (state: SessionsState) => SessionWrite<T>): SessionWrite<T> {
  const key = scopedKey(SESSIONS_STORAGE_KEY)
  const raw = readRaw(key)
  const { state, readOnly, corrupt } = parse(raw)
  if (readOnly) return { ok: false, error: "read-only" }
  const result = change(state === EMPTY ? emptySessionsState() : state)
  if (!result.ok) return result
  try {
    // Unreadable data is kept aside once, never silently discarded.
    if (corrupt && raw !== null && readRaw(key + CORRUPT_BACKUP_SUFFIX) === null) {
      window.localStorage.setItem(key + CORRUPT_BACKUP_SUFFIX, raw)
    }
    window.localStorage.setItem(key, JSON.stringify(result.state))
  } catch {
    return { ok: false, error: "storage-failed" }
  }
  cache = null
  notify()
  return result
}

/** Test-only: forget the cached snapshot and every subscriber. */
export function __resetSessionsForTests(): void {
  cache = null
  listeners.clear()
}
