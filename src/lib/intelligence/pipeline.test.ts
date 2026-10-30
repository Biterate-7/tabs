import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createActivityCollector, readContextSettings, CONTEXT_SETTINGS_KEY } from "../../../extension/src/context-activity.js"
import { applySmartToSubjects, undoSmartToSubjects } from "@/lib/organize/smart/apply"
import { readActivityPull } from "./bridge"
import { acceptSuggestion, forgetRecords, undoAcceptance } from "./decisions"
import { runInference } from "./engine"
import { __resetContextForTests, CONTEXT_STORAGE_KEY, getContextSnapshot, writeContext } from "./persistence"
import { proposalFromSuggestion } from "./proposal"
import { emptyContextState } from "./state"
import { applyPull, clearContext } from "./sync"
import { project, source } from "./__fixtures__/student-work"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * The whole path, with the extension's real collector and Hubble's real
 * store code: a tab event → the extension's record → a pull → the stored
 * state → inference → a suggestion → accepting it → a source in the right
 * project, undoable; and deleting activity never touches a project.
 */

const NOW = Date.UTC(2026, 9, 28, 15, 0, 0)
const CHAT = "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001"

function extension() {
  const data = new Map<string, unknown>([[CONTEXT_SETTINGS_KEY, readContextSettings({ mode: "auto", readConversations: ["chatgpt"] })]])
  let now = NOW - 60 * 60 * 1000
  let epoch = 0
  const tabs = new Map<number, { id: number; url: string; title: string; incognito: boolean }>()
  const collector = createActivityCollector({
    storage: { get: async (key: string) => structuredClone(data.get(key)), set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)) },
    now: () => now,
    newEpoch: () => `epoch-${++epoch}`,
    hubbleOrigin: "http://localhost:3000",
    hasHostPermission: async (provider: string) => provider === "chatgpt",
    readConversation: async () => ({
      ok: true,
      url: CHAT,
      turns: [
        { role: "user", text: "Is a sugar tax an effective way to correct the negative externality of sugar consumption? Economics IA question." },
        { role: "assistant", text: "A sugar tax raises the price of sugary drinks and reduces consumption; the externality is the health cost. Market failure justifies the indirect tax; elasticity of demand decides how much consumption falls." },
      ],
    }),
    getTab: async (id: number) => tabs.get(id),
    schedule: () => () => {},
    notify: () => {},
    log: () => {},
  })
  const open = async (id: number, url: string, title: string, minutes = 5) => {
    const tab = { id, url, title, incognito: false }
    tabs.set(id, tab)
    await collector.observe(tab, { activated: true })
    now += minutes * 60 * 1000
  }
  return { collector, open, tabs, advance: (ms: number) => (now += ms) }
}

async function pull(chrome: ReturnType<typeof extension>) {
  const cursor = getContextSnapshot().cursor
  const raw = (await chrome.collector.list(cursor ? { since: cursor.seq, epoch: cursor.epoch } : {})) as unknown as Record<string, unknown>
  const answer = readActivityPull({ ...raw, openUrls: [...chrome.tabs.values()].map((tab) => tab.url) })
  expect(answer).toBeDefined()
  writeContext((state) => applyPull(state, answer!))
}

function infer(workspaces: WorkspaceStore["workspaces"]) {
  writeContext((state) => {
    const result = runInference({ state, workspaces, now: NOW, mintId: () => `s-${Math.random().toString(36).slice(2)}` })
    return result.changed ? { ...state, suggestions: result.suggestions } : state
  })
  return getContextSnapshot().suggestions.filter((suggestion) => suggestion.status === "open")
}

beforeEach(() => {
  window.localStorage.clear()
  __resetContextForTests()
})
afterEach(() => __resetContextForTests())

