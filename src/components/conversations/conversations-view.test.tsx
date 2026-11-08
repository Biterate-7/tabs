import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConversationsView } from "./conversations-view"
import { contentHash } from "@/lib/conversations/hash"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import { loadIntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { AiProviderId } from "@/lib/providers/registry"
import type { ConversationTurn } from "@/lib/resources/types"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The Conversations view over real saved records: conversations saved into
 * projects (Tab.resource + turns in the content store), analysed on the
 * device, asked about, opened, corrected and deleted.
 */

const DAY = 86_400_000
const NOW = new Date(2026, 9, 30, 12, 0).getTime()

const SYNC: ConversationTurn[] = [
  { role: "user", text: "My Next.js app loses saved conversations after a reload. The IndexedDB write seems to fail silently. How do I debug this?" },
  { role: "assistant", text: "You could approach it two ways:\n\n1. Wrap the write in a promise that resolves on oncomplete.\n2. Move persistence into a queue.\n\nI'd recommend wrapping the IndexedDB write in a promise that resolves on oncomplete." },
  { role: "user", text: "Let's go with option 1. I'll update the content store tomorrow." },
]
const STORAGE: ConversationTurn[] = [
  { role: "user", text: "Should I keep IndexedDB or move the content store to SQLite in Tauri?" },
  { role: "assistant", text: "You should keep IndexedDB for the web build. A better approach is a storage adapter with two backends." },
  { role: "user", text: "We decided to use a storage adapter with IndexedDB on the web and SQLite in Tauri." },
]

function conversation(id: string, url: string, title: string, provider: AiProviderId, turns: ConversationTurn[], at: number): Tab {
  return {
    id,
    url,
    normalizedUrl: url,
    domain: new URL(url).hostname,
    title,
    resource: { kind: "conversation", origin: "extension", status: "ready", addedAt: at, updatedAt: at, meta: { provider, capture: "page", contentHash: contentHash({ turns }), turnCount: turns.length }, content: { chars: 500, turns: turns.length, extractedAt: at } },
  }
}

const hubble: Workspace = { id: "w1", name: "Hubble web", tabs: [conversation("t1", "https://chatgpt.com/c/aaaaaaaa-1111", "IndexedDB writes lost after reload", "chatgpt", SYNC, NOW - 5 * DAY)], createdAt: 0, updatedAt: 0 }
const desktop: Workspace = { id: "w2", name: "Hubble desktop", tabs: [conversation("t2", "https://claude.ai/chat/bbbbbbbb-2222", "Storage adapter for IndexedDB and SQLite", "claude", STORAGE, NOW - DAY)], createdAt: 0, updatedAt: 0 }

beforeEach(async () => {
  resetContentStoreForTests()
  window.localStorage.clear()
  await putContent("w1", "t1", { kind: "conversation", turns: SYNC, extractedAt: NOW })
  await putContent("w2", "t2", { kind: "conversation", turns: STORAGE, extractedAt: NOW })
})
afterEach(() => window.localStorage.clear())

function renderView() {
  const props = { workspaces: [hubble, desktop], now: NOW, onOpenItem: vi.fn(), onOpenUrl: vi.fn(), onRemoveItem: vi.fn(), onOpenSettings: vi.fn() }
  render(<ConversationsView {...props} />)
  return props
}

describe("ConversationsView", () => {
  it("analyses saved conversations on the device and joins the two apps' work into a thread", async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Analysed 2 of 2 conversations on this device/), { timeout: 5000 })
    const threads = screen.getByRole("region", { name: "Across your AI apps" })
    expect(within(threads).getByText(/2 conversations · Hubble web, Hubble desktop/)).toBeTruthy()
  })

  it("answers a question with the person's decisions only, attributed", async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Analysed 2 of 2/), { timeout: 5000 })
    await user.type(screen.getByLabelText("Ask about your conversations"), "What did I decide about IndexedDB?")
    await user.click(screen.getByRole("button", { name: /^Ask/ }))
    const answer = await screen.findByText(/decisions? in 2 conversations/)
    const panel = answer.closest("[data-answer]") as HTMLElement
    expect(within(panel).getByText("You decided")).toBeTruthy()
    expect(within(panel).getByText("You accepted ChatGPT's suggestion")).toBeTruthy()
    expect(within(panel).queryByText(/suggested$/)).toBeNull()
  })

  it("says when nothing saved answers the question", async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Analysed 2 of 2/), { timeout: 5000 })
    await user.type(screen.getByLabelText("Ask about your conversations"), "What did I decide about kubernetes ingress?")
    await user.click(screen.getByRole("button", { name: /^Ask/ }))
    expect(await screen.findByText(/Nothing in your 2 analysed conversations answers this/)).toBeTruthy()
  })

  it("opens a conversation, shows who said what, keeps a correction, and deletes through the shell", async () => {
    const user = userEvent.setup()
    const props = renderView()
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Analysed 2 of 2/), { timeout: 5000 })
    await user.click(screen.getByRole("button", { name: /^Storage adapter for IndexedDB and SQLite/ }))
    const decisions = screen.getByRole("region", { name: "Decisions" })
    expect(within(decisions).getByText("You decided")).toBeTruthy()
    expect(within(decisions).getAllByText("Claude suggested").length).toBeGreaterThan(0)

    await user.click(within(decisions).getAllByRole("button", { name: /^Correct: We decided/ })[0]!)
    await user.click(await screen.findByRole("menuitem", { name: /It was only the AI's suggestion/ }))
    await waitFor(() => expect(Object.values(loadIntelligenceSettings().facts)).toEqual([expect.objectContaining({ status: "suggested" })]))
    expect(within(screen.getByRole("region", { name: "Decisions" })).queryByText("You decided")).toBeNull()

    await user.click(screen.getAllByRole("button", { name: /Show the message/ })[0]!)
    expect(screen.getByRole("list", { name: "Conversation" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: /Delete from Hubble/ }))
    await user.click(screen.getByRole("button", { name: /^Delete$/ }))
    expect(props.onRemoveItem).toHaveBeenCalledWith("w2", { kind: "source", tabId: "t2" })
  })

  it("leaves a conversation out of analysis without deleting it", async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Analysed 2 of 2/), { timeout: 5000 })
    await user.click(screen.getByRole("button", { name: /^IndexedDB writes lost after reload/ }))
    await user.click(screen.getByRole("button", { name: "Leave out of analysis" }))
    expect(await screen.findByRole("button", { name: "Include in analysis" })).toBeTruthy()
    expect(screen.getAllByText(/Left out of analysis/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole("button", { name: /All conversations/ }))
    expect(screen.getByRole("status").textContent).toMatch(/Analysed 1 of 1/)
    expect(screen.getByRole("button", { name: /^IndexedDB writes lost after reload/ }).textContent).toMatch(/Not analysed/)
  })

  it("explains why it holds a fact and why two conversations are related", async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Analysed 2 of 2/), { timeout: 5000 })
    await user.click(screen.getByRole("button", { name: /^Storage adapter for IndexedDB and SQLite/ }))
    await user.click(within(screen.getByRole("region", { name: "Decisions" })).getAllByRole("button", { name: /^Why Hubble thinks this: We decided/ })[0]!)
    const why = document.querySelector("[data-fact-why]") as HTMLElement
    expect(within(why).getByText(/Your own message states a decision/)).toBeTruthy()
    expect(within(why).getByText(/Inferred by Hubble/)).toBeTruthy()
    expect(within(why).getByText(/You, message 3:/)).toBeTruthy()

    await user.click(screen.getByRole("radio", { name: /Related/ }))
    await user.click(screen.getByRole("button", { name: /^Why related: IndexedDB writes lost after reload/ }))
    const reasons = document.querySelector("[data-relation-why]") as HTMLElement
    expect(within(reasons).getByText(/Both mention IndexedDB/)).toBeTruthy()
    expect(within(reasons).getByText(/meaning not compared/)).toBeTruthy()
  })

  it("checks a link with the person, applies the answer, and counts it", async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Analysed 2 of 2/), { timeout: 5000 })
    await user.click(screen.getByRole("button", { name: /Check Hubble.s links/ }))
    expect(screen.getByText("Conversations analysed").nextElementSibling!.textContent).toBe("2")
    await user.click(screen.getByRole("button", { name: "Start checking" }))
    await user.click(screen.getByRole("button", { name: "Not related" }))
    await waitFor(() => expect(Object.keys(loadIntelligenceSettings().reviews)).toHaveLength(1))
    expect(loadIntelligenceSettings().unrelated).toHaveLength(1)
    const accuracy = screen.getByRole("region", { name: "Accuracy on your history" })
    expect(within(accuracy).getByText("0% (of 1)")).toBeTruthy()
    expect(within(accuracy).getByText(/Too few to rely on yet/)).toBeTruthy()
  })
})
