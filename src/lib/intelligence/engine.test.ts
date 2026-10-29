import { describe, expect, it } from "vitest"
import { acceptSuggestion, dismissSuggestion, undoAcceptance } from "./decisions"
import { runInference } from "./engine"
import { explanationFor, headlineFor } from "./explain"
import { emptyContextState } from "./state"
import { DAY, HOUR, NOW, economicsArticles, economicsChat, economicsDraft, genericPages, mathsChat, mathsPages, page, personalChat, project, source } from "./__fixtures__/student-work"
import type { ActivityRecord, ContextState } from "./types"
import type { Workspace } from "@/lib/workspace/types"

let counter = 0
const mintId = () => `s-${++counter}`

function run(records: ActivityRecord[], workspaces: Workspace[], state: Partial<ContextState> = {}, now = NOW) {
  const base = { ...emptyContextState(), ...state, records }
  const result = runInference({ state: base, workspaces, now, mintId })
  return { ...result, state: { ...base, suggestions: result.suggestions }, open: result.suggestions.filter((suggestion) => suggestion.status === "open") }
}

const economicsProject = () =>
  project("econ", "Economics IA", [
    source("https://www.economicsonline.co.uk/market-failure/externalities", "Externalities and market failure"),
    source("https://ifs.org.uk/sugar-tax-report", "The soft drinks industry levy: sugar tax report"),
  ])

describe("Case A — one Economics IA, no project yet", () => {
  it("proposes one new project holding the conversation, the articles and the draft", () => {
    const { open } = run([economicsChat, ...economicsArticles, economicsDraft], [])
    expect(open).toHaveLength(1)
    const [suggestion] = open
    expect(suggestion!.kind).toBe("create-project")
    expect(suggestion!.recordKeys).toHaveLength(5)
    expect(suggestion!.evidence.sharedTerms.map((term) => term.toLowerCase())).toEqual(expect.arrayContaining(["sugar", "tax"]))
    expect(suggestion!.destination).toEqual({ kind: "new-project", name: expect.stringMatching(/sugar/i) })
    expect(suggestion!.band).toBe("strong")
  })

  it("explains itself with the words the pages share, and nothing else", () => {
    const { open } = run([economicsChat, ...economicsArticles, economicsDraft], [])
    const text = explanationFor(open[0]!, undefined, 5)
    expect(text).toMatch(/“sugar”/i)
    expect(text).toMatch(/titles and text/i)
    expect(headlineFor(open[0]!, [economicsChat, ...economicsArticles], undefined)).toMatch(/^Start a project for “Sugar/i)
  })
})

describe("Case B — two assignments at once", () => {
  it("keeps the Maths homework apart from the Economics IA despite the same hour", () => {
    const { open } = run([economicsChat, mathsChat, ...economicsArticles, ...mathsPages, economicsDraft], [])
    const economics = open.find((suggestion) => suggestion.recordKeys.includes(economicsChat.key))
    const maths = open.find((suggestion) => suggestion.recordKeys.includes(mathsChat.key))
    expect(economics).toBeDefined()
    expect(economics!.recordKeys).not.toContain(mathsChat.key)
    for (const pageRecord of mathsPages) expect(economics!.recordKeys).not.toContain(pageRecord.key)
    if (maths) {
      for (const pageRecord of [economicsChat, ...economicsArticles, economicsDraft]) expect(maths.recordKeys).not.toContain(pageRecord.key)
    }
  })

  it("matches each to its own existing project", () => {
    const maths = project("maths", "Maths homework", [source("https://www.mathsisfun.com/calculus/derivatives-introduction.html", "Introduction to derivatives"), source("https://www.mathsisfun.com/calculus/chain-rule.html", "The chain rule")])
    const { open } = run([economicsChat, mathsChat, ...mathsPages], [economicsProject(), maths])
    const forEcon = open.find((suggestion) => suggestion.destination.kind === "project" && suggestion.destination.workspaceId === "econ")
    const forMaths = open.find((suggestion) => suggestion.destination.kind === "project" && suggestion.destination.workspaceId === "maths")
    expect(forEcon?.recordKeys).toEqual([economicsChat.key])
    expect(forMaths?.recordKeys).toEqual(expect.arrayContaining([mathsChat.key]))
    expect(forMaths?.recordKeys).not.toContain(economicsChat.key)
  })
})

describe("Case C — a personal conversation", () => {
  it("is never associated with an academic project", () => {
    const { open, matches } = run([personalChat], [economicsProject()])
    expect(open).toHaveLength(0)
    expect(matches.get(personalChat.key) ?? []).toHaveLength(0)
  })
})

