import { describe, expect, it } from "vitest"
import { projectPulses } from "@/lib/product/continuity"
import { describeSummary, dismissResume, makeCheckpoint, recommendResume, RESUME_COOLDOWN_MS, summarizeProject, upsertCheckpoint } from "./resume"
import { withoutOpen } from "./restore"
import { emptyContextState } from "./state"
import { DAY, HOUR, NOW, project, source } from "./__fixtures__/student-work"
import type { Suggestion } from "./types"
import type { TabSession } from "@/lib/sessions/types"

const conversationLink = {
  ...source("https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001", "Sugar tax effectiveness"),
  resource: { kind: "conversation" as const, origin: "extension" as const, status: "partial" as const, addedAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY, error: { code: "needs_capture" as const, message: "", retryable: false } },
}

function econ() {
  return project("econ", "Economics IA", [source("https://www.tutor2u.net/economics/tax", "Indirect taxes"), conversationLink], NOW - 2 * DAY)
}

const session: TabSession = { id: "sess", name: "IA writing", tabs: [{ id: "t", url: "https://docs.google.com/document/d/x/edit", title: "Draft" }], createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY, workspaceId: "econ", revision: 0 }

const pulses = (sessions: TabSession[] = []) => projectPulses({ workspaces: [econ()], sessions, events: [] })

describe("recommendResume", () => {
  it("offers the last project when the person comes back after being away", () => {
    const recommendation = recommendResume({ pulses: pulses([session]), state: emptyContextState(), now: NOW, returningFrom: NOW - 3 * HOUR })
    expect(recommendation).toMatchObject({ workspaceId: "econ", reason: "returning", sessionId: "sess", waiting: 0 })
  })

  it("is not a generic prompt on every launch: nothing when the person never left and nothing new is waiting", () => {
    expect(recommendResume({ pulses: pulses(), state: emptyContextState(), now: NOW })).toBeUndefined()
  })

  it("offers it when new pages that fit the project are waiting", () => {
    const waiting = { status: "open", destination: { kind: "project", workspaceId: "econ" } } as Suggestion
    expect(recommendResume({ pulses: pulses(), state: { ...emptyContextState(), suggestions: [waiting] }, now: NOW })).toMatchObject({ reason: "new-related", waiting: 1 })
  })

  it("respects not now, and a resume that just happened", () => {
    const base = emptyContextState()
    expect(recommendResume({ pulses: pulses(), state: dismissResume(base, "econ", NOW - HOUR), now: NOW, returningFrom: NOW - 3 * HOUR })).toBeUndefined()
    const resumed = upsertCheckpoint(base, makeCheckpoint(pulses()[0]!, NOW - RESUME_COOLDOWN_MS / 2))
    expect(recommendResume({ pulses: pulses(), state: resumed, now: NOW, returningFrom: NOW - 3 * HOUR })).toBeUndefined()
  })

  it("never offers a project untouched for weeks", () => {
    const old = projectPulses({ workspaces: [project("old", "Old essay", [{ ...source("https://example.org/a", "A"), createdAt: NOW - 40 * DAY, resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: NOW - 40 * DAY, updatedAt: NOW - 40 * DAY } }], NOW - 40 * DAY)], sessions: [], events: [] })
    expect(recommendResume({ pulses: old, state: emptyContextState(), now: NOW, returningFrom: NOW - 3 * HOUR })).toBeUndefined()
  })

  it("counts what is new since the last checkpoint", () => {
    const before = project("econ", "Economics IA", [source("https://www.tutor2u.net/economics/tax", "Indirect taxes")], NOW - 3 * DAY)
    const checkpoint = makeCheckpoint(projectPulses({ workspaces: [before], sessions: [], events: [] })[0]!, NOW - DAY)
    const recommendation = recommendResume({ pulses: pulses(), state: upsertCheckpoint(emptyContextState(), checkpoint), now: NOW, returningFrom: NOW - 3 * HOUR })
    expect(recommendation?.newSinceCheckpoint).toBe(1)
  })
})

describe("the summary", () => {
  it("is built from kinds and titles, and names only gaps the data shows", () => {
    const summary = summarizeProject(pulses()[0]!)
    expect(summary).toMatchObject({ basis: "metadata", linkOnlyConversations: 1, counts: { conversation: 1, source: 1 } })
    const words = describeSummary(summary)
    expect(words.counts).toBe("1 AI conversation · 1 source")
    expect(words.gaps).toEqual(["1 conversation is saved as a link only — save it from the page to keep the text"])
  })
})

describe("reopening tabs", () => {
  it("skips tabs already open and duplicates, by source identity", () => {
    const tabs = [{ url: "https://www.example.org/a?utm_source=x" }, { url: "https://example.org/b" }, { url: "https://example.org/b/" }, { url: "not a url" }]
    expect(withoutOpen(tabs, [{ url: "https://example.org/a" }])).toEqual([{ url: "https://example.org/b" }])
  })
})
