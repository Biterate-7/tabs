import { afterEach, describe, expect, it } from "vitest"
import { forgetLegacyProjectEvents, forgetProjectActivity, legacyProjectEvents, parseProjectActivity, projectActivitySnapshot, projectEventsIn, recordProjectEvent, MAX_EVENTS_PER_PROJECT } from "./activity"
import { scopedKey, setStorageNamespace } from "@/lib/storage/namespace"

afterEach(() => {
  localStorage.clear()
  setStorageNamespace(null)
})

describe("project activity", () => {
  it("records what happened, per project, newest first — counts and ids, never titles or addresses", () => {
    recordProjectEvent({ workspaceId: "w", kind: "project_created", at: 1 })
    recordProjectEvent({ workspaceId: "w", kind: "sources_added", count: 3, origin: "chrome", at: 2 })
    recordProjectEvent({ workspaceId: "other", kind: "sources_added", count: 9, origin: "extension", at: 3 })
    const events = projectEventsIn(projectActivitySnapshot(), "w")
    expect(events.map((event) => event.kind)).toEqual(["sources_added", "project_created"])
    expect(JSON.stringify(events)).not.toMatch(/https?:/)
  })

  it("records saved conversations with the AI app they came from", () => {
    recordProjectEvent({ workspaceId: "w", kind: "conversation_saved", count: 2, provider: "claude", at: 5 })
    expect(projectEventsIn(projectActivitySnapshot(), "w")[0]).toMatchObject({ kind: "conversation_saved", count: 2, provider: "claude" })
  })

  it("keeps the removed agent features' records on every write, hides them, and deletes them only when asked", () => {
    const legacy = { id: "old", workspaceId: "w", kind: "task", at: 1, provider: "claude-code", sessionId: "s1", state: "done", headline: "Analyzed 8 sources" }
    localStorage.setItem(scopedKey("tabdump:project-activity:v1"), JSON.stringify({ version: 1, events: [legacy] }))
    recordProjectEvent({ workspaceId: "w", kind: "note_added", at: 2 })
    // Still there after a write — an upgrade destroys nobody's history…
    expect(legacyProjectEvents()).toEqual([expect.objectContaining({ id: "old", kind: "task", headline: "Analyzed 8 sources" })])
    // …but never shown.
    expect(projectEventsIn(projectActivitySnapshot(), "w").map((event) => event.kind)).toEqual(["note_added"])
    expect(forgetLegacyProjectEvents()).toBe(1)
    expect(legacyProjectEvents()).toEqual([])
    expect(projectEventsIn(projectActivitySnapshot(), "w")).toHaveLength(1)
  })

  it("is bounded per project, so one busy project never pushes another's history out", () => {
    for (let index = 0; index < MAX_EVENTS_PER_PROJECT + 20; index++) recordProjectEvent({ workspaceId: "busy", kind: "source_ready", tabId: `t${index}`, at: index + 10 })
    recordProjectEvent({ workspaceId: "quiet", kind: "project_created", at: 1 })
    expect(projectEventsIn(projectActivitySnapshot(), "busy")).toHaveLength(MAX_EVENTS_PER_PROJECT)
    expect(projectEventsIn(projectActivitySnapshot(), "quiet")).toHaveLength(1)
  })

  it("is partitioned by account and forgotten with its project", () => {
    recordProjectEvent({ workspaceId: "w", kind: "project_created", at: 1 })
    setStorageNamespace("someone-else")
    expect(projectEventsIn(projectActivitySnapshot(), "w")).toEqual([])
    setStorageNamespace(null)
    forgetProjectActivity("w")
    expect(projectEventsIn(projectActivitySnapshot(), "w")).toEqual([])
  })

  it("reads stored garbage as nothing", () => {
    expect(parseProjectActivity("{nope")).toEqual([])
    expect(parseProjectActivity(JSON.stringify({ version: 1, events: [{ id: "x", workspaceId: "w", kind: "explode", at: 1 }] }))).toEqual([])
  })
})
