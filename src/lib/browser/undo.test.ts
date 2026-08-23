import { describe, expect, it } from "vitest"
import { findBrowserUndoEntry, markBrowserUndone, pushBrowserUndoEntry } from "./undo"

describe("pushBrowserUndoEntry", () => {
  it("adds a new active entry with the given description and revert plan", () => {
    const { history, entry } = pushBrowserUndoEntry([], {
      description: "Opened 3 tabs.",
      revert: [{ kind: "close_tabs", tabIds: [1, 2, 3] }],
    })

    expect(history).toHaveLength(1)
    expect(history[0]).toBe(entry)
    expect(entry).toMatchObject({ description: "Opened 3 tabs.", status: "active", revert: [{ kind: "close_tabs", tabIds: [1, 2, 3] }] })
    expect(entry.id).toEqual(expect.any(String))
  })
})

describe("markBrowserUndone / findBrowserUndoEntry", () => {
  it("flips only the matching entry's status", () => {
    const { history: h1, entry: e1 } = pushBrowserUndoEntry([], { description: "A", revert: [{ kind: "close_tabs", tabIds: [1] }] })
    const { history: h2, entry: e2 } = pushBrowserUndoEntry(h1, { description: "B", revert: [{ kind: "close_tabs", tabIds: [2] }] })

    const next = markBrowserUndone(h2, e1.id)

    expect(findBrowserUndoEntry(next, e1.id)?.status).toBe("undone")
    expect(findBrowserUndoEntry(next, e2.id)?.status).toBe("active")
  })

  it("findBrowserUndoEntry returns undefined for an unknown id", () => {
    expect(findBrowserUndoEntry([], "ghost")).toBeUndefined()
  })
})
