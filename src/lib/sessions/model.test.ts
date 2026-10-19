import { describe, expect, it } from "vitest"
import {
  copyName,
  createSession,
  deleteSession,
  duplicateSession,
  emptySessionsState,
  markSessionRestored,
  mostRecentSession,
  readSessionsState,
  renameSession,
  replaceSessionTabs,
  sortByActivity,
  tabLabel,
} from "./model"
import { MAX_SESSION_TABS } from "./types"
import type { SessionsState, TabSession } from "./types"

function ids() {
  let n = 0
  return () => `id-${++n}`
}

const tabs = [
  { url: "https://docs.google.com/document/d/abc/edit#heading=h.1", title: "Essay draft" },
  { url: "https://en.wikipedia.org/wiki/Treaty_of_Versailles", title: "Treaty of Versailles", pinned: true },
  { url: "https://www.jstor.org/stable/123?seq=4", title: "" },
]

function withSession(): { state: SessionsState; session: TabSession; mintId: () => string } {
  const mintId = ids()
  const result = createSession(emptySessionsState(), { name: "History essay", tabs }, { now: 1000, mintId })
  if (!result.ok) throw new Error(result.error)
  return { state: result.state, session: result.value, mintId }
}

describe("createSession", () => {
  it("saves the tabs in their order with their titles, and nothing else", () => {
    const { session } = withSession()
    expect(session.name).toBe("History essay")
    expect(session.tabs.map((tab) => tab.url)).toEqual(tabs.map((tab) => tab.url))
    expect(session.tabs.map((tab) => tab.title)).toEqual(["Essay draft", "Treaty of Versailles", ""])
    expect(session.tabs[1].pinned).toBe(true)
    expect(session.createdAt).toBe(1000)
    expect(session.updatedAt).toBe(1000)
    expect(session.lastRestoredAt).toBeUndefined()
    expect(new Set(session.tabs.map((tab) => tab.id)).size).toBe(3)
  })

  it("leaves out addresses Chrome could not reopen, and refuses a session with none left", () => {
    const mintId = ids()
    const mixed = createSession(
      emptySessionsState(),
      { name: "Mixed", tabs: [{ url: "chrome://settings" }, { url: "javascript:alert(1)" }, { url: "https://example.com/" }] },
      { now: 1, mintId }
    )
    expect(mixed.ok && mixed.value.tabs.map((tab) => tab.url)).toEqual(["https://example.com/"])

    const none = createSession(emptySessionsState(), { name: "Nothing", tabs: [{ url: "chrome://newtab" }] }, { now: 1, mintId })
    expect(none).toEqual({ ok: false, error: "empty" })
    expect(createSession(emptySessionsState(), { name: "Nothing", tabs: [] }, { now: 1, mintId })).toEqual({ ok: false, error: "empty" })
  })

  it("keeps only http(s) icons and drops inline ones", () => {
    const result = createSession(
      emptySessionsState(),
      {
        name: "Icons",
        tabs: [
          { url: "https://a.example/", favicon: "https://a.example/favicon.ico" },
          { url: "https://b.example/", favicon: "data:image/png;base64,AAAA" },
        ],
      },
      { now: 1, mintId: ids() }
    )
    expect(result.ok && result.value.tabs.map((tab) => tab.favicon)).toEqual(["https://a.example/favicon.ico", undefined])
  })

  it("refuses more tabs than one session holds", () => {
    const many = Array.from({ length: MAX_SESSION_TABS + 1 }, (_, i) => ({ url: `https://example.com/${i}` }))
    expect(createSession(emptySessionsState(), { name: "Too many", tabs: many }, { now: 1, mintId: ids() })).toEqual({ ok: false, error: "too-many-tabs" })
  })

  it("names an unnamed session rather than storing a blank name", () => {
    const result = createSession(emptySessionsState(), { name: "   ", tabs }, { now: 1, mintId: ids() })
    expect(result.ok && result.value.name).toBe("Session")
  })
})

describe("renameSession", () => {
  it("changes the name only: tabs, times and project stay", () => {
    const { state, session } = withSession()
    const renamed = renameSession(state, session.id, "  WW1 essay ")
    if (!renamed.ok) throw new Error(renamed.error)
    expect(renamed.value).toEqual({ ...session, name: "WW1 essay", revision: session.revision + 1 })
  })

  it("refuses an empty name and a missing session", () => {
    const { state, session } = withSession()
    expect(renameSession(state, session.id, " ")).toEqual({ ok: false, error: "empty" })
    expect(renameSession(state, "gone", "x")).toEqual({ ok: false, error: "missing" })
  })
})

describe("duplicateSession", () => {
  it("makes an independent copy with new ids", () => {
    const { state, session, mintId } = withSession()
    const copy = duplicateSession(state, session.id, { now: 2000, mintId })
    if (!copy.ok) throw new Error(copy.error)
    expect(copy.value.id).not.toBe(session.id)
    expect(copy.value.name).toBe("History essay (copy)")
    expect(copy.value.tabs.map((tab) => tab.url)).toEqual(session.tabs.map((tab) => tab.url))
    expect(copy.value.tabs.some((tab) => session.tabs.some((original) => original.id === tab.id))).toBe(false)
    expect(copy.state.sessions).toHaveLength(2)

    // Editing the copy leaves the original alone.
    const edited = replaceSessionTabs(copy.state, copy.value.id, copy.value.tabs.slice(0, 1), { now: 3000, mintId, expectedRevision: 0 })
    if (!edited.ok) throw new Error(edited.error)
    expect(edited.state.sessions.find((entry) => entry.id === session.id)).toEqual(session)
  })

  it("never reuses a copy name", () => {
    expect(copyName("Essay", new Set(["Essay", "Essay (copy)"]))).toBe("Essay (copy 2)")
    expect(copyName("Essay (copy)", new Set(["Essay (copy)"]))).toBe("Essay (copy 2)")
  })
})