describe("extension activity → project", () => {
  it("detects, suggests the existing project, and saves the pages into it — once", async () => {
    const chrome = extension()
    await chrome.open(1, CHAT, "Sugar tax effectiveness", 20)
    await chrome.collector.maybeReadConversation(chrome.tabs.get(1)!)
    await chrome.open(2, "https://www.economicshelp.org/blog/sugar-tax/", "Sugar taxes and negative externalities - Economics Help")
    // The same page reported again (a reload, another tab): still one record.
    await chrome.open(3, "https://economicshelp.org/blog/sugar-tax?utm_source=x", "Sugar taxes and negative externalities - Economics Help")
    await chrome.open(4, "https://www.khanacademy.org/math/calculus/chain-rule", "Chain rule | Khan Academy")
    await chrome.collector.flush()
    await pull(chrome)

    const state = getContextSnapshot()
    expect(state.records.map((record) => record.key).sort()).toEqual(["conversation:chatgpt:chat:6720a1b2-0000-4000-8000-000000000001", "economicshelp.org/blog/sugar-tax", "khanacademy.org/math/calculus/chain-rule"])
    expect(state.records.find((record) => record.kind === "conversation")).toMatchObject({ capture: { status: "content" }, open: true })

    const econ = project("econ", "Economics IA", [source("https://www.tutor2u.net/economics/reference/market-failure", "Market failure and externalities")])
    const store: WorkspaceStore = { version: 1, currentId: "econ", workspaces: [econ] }
    const [suggestion, ...rest] = infer(store.workspaces)
    expect(rest).toHaveLength(0)
    expect(suggestion).toMatchObject({ kind: "save-to-project", destination: { kind: "project", workspaceId: "econ" } })
    expect(suggestion!.recordKeys).not.toContain("khanacademy.org/math/calculus/chain-rule")

    // A second pull and run with nothing new changes nothing.
    await pull(chrome)
    expect(infer(store.workspaces).map((entry) => entry.id)).toEqual([suggestion!.id])

    // Accept, as the shell does: through Smart Organize's apply, then the decision.
    const proposal = proposalFromSuggestion(suggestion!, getContextSnapshot().records, { recordKeys: suggestion!.recordKeys, destination: { kind: "project", workspaceId: "econ" } })!
    const applied = applySmartToSubjects(store, proposal, { now: NOW, subjectsStarted: true, origin: "extension" })
    expect(applied.results[0]).toMatchObject({ targetId: "econ", added: suggestion!.recordKeys.length })
    const conversation = applied.store.workspaces[0]!.tabs.find((tab) => tab.resource?.kind === "conversation")
    // Saved as a link until its text arrives through Save to Hubble's job: never claimed as read.
    expect(conversation?.resource).toMatchObject({ origin: "extension", status: "pending" })
    writeContext((current) => acceptSuggestion(current, suggestion!.id, { recordKeys: suggestion!.recordKeys, workspaceId: "econ", now: NOW }))
    const afterAccept = infer(applied.store.workspaces)
    // Never offered again for what was just saved…
    expect(afterAccept.flatMap((entry) => entry.recordKeys).some((key) => suggestion!.recordKeys.includes(key))).toBe(false)
    // …and the saved conversation is now evidence for the project: what shares its topic follows it there.
    expect(afterAccept.every((entry) => entry.destination.kind === "project" && entry.destination.workspaceId === "econ")).toBe(true)
    expect(afterAccept.flatMap((entry) => entry.recordKeys)).not.toContain("khanacademy.org/math/calculus/chain-rule")

    // Undo: the sources go, the decision goes, and it is not offered again at once.
    const undone = undoSmartToSubjects(applied.store, applied.receipt, { protect: new Set() })
    expect(undone.store.workspaces[0]!.tabs).toHaveLength(1)
    writeContext((current) => undoAcceptance(current, suggestion!.id, NOW + 1000))
    expect(getContextSnapshot().associations).toHaveLength(0)
    const after = infer(undone.store.workspaces)
    expect(after.flatMap((entry) => entry.recordKeys).some((key) => suggestion!.recordKeys.includes(key))).toBe(false)
  })

  it("creates a new project for a coherent body of work when none exists", async () => {
    const chrome = extension()
    await chrome.open(1, CHAT, "Sugar tax effectiveness", 20)
    await chrome.collector.maybeReadConversation(chrome.tabs.get(1)!)
    await chrome.open(2, "https://www.economicshelp.org/blog/sugar-tax/", "Sugar taxes and negative externalities - Economics Help")
    await chrome.open(3, "https://www.tutor2u.net/economics/reference/indirect-taxes", "Indirect taxes and market failure | tutor2u")
    await chrome.open(4, "https://ifs.org.uk/sugar-tax", "The sugar tax: soft drinks levy and consumption")
    await chrome.collector.flush()
    await pull(chrome)
    const [suggestion] = infer([])
    expect(suggestion).toMatchObject({ kind: "create-project", destination: { kind: "new-project" } })
    const store: WorkspaceStore = { version: 1, currentId: "home", workspaces: [project("home", "Untitled project")] }
    const proposal = proposalFromSuggestion(suggestion!, getContextSnapshot().records, { recordKeys: suggestion!.recordKeys, destination: { kind: "new-project", name: "Economics IA" } })!
    const applied = applySmartToSubjects(store, proposal, { now: NOW, subjectsStarted: true, origin: "extension" })
    const created = applied.store.workspaces.find((workspace) => workspace.name === "Economics IA")
    expect(created?.tabs).toHaveLength(suggestion!.recordKeys.length)
    // Applying the same thing again finds the project by name instead of making a second one.
    const again = applySmartToSubjects(applied.store, proposal, { now: NOW, subjectsStarted: true, origin: "extension" })
    expect(again.store.workspaces.filter((workspace) => workspace.name === "Economics IA")).toHaveLength(1)
    expect(again.results[0]).toMatchObject({ added: 0, alreadyThere: suggestion!.recordKeys.length })
  })

  it("recovers from a cleared or reinstalled extension: a new epoch replaces the pages, decisions stay", async () => {
    const chrome = extension()
    await chrome.open(1, "https://www.economicshelp.org/blog/sugar-tax/", "Sugar taxes")
    await chrome.collector.flush()
    await pull(chrome)
    writeContext((state) => ({ ...state, rejections: [{ key: "economicshelp.org/blog/sugar-tax", target: "any", at: NOW }] }))
    await chrome.collector.clear()
    await pull(chrome)
    const state = getContextSnapshot()
    expect(state.records).toHaveLength(0)
    expect(state.cursor?.epoch).toBe("epoch-2")
    expect(state.rejections).toHaveLength(1)
  })

  it("follows a page the extension removed", async () => {
    const chrome = extension()
    await chrome.open(1, "https://arxiv.org/abs/1", "One")
    await chrome.open(2, "https://arxiv.org/abs/2", "Two")
    await chrome.collector.flush()
    await pull(chrome)
    await chrome.collector.forget(["arxiv.org/abs/1"])
    await pull(chrome)
    expect(getContextSnapshot().records.map((record) => record.key)).toEqual(["arxiv.org/abs/2"])
  })
})

