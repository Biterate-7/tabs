import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useExtensionMemory } from "./use-extension-memory"
import type { ExtensionMemoryHandlers } from "./use-extension-memory"
import { BROWSER_MESSAGE_SOURCE } from "@/lib/browser/protocol"
import { applyConversationSave, planConversationSave } from "@/lib/conversations/save"
import { MSG_PAGE_REQUEST, MSG_PAGE_RESPONSE } from "@/lib/memory/extension-protocol"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import { __resetSessionsForTests, getSessionsSnapshot } from "@/lib/sessions/persistence"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * The page's side of Hubble for Chrome's memory requests: what it answers,
 * what it refuses, and that it never answers before the store is ready.
 */

const NOW = 1_800_000_000_000

let posted: { requestId: string; ok: boolean; result?: unknown; error?: string }[] = []

function ask(requestId: string, kind: string, args?: unknown, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent("message", { data: { source: BROWSER_MESSAGE_SOURCE, type: MSG_PAGE_REQUEST, payload: { requestId, kind, args } }, origin, source: window }))
}

async function answerTo(requestId: string) {
  await waitFor(() => expect(posted.some((entry) => entry.requestId === requestId)).toBe(true))
  return posted.find((entry) => entry.requestId === requestId)!
}

async function world(): Promise<WorkspaceStore> {
  let store: WorkspaceStore = {
    version: 1,
    currentId: "ia",
    workspaces: [
      { id: "ia", name: "History IA", tabs: [], createdAt: 1, updatedAt: 1 },
      { id: "phys", name: "Physics", tabs: [], createdAt: 1, updatedAt: 1 },
    ],
  }
  const plan = planConversationSave(
    store,
    "ia",
    { provider: "claude", title: "Alliances", url: "https://claude.ai/chat/0b6f6d3e-2222", conversationId: "0b6f6d3e-2222", turns: [{ role: "user", text: "Was the alliance system decisive?" }, { role: "assistant", text: "Not on its own." }], method: "page" },
    NOW,
    () => "n"
  )!
  await putContent("ia", plan.id, plan.content)
  store = applyConversationSave(store, plan, NOW)
  return store
}

function mount(store: WorkspaceStore | null, ready = true, over: Partial<ExtensionMemoryHandlers> = {}) {
  const handlers: ExtensionMemoryHandlers = {
    getStore: () => store,
    saveCapture: vi.fn(async (_workspaceId, input) => ({ ok: true as const, outcome: "added" as const, title: input.title })),
    onReused: vi.fn(),
    ...over,
  }
  const hook = renderHook(({ isReady }) => useExtensionMemory(handlers, isReady), { initialProps: { isReady: ready } })
  return { handlers, hook }
}

beforeEach(() => {
  resetContentStoreForTests()
  posted = []
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    const data = message as { type?: string; payload?: (typeof posted)[number] }
    if (data.type === MSG_PAGE_RESPONSE && data.payload) posted.push(data.payload)
  })
})

afterEach(() => vi.restoreAllMocks())

