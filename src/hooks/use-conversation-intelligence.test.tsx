import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useConversationIntelligence } from "./use-conversation-intelligence"
import { contentHash } from "@/lib/conversations/hash"
import { conversationRecordsOf, recordFingerprint } from "@/lib/conversations/intelligence/canonical"
import { extractConversation } from "@/lib/conversations/intelligence/extract"
import { correctFact, saveIntelligenceSettings, DEFAULT_INTELLIGENCE_SETTINGS } from "@/lib/conversations/intelligence/settings"
import { EXTRACTIONS, derivedKey, readDerived, resetDerivedStoreForTests, writeDerived } from "@/lib/conversations/intelligence/store"
import { EXTRACTOR_VERSION } from "@/lib/conversations/intelligence/types"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { CachedExtraction } from "@/lib/conversations/intelligence/store"
import type { ConversationTurn } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Processing only what changed: an unchanged conversation's analysis is read
 * from the device's cache, never redone; a changed conversation — or one an
 * older extractor read — is analysed again; corrections survive it; and the
 * opt-in meaning comparison degrades to words where it can't run.
 */

const NOW = new Date(2026, 9, 30, 12).getTime()
const TURNS: ConversationTurn[] = [
  { role: "user", text: "Should the sync server use PostgreSQL or SQLite?" },
  { role: "assistant", text: "I'd recommend PostgreSQL for the sync server, because it handles concurrent writes." },
  { role: "user", text: "Let's go with PostgreSQL for the sync server." },
]
const url = "https://chatgpt.com/c/aaaaaaaa-1111"
const workspace: Workspace = {
  id: "w1",
  name: "Hubble",
  createdAt: 0,
  updatedAt: 0,
  tabs: [{ id: "t1", url, normalizedUrl: url, domain: "chatgpt.com", title: "Sync server database", resource: { kind: "conversation", origin: "extension", status: "ready", addedAt: NOW, updatedAt: NOW, meta: { provider: "chatgpt", capture: "page", contentHash: contentHash({ turns: TURNS }), turnCount: 3 }, content: { chars: 200, turns: 3, extractedAt: NOW } } }],
}
const workspaces = [workspace]
const record = () => conversationRecordsOf(workspaces, new Map([["w1", new Map([["t1", { kind: "conversation" as const, turns: TURNS, extractedAt: NOW }]])]]))[0]!
const key = derivedKey("_", "w1", "t1")

beforeEach(async () => {
  resetContentStoreForTests()
  resetDerivedStoreForTests()
  window.localStorage.clear()
  await putContent("w1", "t1", { kind: "conversation", turns: TURNS, extractedAt: NOW })
})
afterEach(() => window.localStorage.clear())

/** A cached extraction carrying a marker only a cache read could have produced. */
async function cacheWithMarker(version: number) {
  const real = extractConversation(record())
  const marked = { ...real, version, facts: [{ ...real.facts[0]!, id: `${real.recordId}:decision:marker`, text: "MARKER from the cache" }] }
  await writeDerived(EXTRACTIONS, [{ key, owner: "_", fingerprint: recordFingerprint(record()), version, extraction: marked }])
}

describe("incremental processing", () => {
  it("reads an unchanged conversation's analysis from the device's cache instead of analysing it again", async () => {
    await cacheWithMarker(EXTRACTOR_VERSION)
    const { result } = renderHook(() => useConversationIntelligence(workspaces, NOW))
    await waitFor(() => expect(result.current.progress.analyzed).toBe(1))
    expect(result.current.index.facts.map((fact) => fact.text)).toEqual(["MARKER from the cache"])
    expect(result.current.progress.fresh).toBe(0)
  })

  it("analyses again what an older extractor read, and replaces the cached entry", async () => {
    await cacheWithMarker(EXTRACTOR_VERSION - 1)
    const { result } = renderHook(() => useConversationIntelligence(workspaces, NOW))
    await waitFor(() => expect(result.current.progress.fresh).toBe(1))
    expect(result.current.index.facts.some((fact) => fact.text.includes("MARKER"))).toBe(false)
    await waitFor(async () => expect((await readDerived<CachedExtraction>(EXTRACTIONS, "_"))[0]!.version).toBe(EXTRACTOR_VERSION))
  })

  it("keeps the person's corrections through a fresh analysis", async () => {
    const decided = extractConversation(record()).facts.find((fact) => fact.status === "accepted" || fact.status === "decided")!
    saveIntelligenceSettings(correctFact(DEFAULT_INTELLIGENCE_SETTINGS, decided.id, { status: "suggested" }, NOW))
    const { result } = renderHook(() => useConversationIntelligence(workspaces, NOW))
    await waitFor(() => expect(result.current.progress.analyzed).toBe(1))
    act(() => result.current.reanalyze())
    await waitFor(() => expect(result.current.progress.fresh).toBe(1))
    const fact = result.current.index.facts.find((entry) => entry.id === decided.id)!
    expect(fact.status).toBe("suggested")
    expect(fact.corrected).toBe(true)
  })

  it("keeps relating by words where the on-device model can't run, and says so", async () => {
    saveIntelligenceSettings({ ...DEFAULT_INTELLIGENCE_SETTINGS, semantic: true })
    const { result } = renderHook(() => useConversationIntelligence(workspaces, NOW))
    await waitFor(() => expect(result.current.progress.analyzed).toBe(1))
    await waitFor(() => expect(result.current.semanticStatus.state).toBe("unavailable"))
    expect(result.current.semanticStatus.message).toMatch(/workers/)
    expect(result.current.index.semantic.used).toBe(false)
  })
})
