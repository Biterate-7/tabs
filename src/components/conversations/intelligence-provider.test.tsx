import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { IntelligenceProvider } from "./intelligence-provider"
import { useConversationIntelligence } from "@/hooks/use-conversation-intelligence"
import { useSharedIntelligence } from "@/hooks/use-intelligence-processor"
import { contentHash } from "@/lib/conversations/hash"
import { resetBackfillForTests } from "@/lib/conversations/intelligence/backfill"
import { intelligenceStatus, resetIntelligenceDiagnosticsForTests } from "@/lib/conversations/intelligence/diagnostics"
import { DEFAULT_INTELLIGENCE_SETTINGS, saveIntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import { EXTRACTIONS, readDerived, readRun, resetDerivedStoreForTests } from "@/lib/conversations/intelligence/store"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { BackfillReport } from "@/lib/conversations/intelligence/backfill"
import type { CachedExtraction } from "@/lib/conversations/intelligence/store"
import type { ConversationTurn } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The background processor end to end, on the real stores (IndexedDB via
 * fake-indexeddb): conversations saved earlier are analysed after start-up
 * without opening any view; the next start reads that analysis back instead
 * of redoing it; and every view sees the same results.
 */

const NOW = new Date(2026, 10, 20, 12).getTime()
const chats: Record<string, { title: string; turns: ConversationTurn[] }> = {
  t1: {
    title: "Sync server database",
    turns: [
      { role: "user", text: "Should the sync server use PostgreSQL or SQLite?" },
      { role: "assistant", text: "I'd recommend PostgreSQL for the sync server, because it handles concurrent writes." },
      { role: "user", text: "Let's go with PostgreSQL for the sync server. I need to write the migration this week." },
    ],
  },
  t2: {
    title: "Tauri updater",
    turns: [
      { role: "user", text: "How do I ship updates for a Tauri app on Windows?" },
      { role: "assistant", text: "Use the updater plugin with a signed manifest." },
      { role: "user", text: "Why does the updater refuse my unsigned manifest?" },
    ],
  },
}

function tab(id: string) {
  const { title, turns } = chats[id]!
  const url = `https://chatgpt.com/c/${id}aaaaaaa-1111`
  return { id, url, normalizedUrl: url, domain: "chatgpt.com", title, resource: { kind: "conversation" as const, origin: "extension" as const, status: "ready" as const, addedAt: NOW, updatedAt: NOW, meta: { provider: "chatgpt" as const, capture: "page" as const, contentHash: contentHash({ turns }), turnCount: turns.length }, content: { chars: 200, turns: turns.length, extractedAt: NOW } } }
}

const workspaces: Workspace[] = [
  { id: "w1", name: "Hubble", createdAt: 0, updatedAt: 0, tabs: [tab("t1")] },
  { id: "w2", name: "Desktop", createdAt: 0, updatedAt: 0, tabs: [tab("t2")] },
]

function newPage() {
  // What a restart leaves: the device's stores, nothing in memory.
  resetBackfillForTests()
  resetDerivedStoreForTests()
  resetContentStoreForTests()
  resetIntelligenceDiagnosticsForTests()
}

beforeEach(async () => {
  window.localStorage.clear()
  newPage()
  for (const [id, chat] of Object.entries(chats)) await putContent(id === "t1" ? "w1" : "w2", id, { kind: "conversation", turns: chat.turns, extractedAt: NOW })
})
afterEach(() => window.localStorage.clear())

const wrapper = ({ children }: { children: ReactNode }) => <IntelligenceProvider workspaces={workspaces}>{children}</IntelligenceProvider>

describe("background processing for the whole app", () => {
  it("analyses every project's saved conversations after start-up, with no view open, and keeps the report", async () => {
    render(<IntelligenceProvider workspaces={workspaces}>{null}</IntelligenceProvider>)
    await waitFor(async () => expect((await readDerived<CachedExtraction>(EXTRACTIONS, "_")).length).toBe(2), { timeout: 8_000 })
    await waitFor(async () => expect((await readRun<BackfillReport>("_"))?.state).toBe("complete"), { timeout: 8_000 })
    const stored = (await readRun<BackfillReport>("_"))!.report
    expect(stored).toMatchObject({ discovered: 2, projects: 2, processed: 2, failed: 0, alreadyProcessed: 0 })
    await waitFor(() => expect((intelligenceStatus().report as BackfillReport | undefined)?.processed).toBe(2))
  })

  it("after a restart, reads the analysis back instead of redoing it — and a view opens on it", async () => {
    const first = render(<IntelligenceProvider workspaces={workspaces}>{null}</IntelligenceProvider>)
    await waitFor(async () => expect((await readRun<BackfillReport>("_"))?.state).toBe("complete"), { timeout: 8_000 })
    first.unmount()

    newPage()
    const { result } = renderHook(() => ({ shared: useSharedIntelligence(), view: useConversationIntelligence(workspaces, NOW) }), { wrapper })
    await waitFor(() => expect(result.current.shared?.report?.state).toBe("complete"), { timeout: 8_000 })
    expect(result.current.shared!.report).toMatchObject({ alreadyProcessed: 2, processed: 0, needed: 0 })
    // The view shares the processor: nothing analysed twice, facts there.
    expect(result.current.view.progress).toMatchObject({ total: 2, analyzed: 2, fresh: 0 })
    expect(result.current.view.index.facts.some((fact) => fact.text.includes("PostgreSQL"))).toBe(true)
  })

  it("follows the person's settings wherever they change them", async () => {
    const { result } = renderHook(() => useSharedIntelligence(), { wrapper })
    await waitFor(() => expect(result.current?.report?.state).toBe("complete"), { timeout: 8_000 })
    act(() => {
      saveIntelligenceSettings({ ...DEFAULT_INTELLIGENCE_SETTINGS, enabled: false })
    })
    await waitFor(() => expect(result.current?.report?.skipped.analysisOff).toBe(2), { timeout: 8_000 })
    expect(result.current?.report?.needed).toBe(0)
  })
})
