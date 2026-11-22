import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

const bridge = vi.hoisted(() => {
  const listeners = new Set<(connected: boolean) => void>()
  return {
    listeners,
    startConnectionWatch: vi.fn(() => () => {}),
    subscribeConnection: vi.fn((listener: (connected: boolean) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    isBrowserConnected: vi.fn(() => false),
    sendBrowserCommand: vi.fn(),
  }
})
vi.mock("@/lib/browser/bridge", () => bridge)
const youtube = vi.hoisted(() => ({ readTranscriptThroughBrowser: vi.fn(), requestYouTubeAccess: vi.fn() }))
vi.mock("@/lib/resources/youtube-browser", () => youtube)

import { useResourceProcessing, waitsForChrome } from "./use-resource-processing"
import { getContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import { EXTRACTION_ERRORS } from "@/lib/resources/extraction"
import { ingestResources } from "@/lib/resources/ingest"
import { setStorageNamespace } from "@/lib/storage/namespace"
import type { ExtractionResponse } from "@/lib/resources/extraction"
import type { ProcessDeps } from "@/lib/resources/process"
import type { ResourceError } from "@/lib/resources/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * Videos whose transcript waits on Hubble for Chrome are read again by
 * themselves: when it connects, and right after the person allows it to read
 * youtube.com — never in a loop.
 */

const ID = "dQw4w9WgXcQ"
const NOW = 1_800_000_000_000
const SITE: ExtractionResponse = {
  ok: true,
  kind: "youtube",
  status: "partial",
  finalUrl: `https://www.youtube.com/watch?v=${ID}`,
  title: "Never Gonna Give You Up",
  meta: { siteName: "YouTube" },
  error: EXTRACTION_ERRORS.transcripts_off,
}
const PAGE = { ok: true as const, segments: [{ start: 18, text: "We're no strangers to love" }] }

let store: WorkspaceStore

function seed(error?: ResourceError): string {
  let next: WorkspaceStore = { version: 1, currentId: "music", workspaces: [{ id: "music", name: "Music", tabs: [], sections: [], createdAt: 1, updatedAt: 1 }] }
  next = ingestResources(next, "music", [{ url: `https://www.youtube.com/watch?v=${ID}` }], "manual", NOW)!.store
  const tab = next.workspaces[0]!.tabs[0]!
  if (error) {
    next = { ...next, workspaces: [{ ...next.workspaces[0]!, tabs: [{ ...tab, resource: { ...tab.resource!, status: "partial", updatedAt: NOW, attempts: 1, error } }] }] }
  }
  store = next
  return tab.id
}

const resourceOf = (tabId: string) => store.workspaces[0]!.tabs.find((tab) => tab.id === tabId)!.resource!

beforeEach(async () => {
  resetContentStoreForTests()
  setStorageNamespace(null)
  bridge.listeners.clear()
  vi.clearAllMocks()
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase("hubble-resources")
    request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined)
  })
})

function hook(deps: Partial<ProcessDeps>) {
  // A commit can come during the first render's effects, before `view` exists: re-render once it does.
  const commit = (next: WorkspaceStore) => {
    store = next
    queueMicrotask(() => view?.rerender({ current: store }))
  }
  const view = renderHook(({ current }) => useResourceProcessing({ store: current, getStore: () => store, commit, enabled: true, graceMs: 10_000, deps }), {
    initialProps: { current: store },
  })
  return view
}

describe("saving a video", () => {
  it("reads its transcript through Hubble for Chrome by default, and it becomes searchable content", async () => {
    youtube.readTranscriptThroughBrowser.mockResolvedValue(PAGE)
    const tabId = seed()
    hook({ extract: async () => SITE })
    await waitFor(() => expect(resourceOf(tabId).status).toBe("ready"))
    expect(youtube.readTranscriptThroughBrowser).toHaveBeenCalledWith({ videoId: ID, wake: expect.any(Boolean) })
    expect((await getContent("music", tabId))?.transcript).toEqual([{ start: 18, text: "We're no strangers to love" }])
  })
})