describe("Case D — the project already exists", () => {
  it("recommends adding to Economics IA rather than creating a duplicate project", () => {
    const related = page({ url: "https://www.bbc.co.uk/news/health-43456120", title: "Sugar tax: soft drinks levy and childhood obesity" })
    const { open } = run([economicsChat, related], [economicsProject()])
    expect(open).toHaveLength(1)
    expect(open[0]!.kind).toBe("save-to-project")
    expect(open[0]!.destination).toEqual({ kind: "project", workspaceId: "econ" })
    expect(open[0]!.recordKeys).toEqual(expect.arrayContaining([economicsChat.key, related.key]))
    expect(open.some((suggestion) => suggestion.kind === "create-project")).toBe(false)
  })

  it("says it shares words with the project by name", () => {
    const { open } = run([economicsChat], [economicsProject()])
    expect(headlineFor(open[0]!, [economicsChat], "Economics IA")).toBe("Save this conversation to Economics IA?")
    expect(explanationFor(open[0]!, "Economics IA", 1)).toMatch(/Economics IA/)
  })

  it("never suggests a page that is already in a project", () => {
    const econ = economicsProject()
    econ.tabs.push(source(economicsArticles[0]!.url, economicsArticles[0]!.title))
    const { open } = run([economicsArticles[0]!], [econ])
    expect(open).toHaveLength(0)
  })
})

describe("Case E — not enough evidence", () => {
  it("groups nothing from generic pages", () => {
    const { open } = run(genericPages, [economicsProject()])
    expect(open).toHaveLength(0)
  })

  it("ignores a page glanced at for a moment", () => {
    const glance = page({ url: "https://www.economicshelp.org/blog/tax-incidence/", title: "Sugar tax incidence explained", dwellMs: 2000 })
    const { open } = run([glance], [economicsProject()])
    expect(open).toHaveLength(0)
  })
})

describe("Case F — a rejected suggestion", () => {
  it("does not come back, and similar pages are trusted less for that project", () => {
    const first = run([economicsChat], [economicsProject()])
    const id = first.open[0]!.id
    const rejected = dismissSuggestion(first.state, id, "wrong-project", NOW)
    const again = run(rejected.records, [economicsProject()], rejected, NOW + HOUR)
    expect(again.open).toHaveLength(0)
    expect(rejected.rejections).toEqual([expect.objectContaining({ key: economicsChat.key, target: "econ", terms: expect.any(Array) })])
  })

  it("not now: quiet for the snooze period, then it may be offered again", () => {
    const first = run([economicsChat], [economicsProject()])
    const snoozed = dismissSuggestion(first.state, first.open[0]!.id, "not-now", NOW)
    expect(run(snoozed.records, [economicsProject()], snoozed, NOW + DAY).open).toHaveLength(0)
    const later = run(snoozed.records.map((record) => ({ ...record, lastSeenAt: NOW + 4 * DAY })), [economicsProject()], snoozed, NOW + 4 * DAY)
    expect(later.open).toHaveLength(1)
  })

  it("not relevant: never suggested again, for any project", () => {
    const first = run([personalChat, economicsChat], [economicsProject()])
    const target = first.open.find((suggestion) => suggestion.recordKeys.includes(economicsChat.key))!
    const dismissed = dismissSuggestion(first.state, target.id, "not-relevant", NOW)
    const other = project("other", "Sugar tax research")
    expect(run(dismissed.records, [economicsProject(), other], dismissed, NOW + HOUR).open).toHaveLength(0)
  })
})

describe("Case G — content could not be read", () => {
  it("still matches on what is known, and says the text was not used", () => {
    const unread = page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000009", title: "Sugar tax and negative externalities" })
    expect(unread.capture.status).toBe("metadata")
    const { open } = run([unread], [economicsProject()])
    expect(open).toHaveLength(1)
    expect(open[0]!.evidence.fromContent).toBe(false)
    expect(explanationFor(open[0]!, "Economics IA", 1)).toMatch(/^Its title/)
  })
})

describe("Case H — the same assignment over several days", () => {
  it("associates new pages from later days with the project", () => {
    const tuesday = page({ url: "https://www.tutor2u.net/economics/reference/sugar-tax-evaluation", title: "Evaluating the sugar tax | tutor2u", at: NOW - 2 * DAY, alsoDaysAgo: [1] })
    const today = page({ url: "https://ourworldindata.org/obesity", title: "Sugar tax and soft drink consumption - Our World in Data", at: NOW - HOUR })
    const { open } = run([tuesday, today], [economicsProject()])
    expect(open).toHaveLength(1)
    expect(open[0]!.recordKeys).toEqual(expect.arrayContaining([tuesday.key, today.key]))
    expect(open[0]!.evidence.days).toBeGreaterThanOrEqual(2)
  })
})