describe("deleting activity never deletes project data", () => {
  it("forget and clear change only context state", () => {
    const store: WorkspaceStore = { version: 1, currentId: "econ", workspaces: [project("econ", "Economics IA", [source("https://www.economicshelp.org/blog/sugar-tax/", "Sugar taxes")])] }
    window.localStorage.setItem("tabdump:workspaces:v1", JSON.stringify(store))
    const sessions = JSON.stringify({ version: 1, sessions: [] })
    window.localStorage.setItem("tabdump:tab-sessions:v1", sessions)
    writeContext(() => ({
      ...emptyContextState(),
      associations: [{ key: "economicshelp.org/blog/sugar-tax", workspaceId: "econ", at: NOW, by: "accepted" }],
    }))
    writeContext((state) => forgetRecords(state, ["economicshelp.org/blog/sugar-tax"], NOW))
    writeContext(clearContext)
    expect(JSON.parse(window.localStorage.getItem("tabdump:workspaces:v1")!)).toEqual(store)
    expect(window.localStorage.getItem("tabdump:tab-sessions:v1")).toBe(sessions)
    expect(getContextSnapshot().associations).toHaveLength(0)
  })
})

describe("storage and migration", () => {
  it("starts empty when nothing was stored (the previous schema had no context state)", () => {
    expect(getContextSnapshot()).toEqual(emptyContextState())
  })

  it("keeps unreadable data aside once before replacing it", () => {
    window.localStorage.setItem(CONTEXT_STORAGE_KEY, "{not json")
    __resetContextForTests()
    expect(writeContext((state) => ({ ...state, preference: "strong" })).ok).toBe(true)
    expect(window.localStorage.getItem(`${CONTEXT_STORAGE_KEY}:unreadable-backup`)).toBe("{not json")
    expect(getContextSnapshot().preference).toBe("strong")
  })

  it("never overwrites data written by a newer Hubble", () => {
    window.localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify({ version: 2, records: [], preference: "off" }))
    __resetContextForTests()
    expect(writeContext((state) => ({ ...state, preference: "all" }))).toEqual({ ok: false, error: "read-only" })
    expect(JSON.parse(window.localStorage.getItem(CONTEXT_STORAGE_KEY)!).version).toBe(2)
  })

  it("drops malformed suggestions and records on read", () => {
    window.localStorage.setItem(
      CONTEXT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        records: [{ url: "https://mail.google.com/x", firstSeenAt: 1, lastSeenAt: 2 }, { url: "https://arxiv.org/abs/1", title: "Ok", firstSeenAt: 1, lastSeenAt: 2 }],
        suggestions: [{ id: "bad id!", kind: "save-to-project" }],
        associations: [{ key: "k", workspaceId: "w", at: 1 }],
      })
    )
    __resetContextForTests()
    const state = getContextSnapshot()
    expect(state.records.map((record) => record.key)).toEqual(["arxiv.org/abs/1"])
    expect(state.suggestions).toEqual([])
    expect(state.associations).toHaveLength(1)
  })
})
