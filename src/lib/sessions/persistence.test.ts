import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { createSession, renameSession, replaceSessionTabs } from "./model"
import { SESSIONS_STORAGE_KEY, __resetSessionsForTests, getSessionsSnapshot, sessionsAreReadOnly, subscribeSessions, writeSessions } from "./persistence"

let n = 0
const mintId = () => `id-${++n}`
const tabs = [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/", title: "B" }]

function save(name: string) {
  const result = writeSessions((state) => createSession(state, { name, tabs }, { now: 1000 + n, mintId }))
  if (!result.ok) throw new Error(result.error)
  return result.value
}

beforeEach(() => {
  localStorage.clear()
  __resetSessionsForTests()
  setStorageNamespace(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  setStorageNamespace(null)
})

describe("session persistence", () => {
  it("survives a reload: what was saved is read back from storage", () => {
    const saved = save("Essay")
    __resetSessionsForTests() // a fresh page
    expect(getSessionsSnapshot().sessions).toEqual([saved])
    expect(JSON.parse(localStorage.getItem(SESSIONS_STORAGE_KEY)!).version).toBe(1)
  })

  it("keeps several sessions independent", () => {
    const first = save("First")
    const second = save("Second")
    const renamed = writeSessions((state) => renameSession(state, first.id, "First, renamed"))
    expect(renamed.ok).toBe(true)
    const stored = getSessionsSnapshot().sessions
    expect(stored.find((session) => session.id === second.id)).toEqual(second)
    expect(stored.find((session) => session.id === first.id)?.name).toBe("First, renamed")
  })

  it("returns the same object while storage is unchanged (a stable snapshot)", () => {
    save("Essay")
    expect(getSessionsSnapshot()).toBe(getSessionsSnapshot())
  })

  it("writes against what is stored now, not a stale copy, so another tab's save isn't lost", () => {
    save("Mine")
    // Another Hubble tab saves meanwhile, straight into storage.
    const other = JSON.parse(localStorage.getItem(SESSIONS_STORAGE_KEY)!)
    other.sessions.unshift({ id: "from-other-tab", name: "Theirs", createdAt: 5, updatedAt: 5, revision: 0, tabs: [{ id: "t", url: "https://c.example/", title: "" }] })
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(other))
    save("Mine again")
    expect(getSessionsSnapshot().sessions.map((session) => session.name).sort()).toEqual(["Mine", "Mine again", "Theirs"])
  })

  it("leaves the previous snapshot intact when storage refuses the write", () => {
    const saved = save("Essay")
    const before = localStorage.getItem(SESSIONS_STORAGE_KEY)
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    const failed = writeSessions((state) => replaceSessionTabs(state, saved.id, tabs.slice(0, 1), { now: 9, mintId, expectedRevision: saved.revision }))
    expect(failed).toEqual({ ok: false, error: "storage-failed" })
    vi.restoreAllMocks()
    expect(localStorage.getItem(SESSIONS_STORAGE_KEY)).toBe(before)
    expect(getSessionsSnapshot().sessions[0].tabs).toHaveLength(2)
  })

  it("stores nothing when the change itself is refused", () => {
    const listener = vi.fn()
    const stop = subscribeSessions(listener)
    const result = writeSessions((state) => createSession(state, { name: "Empty", tabs: [] }, { now: 1, mintId }))
    expect(result).toEqual({ ok: false, error: "empty" })
    expect(localStorage.getItem(SESSIONS_STORAGE_KEY)).toBeNull()
    expect(listener).not.toHaveBeenCalled()
    stop()
  })

  it("keeps unreadable data aside instead of silently discarding it", () => {
    localStorage.setItem(SESSIONS_STORAGE_KEY, "{not json")
    expect(getSessionsSnapshot().sessions).toEqual([])
    save("Fresh")
    expect(localStorage.getItem(`${SESSIONS_STORAGE_KEY}:unreadable-backup`)).toBe("{not json")
    expect(getSessionsSnapshot().sessions.map((session) => session.name)).toEqual(["Fresh"])
  })

  it("never rewrites sessions saved by a newer Hubble", () => {
    const newer = JSON.stringify({ version: 2, sessions: [{ id: "s", name: "Future", createdAt: 1, tabs: [{ url: "https://a.example/" }] }] })
    localStorage.setItem(SESSIONS_STORAGE_KEY, newer)
    expect(sessionsAreReadOnly()).toBe(true)
    expect(getSessionsSnapshot().sessions.map((session) => session.name)).toEqual(["Future"])
    expect(writeSessions((state) => createSession(state, { name: "x", tabs }, { now: 1, mintId }))).toEqual({ ok: false, error: "read-only" })
    expect(localStorage.getItem(SESSIONS_STORAGE_KEY)).toBe(newer)
  })

  it("keeps each account's sessions apart", () => {
    save("Signed out")
    setStorageNamespace("user-1")
    expect(getSessionsSnapshot().sessions).toEqual([])
    save("Signed in")
    expect(localStorage.getItem("tabdump:u:user-1:tab-sessions:v1")).toContain("Signed in")
    setStorageNamespace(null)
    expect(getSessionsSnapshot().sessions.map((session) => session.name)).toEqual(["Signed out"])
  })

  it("tells subscribers about a change made here and one made in another tab", () => {
    const listener = vi.fn()
    const stop = subscribeSessions(listener)
    save("Here")
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new StorageEvent("storage", { key: SESSIONS_STORAGE_KEY }))
    expect(listener).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new StorageEvent("storage", { key: "tabdump:workspaces:v1" }))
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })
})
