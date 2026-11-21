import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetDurableStorageForTests, createMirror, planRestore, startDurableStorage, type DurableChange, type DurableStoreApi } from "./durable-storage"

describe("planRestore", () => {
  it("restores a complete copy over what localStorage kept, removing what the copy doesn't have", () => {
    const plan = planRestore(
      { complete: true, entries: { "tabdump:workspaces:v1": "new", same: "1" } },
      { "tabdump:workspaces:v1": "old", same: "1", "removed-before-the-crash": "x" }
    )
    expect(plan).toEqual({ kind: "restore", set: [["tabdump:workspaces:v1", "new"]], remove: ["removed-before-the-crash"] })
  })

  it("never trusts an incomplete copy: it is seeded from localStorage instead", () => {
    expect(planRestore({ complete: false, entries: { a: "stale" } }, { a: "1", b: "2" })).toEqual({
      kind: "seed",
      changes: [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ],
    })
  })
})

describe("createMirror", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("gathers a burst of changes into one write, last value winning", async () => {
    const write = vi.fn(async () => {})
    const mirror = createMirror(write)
    mirror.set("a", "1")
    mirror.set("a", "2")
    mirror.remove("b")
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(
      [
        { key: "a", value: "2" },
        { key: "b", value: null },
      ],
      { clear: false, seed: false }
    )
  })

  it("writes one batch at a time, in order, and keeps going after a failed write", async () => {
    const batches: DurableChange[][] = []
    let release!: () => void
    const write = vi.fn((changes: DurableChange[]) => {
      batches.push(changes)
      return batches.length === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.reject(new Error("disk full"))
    })
    const onError = vi.fn()
    const mirror = createMirror(write, { onError })
    mirror.set("a", "1")
    await vi.advanceTimersByTimeAsync(100)
    mirror.set("a", "2")
    const second = mirror.flush()
    await vi.advanceTimersByTimeAsync(10)
    // The second batch waits for the first.
    expect(batches).toHaveLength(1)
    release()
    await second
    expect(batches).toEqual([[{ key: "a", value: "1" }], [{ key: "a", value: "2" }]])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("a clear drops what was pending and is sent as a clear", async () => {
    const write = vi.fn(async () => {})
    const mirror = createMirror(write)
    mirror.set("a", "1")
    mirror.clear()
    mirror.set("b", "2")
    await mirror.flush()
    expect(write).toHaveBeenCalledWith([{ key: "b", value: "2" }], { clear: true, seed: false })
  })
})

describe("startDurableStorage", () => {
  function fakeStore(snapshot: { complete: boolean; entries: Record<string, string> }) {
    const writes: { changes: DurableChange[]; clear: boolean; seed: boolean }[] = []
    const api: DurableStoreApi = {
      read: vi.fn(async () => snapshot),
      write: vi.fn(async (changes, options) => {
        writes.push({ changes, ...options })
      }),
    }
    return { api, writes }
  }

  beforeEach(() => {
    window.localStorage.clear()
    __resetDurableStorageForTests()
  })
  afterEach(() => {
    __resetDurableStorageForTests()
    window.localStorage.clear()
  })

  it("puts back what a crash lost before the app reads anything, then mirrors every change", async () => {
    // What WebView2 had on disk after the crash: the project as it was a minute earlier.
    window.localStorage.setItem("tabdump:workspaces:v1", '{"workspaces":[{"name":"General"}]}')
    const { api, writes } = fakeStore({ complete: true, entries: { "tabdump:workspaces:v1": '{"workspaces":[{"name":"Physics revision"}]}' } })
    await startDurableStorage(api)
    expect(window.localStorage.getItem("tabdump:workspaces:v1")).toBe('{"workspaces":[{"name":"Physics revision"}]}')
    // Restoring isn't echoed back.
    expect(writes).toEqual([])

    window.localStorage.setItem("tabdump:tab-sessions:v1", "s")
    window.localStorage.removeItem("tabdump:workspaces:v1")
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({
      changes: [
        { key: "tabdump:tab-sessions:v1", value: "s" },
        { key: "tabdump:workspaces:v1", value: null },
      ],
      clear: false,
      seed: false,
    })
  })

  it("on first run (no complete copy), seeds the copy from localStorage", async () => {
    window.localStorage.setItem("a", "1")
    const { api, writes } = fakeStore({ complete: false, entries: {} })
    await startDurableStorage(api)
    expect(writes).toEqual([{ changes: [{ key: "a", value: "1" }], clear: true, seed: true }])
    expect(window.localStorage.getItem("a")).toBe("1")
  })

  it("mirrors only this localStorage, not sessionStorage, and stores nothing named setItem", async () => {
    const { api, writes } = fakeStore({ complete: true, entries: {} })
    await startDurableStorage(api)
    window.sessionStorage.setItem("s", "1")
    window.localStorage.setItem("l", "1")
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.changes).toEqual([{ key: "l", value: "1" }])
    expect(window.localStorage.getItem("setItem")).toBeNull()
    window.sessionStorage.clear()
  })

  it("runs once, and without the copy Hubble still starts", async () => {
    const onError = vi.fn()
    const api: DurableStoreApi = { read: vi.fn(async () => Promise.reject(new Error("no data folder"))), write: vi.fn(async () => {}) }
    await Promise.all([startDurableStorage(api, window.localStorage, onError), startDurableStorage(api, window.localStorage, onError)])
    expect(api.read).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    window.localStorage.setItem("k", "v")
    expect(window.localStorage.getItem("k")).toBe("v")
  })
})
