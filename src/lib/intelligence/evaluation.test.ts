import { writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { acceptSuggestion, dismissSuggestion } from "./decisions"
import { runInference } from "./engine"
import { upsertRecords } from "./records"
import { emptyContextState } from "./state"
import { DAY, HOUR, NOW, page, project, source } from "./__fixtures__/student-work"
import type { ActivityRecord, ContextState, Suggestion } from "./types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * A labelled evaluation set: hard cases from real student work, each page
 * labelled with where it belongs — a project id, NEW (a new body of work), or
 * NONE (it should never be suggested). The engine's open suggestions are
 * scored against the labels:
 *
 *   correct          suggested for the labelled project (or as a new project, for NEW)
 *   false positive   suggested anywhere for a NONE page, or for the wrong project
 *   missed           a labelled page with no suggestion (an interruption avoided, at a cost)
 *
 * This measures behaviour on fixtures written for it — not accuracy on real
 * work. The numbers are written to $EVAL_OUT when set (see docs).
 */

const NEW = "NEW"
const NONE = "NONE"
type Label = string

type Case = {
  name: string
  records: ActivityRecord[]
  labels: Record<string, Label>
  workspaces: Workspace[]
  state?: Partial<ContextState>
  /** Labels that may go either way: either project is correct. */
  either?: Record<string, Label[]>
}

let n = 0
const mintId = () => `e-${++n}`

const econ = () =>
  project("econ", "Economics IA", [
    source("https://www.tutor2u.net/economics/reference/market-failure", "Market failure and negative externalities"),
    source("https://www.economicshelp.org/blog/sugar-tax/", "Sugar tax and negative externalities"),
  ])
const maths = () =>
  project("maths", "Maths homework", [source("https://www.mathsisfun.com/calculus/derivatives-introduction.html", "Introduction to derivatives"), source("https://www.mathsisfun.com/calculus/chain-rule.html", "The chain rule")])
const history = () => project("hist", "History essay", [source("https://www.britannica.com/event/Treaty-of-Versailles-1919", "Treaty of Versailles"), source("https://www.history.com/topics/world-war-i/treaty-of-versailles", "Treaty of Versailles: terms and reparations")])
const biology = () => project("bio", "Biology IA", [source("https://www.diabetes.org.uk/about-diabetes/type-2", "Type 2 diabetes and obesity"), source("https://www.who.int/news-room/fact-sheets/detail/obesity", "Obesity and overweight")])

const CASES: Case[] = [
  (() => {
    // Different words for the same thing. The conversation (read, with permission) uses both "levy" and "sugar tax";
    // the article only says "soda levy". Titles alone share nothing; the conversation's text is what connects them.
    const chat = page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-0000000000a1", title: "IA research help", terms: ["sugar", "tax", "levy", "soda", "drinks", "externality", "consumption", "market", "failure", "economics"] })
    const soda = page({ url: "https://www.npr.org/sections/goatsandsoda/mexico-soda-levy", title: "Mexico's soda levy cut purchases of sugary drinks" })
    const plainSoda = page({ url: "https://www.npr.org/sections/health/soda-levy-berkeley", title: "Berkeley soda levy: what happened next" })
    return { name: "different terminology", records: [chat, soda, plainSoda], labels: { [chat.key]: "econ", [soda.key]: "econ", [plainSoda.key]: "econ" }, workspaces: [econ()] }
  })(),
  (() => {
    const generic = project("ia", "IA", [source("https://www.economicshelp.org/blog/sugar-tax/", "Sugar tax and negative externalities"), source("https://ifs.org.uk/sugar-levy", "The soft drinks levy: a sugar tax report")])
    const article = page({ url: "https://www.bbc.co.uk/news/health-sugar-tax-review", title: "Sugar tax: has the soft drinks levy worked?" })
    return { name: "generic project title", records: [article], labels: { [article.key]: "ia" }, workspaces: [generic] }
  })(),
  (() => {
    const e1 = page({ url: "https://www.tutor2u.net/economics/reference/indirect-taxes", title: "Indirect taxes and negative externalities | tutor2u" })
    const e2 = page({ url: "https://www.investopedia.com/terms/s/sin_tax.asp", title: "Sugar tax: sin taxes and externalities" })
    const m1 = page({ url: "https://www.khanacademy.org/math/calculus/chain-rule-intro", title: "Chain rule introduction | Khan Academy" })
    const m2 = page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-0000000000a2", title: "Chain rule derivatives practice", terms: ["derivative", "chain", "rule", "function", "composite"] })
    return { name: "two simultaneous assignments", records: [e1, e2, m1, m2], labels: { [e1.key]: "econ", [e2.key]: "econ", [m1.key]: "maths", [m2.key]: "maths" }, workspaces: [econ(), maths()] }
  })(),
  (() => {
    const read = page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-0000000000a3", title: "Quick question", terms: ["sugar", "tax", "externality", "negative", "consumption", "market", "failure", "economics", "price"] })
    const unread = page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-0000000000a4", title: "Quick question about this" })
    return { name: "conversation title unrelated to its topic", records: [read, unread], labels: { [read.key]: "econ", [unread.key]: NONE }, workspaces: [econ()] }
  })(),
  (() => {
    const pages = [
      page({ url: "https://www.coolgeography.co.uk/holderness-coast", title: "Holderness coast erosion case study" }),
      page({ url: "https://www.bbc.co.uk/bitesize/holderness-management", title: "Managing the Holderness coastline" }),
      page({ url: "https://www.internetgeography.net/longshore-drift-holderness", title: "Longshore drift along Holderness" }),
      page({ url: "https://www.geographypods.com/coastal-defences", title: "Coastal defences: groynes and sea walls on the coast" }),
    ]
    return { name: "weak single evidence, strong together", records: pages, labels: Object.fromEntries(pages.map((record) => [record.key, NEW])), workspaces: [econ()] }
  })(),
  (() => {
    const chat = page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-0000000000a5", title: "Best way to train for a 10k", terms: ["running", "pace", "training", "plan", "weeks", "interval", "recovery"] })
    return { name: "single personal conversation", records: [chat], labels: { [chat.key]: NONE }, workspaces: [econ(), maths(), history()] }
  })(),
  (() => {
    const both = page({ url: "https://www.theguardian.com/society/sugar-obesity-tax", title: "Sugar, obesity and the case for a sugar tax" })
    return { name: "plausibly two projects", records: [both], labels: { [both.key]: "econ" }, either: { [both.key]: ["econ", "bio"] }, workspaces: [econ(), biology()] }
  })(),
  (() => {
    const filed = page({ url: "https://www.economist.com/sugar-tax-history", title: "Sugar tax: a history of taxing sweetness" })
    const state: Partial<ContextState> = { associations: [{ key: filed.key, workspaceId: "hist", at: NOW - DAY, by: "moved" }] }
    return { name: "confirmed association conflicts with inference", records: [filed], labels: { [filed.key]: NONE }, workspaces: [econ(), history()], state }
  })(),
  (() => {
    const rejected = page({ url: "https://www.investopedia.com/sugar-tax-pros-cons", title: "Sugar tax pros and cons" })
    const state: Partial<ContextState> = { rejections: [{ key: rejected.key, target: "econ", at: NOW - HOUR }] }
    return { name: "rejected suggestion", records: [rejected], labels: { [rejected.key]: NONE }, workspaces: [econ()], state }
  })(),
  (() => {
    const monday = page({ url: "https://www.tutor2u.net/economics/reference/sugar-tax-evaluation", title: "Evaluating the sugar tax | tutor2u", at: NOW - 3 * DAY })
    const wednesday = page({ url: "https://ourworldindata.org/sugar-consumption", title: "Sugar tax and sugar consumption - Our World in Data", at: NOW - DAY, alsoDaysAgo: [1] })
    return { name: "project revisited over several days", records: [monday, wednesday], labels: { [monday.key]: "econ", [wednesday.key]: "econ" }, workspaces: [econ()] }
  })(),
  (() => {
    const original = page({ url: "https://www.economist.com/finance/sugar-tax-levy", title: "Sugar tax levy and negative externalities" })
    const tracked = page({ url: "https://economist.com/finance/sugar-tax-levy/?utm_source=twitter&utm_campaign=x#comments", title: "Sugar tax levy and negative externalities" })
    return { name: "duplicates with tracking parameters", records: upsertRecords([], [original, tracked]), labels: { [original.key]: "econ" }, workspaces: [econ()] }
  })(),
  (() => {
    // Both assignments' sources say "IA", "evaluation", "analysis", "essay": the topic must decide, not the genre.
    const econIa = project("econ", "Economics IA", [source("https://www.tutor2u.net/economics/sugar-tax-evaluation", "Sugar tax evaluation for the IA"), source("https://www.economicshelp.org/blog/externality-analysis/", "Analysis of negative externalities essay")])
    const histIa = project("hist", "History IA", [source("https://www.britannica.com/event/Treaty-of-Versailles-1919", "Treaty of Versailles evaluation"), source("https://www.history.com/versailles-analysis", "Analysis of the Treaty of Versailles essay")])
    const versailles = page({ url: "https://www.bbc.co.uk/bitesize/versailles-reparations", title: "Evaluation essay: Versailles reparations and the treaty" })
    const levy = page({ url: "https://www.economist.com/sugar-levy-analysis", title: "Analysis essay: sugar levy and negative externalities" })
    return { name: "two assignments sharing generic academic words", records: [versailles, levy], labels: { [versailles.key]: "hist", [levy.key]: "econ" }, workspaces: [econIa, histIa] }
  })(),
  (() => {
    // A Geography project about London; personal London browsing must not join it.
    const geo = project("geo", "Geography coursework", [source("https://www.rgs.org/london-congestion-charge", "London congestion charge and urban traffic"), source("https://www.tfl.gov.uk/congestion-charge-data", "Congestion charge traffic data")])
    const coffee = page({ url: "https://www.timeout.com/london/best-coffee", title: "Best coffee shops in London" })
    const weather = page({ url: "https://www.metoffice.gov.uk/weather/london", title: "London weather forecast" })
    const study = page({ url: "https://www.lse.ac.uk/congestion-charge-study", title: "Did the London congestion charge reduce traffic?" })
    return { name: "personal pages sharing a city with schoolwork", records: [coffee, weather, study], labels: { [coffee.key]: NONE, [weather.key]: NONE, [study.key]: "geo" }, workspaces: [geo] }
  })(),
  (() => {
    const e = page({ url: "https://www.investopedia.com/sugar-tax-externality", title: "Sugar tax and negative externalities explained" })
    const m = page({ url: "https://www.khanacademy.org/math/chain-rule-review", title: "The chain rule for derivatives" })
    const h = page({ url: "https://www.historyextra.com/versailles-treaty-terms", title: "Treaty of Versailles: the terms and reparations" })
    return { name: "three assignments in one session", records: [e, m, h], labels: { [e.key]: "econ", [m.key]: "maths", [h.key]: "hist" }, workspaces: [econ(), maths(), history()] }
  })(),
  (() => {
    // Two title-only pages that share one word: not enough for a project.
    const a = page({ url: "https://www.example.org/volcano-facts", title: "Volcano facts for kids" })
    const b = page({ url: "https://www.example.net/volcano-pictures", title: "Volcano pictures" })
    return { name: "new project with too little evidence", records: [a, b], labels: { [a.key]: NONE, [b.key]: NONE }, workspaces: [econ()] }
  })(),
  (() => {
    // Weeks old: it was relevant once, it is not "new activity" now.
    const old = page({ url: "https://www.tutor2u.net/economics/sugar-tax-2019", title: "Sugar tax and negative externalities (2019)", at: NOW - 30 * DAY })
    return { name: "stale activity", records: [old], labels: { [old.key]: NONE }, workspaces: [econ()] }
  })(),
  (() => {
    // Personal life sharing a word. Not an assignment, however coherent the word.
    const pages = [
      page({ url: "https://www.timeout.com/london/coffee", title: "Best coffee shops in London" }),
      page({ url: "https://www.metoffice.gov.uk/weather/london", title: "London weather forecast" }),
      page({ url: "https://tfl.gov.uk/maps/tube", title: "London Underground tube map" }),
      page({ url: "https://www.rightmove.co.uk/london-rent", title: "London rent prices this month" }),
    ]
    return { name: "personal pages sharing a place name", records: pages, labels: Object.fromEntries(pages.map((record) => [record.key, NONE])), workspaces: [] }
  })(),
  (() => {
    const pages = [
      page({ url: "https://www.amazon.co.uk/headphones", title: "Wireless headphones deals" }),
      page({ url: "https://www.argos.co.uk/headphones", title: "Headphones | Argos" }),
      page({ url: "https://www.currys.co.uk/headphones", title: "Noise cancelling headphones | Currys" }),
      page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-0000000000a7", title: "Which noise cancelling headphones?", terms: ["headphones", "noise", "cancelling", "battery", "price", "sony", "bose"] }),
    ]
    return { name: "shopping, with an AI chat about it", records: pages, labels: Object.fromEntries(pages.map((record) => [record.key, NONE])), workspaces: [econ()] }
  })(),
  (() => {
    const pages = [
      page({ url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-0000000000a6", title: "ChatGPT" }),
      page({ url: "https://docs.google.com/document/d/1AbCdEf000000000000/edit", title: "Untitled document - Google Docs" }),
      page({ url: "https://gemini.google.com/app/1a2b3c4d5e6f", title: "Gemini" }),
      page({ url: "https://www.google.com/search?q=homework", title: "homework - Google Search" }),
    ]
    return { name: "metadata only, nothing to go on", records: pages, labels: Object.fromEntries(pages.map((record) => [record.key, NONE])), workspaces: [econ(), maths()] }
  })(),
]

type Outcome = { name: string; correct: number; falsePositive: number; missed: number; suggestions: number; details: string[] }

function score(entry: Case): Outcome {
  const result = runInference({ state: { ...emptyContextState(), ...entry.state, records: entry.records }, workspaces: entry.workspaces, now: NOW, mintId })
  const open = result.suggestions.filter((suggestion) => suggestion.status === "open")
  const placed = new Map<string, Suggestion>()
  for (const suggestion of open) for (const key of suggestion.recordKeys) placed.set(key, suggestion)
  const outcome: Outcome = { name: entry.name, correct: 0, falsePositive: 0, missed: 0, suggestions: open.length, details: [] }
  for (const [key, label] of Object.entries(entry.labels)) {
    const suggestion = placed.get(key)
    const got = !suggestion ? NONE : suggestion.destination.kind === "project" ? suggestion.destination.workspaceId : NEW
    const accepted = entry.either?.[key] ?? [label]
    if (label === NONE && got === NONE) continue
    if (got === NONE) {
      outcome.missed += 1
      outcome.details.push(`missed ${key} (expected ${label})`)
    } else if (accepted.includes(got)) {
      outcome.correct += 1
    } else {
      outcome.falsePositive += 1
      outcome.details.push(`false positive ${key}: ${got} (expected ${label})`)
    }
  }
  return outcome
}

describe("evaluation set (fixtures, not real-world accuracy)", () => {
  const outcomes = CASES.map(score)

  it("makes no false-positive suggestion on any hard case", () => {
    expect(outcomes.filter((outcome) => outcome.falsePositive > 0).map((outcome) => [outcome.name, outcome.details])).toEqual([])
  })

  it("interrupts at most once per body of work", () => {
    CASES.forEach((entry, index) => {
      const bodies = new Set(Object.values(entry.labels).filter((label) => label !== NONE)).size
      expect([entry.name, outcomes[index]!.suggestions <= bodies]).toEqual([entry.name, true])
    })
  })

  it("connects the cases where the evidence is in what Hubble holds", () => {
    const byName = new Map(outcomes.map((outcome) => [outcome.name, outcome]))
    for (const name of ["generic project title", "two simultaneous assignments", "conversation title unrelated to its topic", "weak single evidence, strong together", "project revisited over several days", "duplicates with tracking parameters", "plausibly two projects"]) {
      expect([name, byName.get(name)!.missed]).toEqual([name, 0])
    }
  })

  it("never suggests the rejected or the user-filed page, even with more evidence", () => {
    const rejectedCase = CASES.find((entry) => entry.name === "rejected suggestion")!
    const more = page({ url: "https://www.tutor2u.net/economics/sugar-tax-revision", title: "Sugar tax revision notes: externalities" })
    const result = runInference({ state: { ...emptyContextState(), ...rejectedCase.state, records: [...rejectedCase.records, more] }, workspaces: rejectedCase.workspaces, now: NOW, mintId })
    const keys = result.suggestions.filter((suggestion) => suggestion.status === "open").flatMap((suggestion) => suggestion.recordKeys)
    expect(keys).not.toContain(rejectedCase.records[0]!.key)
    // And dismissing what does appear keeps it away too.
    const first = { ...emptyContextState(), records: [more], suggestions: result.suggestions }
    const open = result.suggestions.find((suggestion) => suggestion.status === "open")
    if (open) {
      const dismissed = dismissSuggestion(first, open.id, "wrong-project", NOW)
      const again = runInference({ state: dismissed, workspaces: rejectedCase.workspaces, now: NOW + HOUR, mintId })
      expect(again.suggestions.filter((suggestion) => suggestion.status === "open")).toHaveLength(0)
    }
  })

  it("an accepted page never comes back, whatever new evidence arrives", () => {
    const entry = CASES.find((item) => item.name === "project revisited over several days")!
    const result = runInference({ state: { ...emptyContextState(), records: entry.records }, workspaces: entry.workspaces, now: NOW, mintId })
    const open = result.suggestions.find((suggestion) => suggestion.status === "open")!
    const accepted = acceptSuggestion({ ...emptyContextState(), records: entry.records, suggestions: result.suggestions }, open.id, { recordKeys: open.recordKeys, workspaceId: "econ", now: NOW })
    const later = runInference({ state: accepted, workspaces: [...entry.workspaces, biology()], now: NOW + DAY, mintId })
    expect(later.suggestions.filter((suggestion) => suggestion.status === "open")).toHaveLength(0)
  })

  it("reports the numbers", () => {
    const total = outcomes.reduce((sum, outcome) => ({ correct: sum.correct + outcome.correct, falsePositive: sum.falsePositive + outcome.falsePositive, missed: sum.missed + outcome.missed, suggestions: sum.suggestions + outcome.suggestions }), { correct: 0, falsePositive: 0, missed: 0, suggestions: 0 })
    const precision = total.correct + total.falsePositive > 0 ? total.correct / (total.correct + total.falsePositive) : 1
    const negatives = CASES.reduce((sum, entry) => sum + Object.values(entry.labels).filter((label) => label === NONE).length, 0)
    const positives = CASES.reduce((sum, entry) => sum + Object.values(entry.labels).filter((label) => label !== NONE).length, 0)
    const report = { cases: outcomes, total, precision, recall: total.correct / positives, labelledPositive: positives, labelledNone: negatives }
    if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, JSON.stringify(report, null, 1))
    expect(precision).toBe(1)
  })
})