describe("a video waiting on Hubble for Chrome", () => {
  it("is not read again on its own while nothing changes", async () => {
    const readTranscript = vi.fn(async () => PAGE)
    const tabId = seed(EXTRACTION_ERRORS.transcript_extension_asleep)
    hook({ extract: async () => SITE, readTranscript })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(readTranscript).not.toHaveBeenCalled()
    expect(resourceOf(tabId).status).toBe("partial")
    expect(bridge.startConnectionWatch).toHaveBeenCalled()
  })

  it("is read again when Hubble for Chrome connects — once a minute at most", async () => {
    const readTranscript = vi.fn(async () => ({ ok: false as const, reason: "no_answer" as const }))
    const tabId = seed(EXTRACTION_ERRORS.transcript_needs_extension)
    hook({ extract: async () => SITE, readTranscript })
    await waitFor(() => expect(bridge.listeners.size).toBe(1))
    act(() => [...bridge.listeners].forEach((listener) => listener(true)))
    await waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(resourceOf(tabId).error).toEqual(EXTRACTION_ERRORS.transcript_extension_asleep))
    // Still waiting, and the listener is back — but a second "connected" this soon asks nothing.
    await waitFor(() => expect(bridge.listeners.size).toBe(1))
    act(() => [...bridge.listeners].forEach((listener) => listener(true)))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(readTranscript).toHaveBeenCalledTimes(1)
  })

  it("ignores Hubble for Chrome going away", async () => {
    const readTranscript = vi.fn(async () => PAGE)
    seed(EXTRACTION_ERRORS.transcript_needs_extension)
    hook({ extract: async () => SITE, readTranscript })
    await waitFor(() => expect(bridge.listeners.size).toBe(1))
    act(() => [...bridge.listeners].forEach((listener) => listener(false)))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(readTranscript).not.toHaveBeenCalled()
  })

  it("is read again right after the person allows youtube.com — and not when they don't", async () => {
    const readTranscript = vi.fn(async () => PAGE)
    const tabId = seed(EXTRACTION_ERRORS.transcript_needs_access)
    const view = hook({ extract: async () => SITE, readTranscript })

    youtube.requestYouTubeAccess.mockResolvedValueOnce({ granted: false })
    await act(async () => expect(await view.result.current.allowYouTube!()).toEqual({ granted: false }))
    expect(resourceOf(tabId).status).toBe("partial")

    youtube.requestYouTubeAccess.mockResolvedValueOnce({ granted: true })
    await act(async () => void (await view.result.current.allowYouTube!()))
    await waitFor(() => expect(resourceOf(tabId).status).toBe("ready"))
    // Allowed just now by the person: Chrome may be woken to answer.
    expect(readTranscript).toHaveBeenCalledWith({ videoId: ID, wake: true })
  })

  it("is only a video whose transcript waits on Chrome", () => {
    const base = { kind: "youtube" as const, origin: "manual" as const, status: "partial" as const, addedAt: 1, updatedAt: 1 }
    expect(waitsForChrome({ ...base, error: EXTRACTION_ERRORS.transcript_needs_access })).toBe(true)
    expect(waitsForChrome({ ...base, error: EXTRACTION_ERRORS.transcript_extension_outdated })).toBe(true)
    expect(waitsForChrome({ ...base, error: EXTRACTION_ERRORS.transcript_unavailable })).toBe(false)
    expect(waitsForChrome({ ...base, error: EXTRACTION_ERRORS.transcript_read_failed })).toBe(false)
    expect(waitsForChrome({ ...base, kind: "webpage", error: EXTRACTION_ERRORS.transcript_needs_access })).toBe(false)
    expect(waitsForChrome({ ...base, status: "ready", error: EXTRACTION_ERRORS.transcript_needs_access })).toBe(false)
  })
})