describe("deleteSession", () => {
  it("removes only that session", () => {
    const { state, session, mintId } = withSession()
    const other = createSession(state, { name: "Other", tabs }, { now: 5, mintId })
    if (!other.ok) throw new Error(other.error)
    const deleted = deleteSession(other.state, session.id)
    expect(deleted.ok && deleted.state.sessions.map((entry) => entry.id)).toEqual([other.value.id])
    expect(deleteSession(other.state, "gone")).toEqual({ ok: false, error: "missing" })
  })
})

describe("replaceSessionTabs", () => {
  it("keeps kept tabs' ids, orders as given, and bumps the saved time", () => {
    const { state, session, mintId } = withSession()
    const reordered = [session.tabs[2], session.tabs[0]]
    const result = replaceSessionTabs(state, session.id, reordered, { now: 5000, mintId, expectedRevision: session.revision })
    if (!result.ok) throw new Error(result.error)
    expect(result.value.tabs.map((tab) => tab.id)).toEqual([session.tabs[2].id, session.tabs[0].id])
    expect(result.value.updatedAt).toBe(5000)
    expect(result.value.createdAt).toBe(1000)
  })

  it("refuses to overwrite a session that changed since it was read", () => {
    const { state, session, mintId } = withSession()
    const renamed = renameSession(state, session.id, "Renamed elsewhere")
    if (!renamed.ok) throw new Error(renamed.error)
    const stale = replaceSessionTabs(renamed.state, session.id, session.tabs.slice(0, 1), { now: 6000, mintId, expectedRevision: session.revision })
    expect(stale).toEqual({ ok: false, error: "conflict" })
  })

  it("refuses to empty a session — that is a delete", () => {
    const { state, session, mintId } = withSession()
    expect(replaceSessionTabs(state, session.id, [], { now: 1, mintId, expectedRevision: 0 })).toEqual({ ok: false, error: "empty" })
  })
})

describe("markSessionRestored", () => {
  it("records the time and leaves the tabs alone", () => {
    const { state, session } = withSession()
    const result = markSessionRestored(state, session.id, 9000)
    expect(result.ok && result.value).toEqual({ ...session, lastRestoredAt: 9000, revision: 1 })
  })

  it("is a no-op for a session deleted meanwhile", () => {
    const { state } = withSession()
    const result = markSessionRestored(state, "gone", 9000)
    expect(result.ok && result.state).toBe(state)
  })
})

describe("readSessionsState", () => {
  it("drops malformed sessions and tabs, keeps the first of a duplicated id", () => {
    const state = readSessionsState(
      {
        version: 1,
        sessions: [
          { id: "a", name: "Good", createdAt: 10, updatedAt: 20, tabs: [{ id: "t1", url: "https://a.example/", title: "A" }, { id: "t2", url: "chrome://x" }] },
          { id: "a", name: "Duplicate id", createdAt: 10, updatedAt: 20, tabs: [{ id: "t", url: "https://b.example/" }] },
          { id: "b", name: "", createdAt: 10, tabs: [{ url: "https://b.example/" }] },
          { id: "c", name: "Only bad tabs", createdAt: 10, tabs: [{ url: "file:///etc/passwd" }] },
          { id: "d", name: "No time", tabs: [{ url: "https://d.example/" }] },
          "garbage",
          null,
        ],
      },
      ids()
    )
    expect(state.sessions.map((session) => session.id)).toEqual(["a"])
    expect(state.sessions[0].tabs.map((tab) => tab.url)).toEqual(["https://a.example/"])
  })

  it("gives duplicated tab ids inside a session fresh ones", () => {
    const state = readSessionsState(
      { version: 1, sessions: [{ id: "a", name: "x", createdAt: 1, tabs: [{ id: "t", url: "https://a.example/" }, { id: "t", url: "https://b.example/" }] }] },
      ids()
    )
    const [first, second] = state.sessions[0].tabs
    expect(first.id).not.toBe(second.id)
  })

  it("treats anything that isn't a sessions object as empty", () => {
    expect(readSessionsState(null, ids())).toEqual(emptySessionsState())
    expect(readSessionsState({ sessions: "nope" }, ids())).toEqual(emptySessionsState())
  })
})

describe("mostRecentSession", () => {
  it("is the one most recently saved, edited or opened", () => {
    const base = { tabs: [{ id: "t", url: "https://a.example/", title: "" }], revision: 0 }
    const saved: TabSession = { ...base, id: "saved", name: "Saved", createdAt: 100, updatedAt: 500 }
    const opened: TabSession = { ...base, id: "opened", name: "Opened", createdAt: 50, updatedAt: 60, lastRestoredAt: 900 }
    const old: TabSession = { ...base, id: "old", name: "Old", createdAt: 10, updatedAt: 10 }
    expect(mostRecentSession([saved, old, opened])?.id).toBe("opened")
    expect(sortByActivity([old, saved, opened]).map((session) => session.id)).toEqual(["opened", "saved", "old"])
    expect(mostRecentSession([])).toBeUndefined()
  })
})

describe("tabLabel", () => {
  it("shows the saved title, or a short form of the address when there was none", () => {
    expect(tabLabel({ title: "Essay", url: "https://docs.google.com/x" })).toBe("Essay")
    expect(tabLabel({ title: "", url: "https://www.jstor.org/stable/123?seq=4" })).toBe("jstor.org/stable/123")
  })
})
