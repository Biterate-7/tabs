/**
 * localStorage that survives a crash, in Hubble Desktop.
 *
 * WebView2 writes localStorage to disk lazily and flushes on a normal close;
 * a crash, force-quit or power cut lost the newest edits (a project and its
 * saved conversation, in testing). So every change is mirrored to Rust
 * (src-tauri/src/durable_store.rs), which writes it to its own file within
 * ~100 ms, and at start-up — before the app reads anything — those values are
 * restored over whatever WebView2 managed to keep.
 *
 *   start:   read the copy → complete? restore it over localStorage
 *                           : seed it from localStorage (first run, or after a failed write)
 *   then:    localStorage.setItem / removeItem / clear → coalesced → durable_store_write
 *
 * The copy is trusted only while it is complete (Rust drops the mark when any
 * write fails), so a copy that missed a change never overwrites newer data.
 */

export type DurableSnapshot = { complete: boolean; entries: Record<string, string> }
export type DurableChange = { key: string; value: string | null }
export type DurableStoreApi = {
  read(): Promise<DurableSnapshot>
  write(changes: DurableChange[], options: { clear: boolean; seed: boolean }): Promise<void>
}

/** How long changes gather before one write: a burst of saves is one write, and a crash loses at most this much. */
export const MIRROR_DELAY_MS = 100

export type RestorePlan =
  /** The copy is complete and wins: these keys are set, these removed. */
  | { kind: "restore"; set: [string, string][]; remove: string[] }
  /** No complete copy: write one from what localStorage holds now. */
  | { kind: "seed"; changes: DurableChange[] }

/** Pure: what start-up does with localStorage, given the durable copy. */
export function planRestore(snapshot: DurableSnapshot, local: Record<string, string>): RestorePlan {
  if (!snapshot.complete) return { kind: "seed", changes: Object.entries(local).map(([key, value]) => ({ key, value })) }
  const set = Object.entries(snapshot.entries).filter(([key, value]) => local[key] !== value)
  const remove = Object.keys(local).filter((key) => !(key in snapshot.entries))
  return { kind: "restore", set, remove }
}

/** Gathers changes and writes them one batch at a time, in order. */
export function createMirror(write: DurableStoreApi["write"], options: { delayMs?: number; onError?: (error: unknown) => void } = {}) {
  const delayMs = options.delayMs ?? MIRROR_DELAY_MS
  let pending = new Map<string, string | null>()
  let pendingClear = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined

  async function flush(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    // One batch at a time, so a later value never lands before an earlier one.
    while (inFlight) await inFlight
    if (pending.size === 0 && !pendingClear) return
    const changes = [...pending].map(([key, value]) => ({ key, value }))
    const clear = pendingClear
    pending = new Map()
    pendingClear = false
    inFlight = write(changes, { clear, seed: false })
      .catch((error) => options.onError?.(error))
      .finally(() => {
        inFlight = undefined
      })
    await inFlight
  }

  function schedule() {
    if (timer === undefined) timer = setTimeout(() => void flush(), delayMs)
  }

  return {
    set(key: string, value: string) {
      pending.set(key, value)
      schedule()
    },
    remove(key: string) {
      pending.set(key, null)
      schedule()
    },
    clear() {
      pending = new Map()
      pendingClear = true
      schedule()
    },
    flush,
  }
}

function snapshotOf(storage: Storage): Record<string, string> {
  const entries: Record<string, string> = {}
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key !== null) entries[key] = storage.getItem(key) ?? ""
  }
  return entries
}

let started: Promise<void> | undefined
let unpatch: (() => void) | undefined

/**
 * Restores the durable copy into `storage`, then mirrors every later change.
 * Once per page (React StrictMode runs effects twice). Never rejects: without
 * the copy Hubble works exactly as before.
 */
export function startDurableStorage(api: DurableStoreApi, storage: Storage = window.localStorage, onError: (error: unknown) => void = (error) => console.warn("[hubble] durable storage:", error)): Promise<void> {
  started ??= (async () => {
    const proto = Object.getPrototypeOf(storage) as Storage
    const original = { setItem: proto.setItem, removeItem: proto.removeItem, clear: proto.clear }
    unpatch = () => Object.assign(proto, original)
    try {
      const plan = planRestore(await api.read(), snapshotOf(storage))
      if (plan.kind === "restore") {
        for (const [key, value] of plan.set) original.setItem.call(storage, key, value)
        for (const key of plan.remove) original.removeItem.call(storage, key)
      } else {
        await api.write(plan.changes, { clear: true, seed: true })
      }
    } catch (error) {
      onError(error)
    }
    const mirror = createMirror((changes, options) => api.write(changes, options), { onError })
    // On the prototype, for this one Storage object only: assigning `storage.setItem` would store an item named "setItem".
    proto.setItem = function (this: Storage, key: string, value: string) {
      original.setItem.call(this, key, value)
      if (this === storage) mirror.set(String(key), String(value))
    }
    proto.removeItem = function (this: Storage, key: string) {
      original.removeItem.call(this, key)
      if (this === storage) mirror.remove(String(key))
    }
    proto.clear = function (this: Storage) {
      original.clear.call(this)
      if (this === storage) mirror.clear()
    }
    window.addEventListener("pagehide", () => void mirror.flush())
  })()
  return started
}

/** Test-only. */
export function __resetDurableStorageForTests(): void {
  unpatch?.()
  unpatch = undefined
  started = undefined
}