describe("useExtensionMemory", () => {
  it("lists projects with how much each knows", async () => {
    mount(await world())
    ask("r1", "projects")
    expect(await answerTo("r1")).toEqual({
      requestId: "r1",
      ok: true,
      result: { currentId: "ia", projects: [{ id: "ia", name: "History IA", items: 1 }, { id: "phys", name: "Physics", items: 0 }] },
    })
  })

  it("says where one conversation is saved — that conversation only, never another from the same app", async () => {
    mount(await world())
    ask("s1", "saved", { url: "https://claude.ai/chat/0b6f6d3e-2222/?ref=sidebar" })
    expect(await answerTo("s1")).toEqual({
      requestId: "s1",
      ok: true,
      result: { conversation: true, saved: [{ workspaceId: "ia", projectName: "History IA", tabId: expect.any(String), title: "Alliances", hasText: true }] },
    })
    // Another Claude chat: in no project, though a Claude chat is saved.
    ask("s2", "saved", { url: "https://claude.ai/chat/9a8b7c6d-3333" })
    expect(await answerTo("s2")).toEqual({ requestId: "s2", ok: true, result: { conversation: true, saved: [] } })
    // Claude's home page names no conversation: nothing is claimed for it.
    ask("s3", "saved", { url: "https://claude.ai/new" })
    expect(await answerTo("s3")).toEqual({ requestId: "s3", ok: true, result: { conversation: false, saved: [] } })
    ask("s4", "saved", {})
    expect(await answerTo("s4")).toEqual({ requestId: "s4", ok: false, error: "invalid" })
  })

  it("says it is not ready rather than answering from an unloaded store", async () => {
    mount(await world(), false)
    ask("r2", "projects")
    expect(await answerTo("r2")).toEqual({ requestId: "r2", ok: false, error: "not-ready" })
  })

  it("re-reads a capture and saves it through the shell's one save", async () => {
    const { handlers } = mount(await world())
    ask("r3", "capture", { workspaceId: "phys", capture: { url: "https://chatgpt.com/c/6720a1b2-1111", title: "Energy - ChatGPT", turns: [{ role: "user", text: "What is work?" }, { role: "assistant", text: "Energy transferred." }] } })
    expect(await answerTo("r3")).toEqual({ requestId: "r3", ok: true, result: { outcome: "added", title: "Energy", turns: 2, truncated: false } })
    expect(handlers.saveCapture).toHaveBeenCalledWith("phys", expect.objectContaining({ provider: "chatgpt", method: "page" }), false)
  })

  it("refuses a capture from a page that is not a conversation, or for a project that is gone", async () => {
    const { handlers } = mount(await world())
    ask("r4", "capture", { workspaceId: "ia", capture: { url: "https://example.com/c/12345678", turns: [{ role: "user", text: "x" }] } })
    ask("r5", "capture", { workspaceId: "gone", capture: {} })
    expect(await answerTo("r4")).toMatchObject({ ok: false, error: "not-a-conversation" })
    expect(await answerTo("r5")).toMatchObject({ ok: false, error: "project-missing" })
    expect(handlers.saveCapture).not.toHaveBeenCalled()
  })

  it("searches saved conversation text and builds context for chosen items", async () => {
    const store = await world()
    mount(store)
    ask("r6", "search", { query: "alliance", workspaceId: "ia" })
    const search = (await answerTo("r6")) as { result: { hits: { ref: unknown; provider?: string; snippet?: string }[] } }
    expect(search.result.hits).toHaveLength(1)
    expect(search.result.hits[0]).toMatchObject({ provider: "claude", projectName: "History IA" })

    ask("r7", "bundle", { workspaceId: "ia", refs: [search.result.hits[0]!.ref], request: "Is the alliance argument strong?" })
    const bundle = (await answerTo("r7")) as { result: { text: string; providers: string[] } }
    expect(bundle.result.providers).toEqual(["claude"])
    expect(bundle.result.text).toContain("> **Claude:** Not on its own.")
    expect(bundle.result.text).toContain("**What I want to do now:** Is the alliance argument strong?")
  })

  it("records a reuse with its AI app, and ignores an AI app it does not know", async () => {
    const { handlers } = mount(await world())
    ask("r8", "reused", { workspaceId: "ia", items: 2, provider: "gemini", how: "inserted" })
    ask("r9", "reused", { workspaceId: "ia", items: 1, provider: "evil", how: "copied" })
    await answerTo("r9")
    expect(handlers.onReused).toHaveBeenNthCalledWith(1, { workspaceId: "ia", items: 2, provider: "gemini", how: "inserted" })
    expect(handlers.onReused).toHaveBeenNthCalledWith(2, { workspaceId: "ia", items: 1, how: "copied" })
  })

  it("answers a malformed request with 'invalid', and ignores other origins entirely", async () => {
    mount(await world())
    ask("r10", "bundle", { workspaceId: "ia", refs: [] })
    expect(await answerTo("r10")).toEqual({ requestId: "r10", ok: false, error: "invalid" })
    ask("r11", "projects", undefined, "https://evil.example")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posted.some((entry) => entry.requestId === "r11")).toBe(false)
  })
})

describe("useExtensionMemory — save-session", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetSessionsForTests()
  })

  it("stores the tabs the extension read as a session, named after its project", async () => {
    mount(await world())
    ask("s1", "save-session", { workspaceId: "ia", tabs: [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/", pinned: true }] })
    const answer = (await answerTo("s1")) as { ok: boolean; result: { id: string; name: string; tabs: number; dropped: number } }
    expect(answer.ok).toBe(true)
    expect(answer.result).toMatchObject({ tabs: 2, dropped: 0 })
    expect(answer.result.name).toMatch(/^History IA — /)
    const [saved] = getSessionsSnapshot().sessions
    expect(saved).toMatchObject({ id: answer.result.id, workspaceId: "ia" })
    expect(saved.tabs.map((tab) => tab.url)).toEqual(["https://a.example/", "https://b.example/"])
  })

  it("keeps a name given in the popup, and counts addresses it refused", async () => {
    mount(await world())
    ask("s2", "save-session", { name: "WW1 essay", tabs: [{ url: "https://a.example/" }, { url: "javascript:alert(1)" }] })
    expect(await answerTo("s2")).toMatchObject({ ok: true, result: { name: "WW1 essay", tabs: 1, dropped: 1 } })
  })

  it("stores nothing for a project that is gone, an empty capture or a malformed request", async () => {
    mount(await world())
    ask("s3", "save-session", { workspaceId: "gone", tabs: [{ url: "https://a.example/" }] })
    ask("s4", "save-session", { tabs: [{ url: "chrome://settings" }] })
    ask("s5", "save-session", { tabs: [] })
    expect(await answerTo("s3")).toMatchObject({ ok: false, error: "project-missing" })
    expect(await answerTo("s4")).toMatchObject({ ok: false, error: "session-empty" })
    expect(await answerTo("s5")).toMatchObject({ ok: false, error: "invalid" })
    expect(getSessionsSnapshot().sessions).toEqual([])
  })
})
