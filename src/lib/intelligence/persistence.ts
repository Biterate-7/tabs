import { scopedKey } from "@/lib/storage/namespace"
import { emptyContextState, readContextState } from "./state"
import { CONTEXT_SCHEMA_VERSION } from "./types"
import type { ContextState } from "./types"

/**
 * Where context intelligence keeps what it knows: this browser's
 * localStorage, under the signed-in account's namespace (listed in
 * SCOPED_STORAGE_KEYS), like sessions and project history. Never synced,
 * never sent. Bounded by the record and feedback caps (state.ts), so it stays
 * small next to the workspace store.
 *
 * Every write is read-modify-write against what is stored now, so two Hubble
 * tabs pulling from the extension at once never erase each other's
 * decisions; other tabs re-render through the `storage` event. A write that
 * storage refuses changes nothing and says so.
 *
 * Migration: version 1 is the first schema. Data written by a newer Hubble is
 * shown as far as it can be read and never overwritten; unreadable data is
 * copied aside once before it is first replaced. Nothing a person decided is
 * ever deleted by an upgrade.
 */
export const CONTEXT_STORAGE_KEY = "tabdump:context:v1"

const CORRUPT_BACKUP_SUFFIX = ":unreadable-backup"
const EMPTY: ContextState = Object.freeze(emptyContextState()) as ContextState

type Snapshot = { key: string; raw: string | null; state: ContextState; readOnly: boolean }

let cache: Snapshot | null = null
const listeners = new Set<() => void>()

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function parse(raw: string | null): { state: ContextState; readOnly: boolean; corrupt: boolean } {
  if (raw === null) return { state: EMPTY, readOnly: false, corrupt: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: EMPTY, readOnly: false, corrupt: true }
  }
  const version = (parsed as { version?: unknown } | null)?.version
  if (typeof version === "number" && version > CONTEXT_SCHEMA_VERSION) return { state: readContextState(parsed), readOnly: true, corrupt: false }
  if (!parsed || typeof parsed !== "object" || version !== CONTEXT_SCHEMA_VERSION) return { state: EMPTY, readOnly: false, corrupt: true }
  return { state: readContextState(parsed), readOnly: false, corrupt: false }
}

export function getContextSnapshot(): ContextState {
  if (typeof window === "undefined") return EMPTY
  const key = scopedKey(CONTEXT_STORAGE_KEY)
  const raw = readRaw(key)
  if (cache && cache.key === key && cache.raw === raw) return cache.state
  const { state, readOnly } = parse(raw)
  cache = { key, raw, state, readOnly }
  return state
}

export function getServerContextSnapshot(): ContextState {
  return EMPTY
}

export function contextIsReadOnly(): boolean {
  getContextSnapshot()
  return cache?.readOnly ?? false
}

function notify() {
  for (const listener of listeners) listener()
}

export function subscribeContext(listener: () => void): () => void {
  listeners.add(listener)
  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === scopedKey(CONTEXT_STORAGE_KEY)) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export type ContextWrite = { ok: true; state: ContextState } | { ok: false; error: "read-only" | "storage-failed" }

/**
 * Applies `change` to the stored state and stores the result. `change` is
 * pure and may return its input unchanged, in which case nothing is written.
 */
export function writeContext(change: (state: ContextState) => ContextState): ContextWrite {
  const key = scopedKey(CONTEXT_STORAGE_KEY)
  const raw = readRaw(key)
  const { state, readOnly, corrupt } = parse(raw)
  if (readOnly) return { ok: false, error: "read-only" }
  const next = change(state === EMPTY ? emptyContextState() : state)
  if (next === state && !corrupt) return { ok: true, state }
  try {
    if (corrupt && raw !== null && readRaw(key + CORRUPT_BACKUP_SUFFIX) === null) {
      window.localStorage.setItem(key + CORRUPT_BACKUP_SUFFIX, raw)
    }
    window.localStorage.setItem(key, JSON.stringify(next))
  } catch {
    return { ok: false, error: "storage-failed" }
  }
  cache = null
  notify()
  return { ok: true, state: next }
}

/** Test-only. */
export function __resetContextForTests(): void {
  cache = null
  listeners.clear()
}