describe("Case I — duplicate events", () => {
  it("one page reported many times is one record and one suggestion, re-run after re-run", () => {
    const copies = [economicsChat, { ...economicsChat, lastSeenAt: economicsChat.lastSeenAt + 1000 }, { ...economicsChat, url: `${economicsChat.url}?model=gpt-4o` }]
    const first = run(copies, [economicsProject()])
    expect(first.open).toHaveLength(1)
    expect(first.open[0]!.recordKeys).toEqual([economicsChat.key])
    const second = runInference({ state: first.state, workspaces: [economicsProject()], now: NOW + 60_000, mintId })
    expect(second.changed).toBe(false)
    expect(second.suggestions).toBe(first.state.suggestions)
  })

  it("new pages for the same project join its open suggestion instead of making another", () => {
    const first = run([economicsChat], [economicsProject()])
    const more = page({ url: "https://www.economicshelp.org/blog/sugar-tax-uk/", title: "UK sugar tax and externalities" })
    const second = run([economicsChat, more], [economicsProject()], first.state, NOW + HOUR)
    expect(second.open).toHaveLength(1)
    expect(second.open[0]!.id).toBe(first.open[0]!.id)
    expect(second.open[0]!.recordKeys).toEqual(expect.arrayContaining([economicsChat.key, more.key]))
  })
})

describe("confirmed decisions win", () => {
  it("an accepted page is never suggested again, and nothing inferred moves it", () => {
    const first = run([economicsChat], [economicsProject()])
    const accepted = acceptSuggestion(first.state, first.open[0]!.id, { recordKeys: [economicsChat.key], workspaceId: "econ", now: NOW })
    expect(accepted.associations).toEqual([expect.objectContaining({ key: economicsChat.key, workspaceId: "econ", by: "accepted" })])
    const other = project("other", "Sugar tax and obesity research")
    expect(run(accepted.records, [economicsProject(), other], accepted, NOW + HOUR).open).toHaveLength(0)
  })

  it("choosing another project records the correction for the suggested one", () => {
    const first = run([economicsChat], [economicsProject()])
    const moved = acceptSuggestion(first.state, first.open[0]!.id, { recordKeys: [economicsChat.key], workspaceId: "other", now: NOW })
    expect(moved.associations[0]).toMatchObject({ workspaceId: "other", by: "moved" })
    expect(moved.rejections).toEqual([expect.objectContaining({ key: economicsChat.key, target: "econ" })])
  })

  it("a page taken out in review is a correction for that destination", () => {
    const related = page({ url: "https://www.bbc.co.uk/news/health-43456120", title: "Sugar tax: soft drinks levy and childhood obesity" })
    const first = run([economicsChat, related], [economicsProject()])
    const accepted = acceptSuggestion(first.state, first.open[0]!.id, { recordKeys: [economicsChat.key], workspaceId: "econ", now: NOW })
    expect(accepted.rejections).toEqual([expect.objectContaining({ key: related.key, target: "econ" })])
    expect(accepted.suggestions[0]!.recordKeys).toEqual([economicsChat.key])
  })

  it("undo removes the associations and puts the suggestion away for a while", () => {
    const first = run([economicsChat], [economicsProject()])
    const accepted = acceptSuggestion(first.state, first.open[0]!.id, { recordKeys: [economicsChat.key], workspaceId: "econ", now: NOW })
    const undone = undoAcceptance(accepted, first.open[0]!.id, NOW + 1000)
    expect(undone.associations).toHaveLength(0)
    expect(undone.suggestions[0]!.status).toBe("snoozed")
  })
})

describe("lifecycle", () => {
  it("expires an open suggestion nobody acted on", () => {
    const first = run([economicsChat], [economicsProject()])
    const later = runInference({ state: first.state, workspaces: [economicsProject()], now: NOW + 8 * DAY, mintId })
    expect(later.suggestions.find((suggestion) => suggestion.id === first.open[0]!.id)?.status).toBe("expired")
  })

  it("expires a suggestion whose project was deleted", () => {
    const first = run([economicsChat], [economicsProject()])
    const later = runInference({ state: first.state, workspaces: [], now: NOW + HOUR, mintId })
    expect(later.suggestions[0]!.status).toBe("expired")
  })

  it("the strong-only preference holds back review-band suggestions; off suggests nothing", () => {
    const weak = page({ url: "https://www.economicshelp.org/blog/indirect-tax/", title: "Indirect tax revenue" })
    const base = { ...emptyContextState(), records: [weak] }
    const all = runInference({ state: base, workspaces: [economicsProject()], now: NOW, mintId })
    const strong = runInference({ state: base, workspaces: [economicsProject()], now: NOW, mintId, preference: "strong" })
    const off = runInference({ state: base, workspaces: [economicsProject()], now: NOW, mintId, preference: "off" })
    const reviewOnly = all.suggestions.filter((suggestion) => suggestion.band === "review")
    if (reviewOnly.length > 0) expect(strong.suggestions.filter((suggestion) => suggestion.band === "review")).toHaveLength(0)
    expect(off.suggestions.filter((suggestion) => suggestion.status === "open")).toHaveLength(0)
  })

  it("keeps the number of open suggestions bounded", () => {
    const pages = Array.from({ length: 30 }, (_, index) =>
      page({ url: `https://topic${index}.example.org/a`, title: `Topic${index}alpha topic${index}beta topic${index}gamma`, terms: [`topic${String.fromCharCode(97 + (index % 26))}alpha`] })
    )
    const { open } = run(pages, [])
    expect(open.length).toBeLessThanOrEqual(8)
  })
})
