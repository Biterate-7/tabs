/**
 * Hubble for Chrome against the real <AppShell/>: the regressions behind
 * "a new project doesn't reach the extension until something is refreshed"
 * and "a conversation saved from ChatGPT sometimes never registers".
 *
 *   - Another Hubble tab's change (a project made, renamed, deleted) is taken
 *     here as it lands, so whichever tab the extension asks answers with it,
 *     and this tab reports it to the extension without a reload.
 *   - A stale tab no longer writes over a conversation another tab saved.
 *   - A conversation is answered "saved" only once it is on disk; a full
 *     localStorage is a failure, not a success held in memory.
 */
import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { AppShell } from "./app-shell"
import { dismissOnboarding } from "@/lib/onboarding"
import { BROWSER_MESSAGE_SOURCE, MSG_PROJECT_FOCUS } from "@/lib/browser/protocol"
import { MSG_PAGE_REQUEST, MSG_PAGE_RESPONSE } from "@/lib/memory/extension-protocol"
import { resetContentStoreForTests } from "@/lib/resources/content-store"
import { loadWorkspaceStore, saveWorkspaceStore, workspaceStoreStorageKey } from "@/lib/workspace/persistence"
import type { WorkspaceStore } from "@/lib/workspace/types"

vi.mock("@/lib/browser/history", () => ({ fetchBrowserHistory: vi.fn() }))

const CHAT = "https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666"
const CAPTURE = { url: CHAT, title: "Energy - ChatGPT", turns: [{ role: "user", text: "What is work?" }, { role: "assistant", text: "Energy transferred." }] }

function seeded(): WorkspaceStore {
  return {
    version: 1,
    currentId: "ws-history",
    workspaces: [
      { id: "ws-history", name: "History IA", tabs: [], sections: [], createdAt: 1, updatedAt: 1 },
      { id: "ws-physics", name: "Physics EE", tabs: [], sections: [], createdAt: 2, updatedAt: 2 },
    ],
  }
}

/** Another Hubble tab writing the store: localStorage changes, and this tab gets the `storage` event (a browser fires it only in the others). */
function otherTabWrites(change: (store: WorkspaceStore) => WorkspaceStore) {
  const next = change(loadWorkspaceStore()!)
  const key = workspaceStoreStorageKey()
  const newValue = JSON.stringify(next)
  window.localStorage.setItem(key, newValue)
  window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea: window.localStorage }))
}

type Report = { focus?: { id?: string }; projects?: { id: string; name: string }[]; revision?: number }
const stops: (() => void)[] = []

/** Project reports this page sends the extension (what content-script.js relays to background.js). */
function projectReports(): Report[] {
  const seen: Report[] = []
  const listener = (event: MessageEvent) => {
    const data = event.data as { source?: string; type?: string; payload?: Report }
    if (data?.source === BROWSER_MESSAGE_SOURCE && data.type === MSG_PROJECT_FOCUS && data.payload) seen.push(data.payload)
  }
  window.addEventListener("message", listener)
  stops.push(() => window.removeEventListener("message", listener))
  return seen
}

let requests = 0
/** One request from the extension, as the content script posts it; asked again while the page says it isn't ready. */
async function pageRequest(kind: string, args: unknown): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  for (let tries = 0; tries < 100; tries += 1) {
    const requestId = `req-${++requests}`
    const answer = await new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>((resolve) => {
      const listener = (event: MessageEvent) => {
        const data = event.data as { type?: string; payload?: { requestId?: string; ok: boolean; result?: Record<string, unknown>; error?: string } }
        if (data?.type !== MSG_PAGE_RESPONSE || data.payload?.requestId !== requestId) return
        window.removeEventListener("message", listener)
        resolve(data.payload)
      }
      window.addEventListener("message", listener)
      window.dispatchEvent(new MessageEvent("message", { data: { source: BROWSER_MESSAGE_SOURCE, type: MSG_PAGE_REQUEST, payload: { requestId, kind, args } }, origin: window.location.origin, source: window }))
    })
    if (answer.error !== "not-ready") return answer
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("the page never became ready")
}

const projectNames = async () => ((await pageRequest("projects", {})).result?.projects as { name: string }[]).map((project) => project.name)

beforeEach(() => {
  window.localStorage.clear()
  resetContentStoreForTests()
  dismissOnboarding()
  saveWorkspaceStore(seeded())
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.restoreAllMocks()
  cleanup()
})

describe("projects changed in another Hubble tab", () => {
  it("a project created there is in this tab's answer and its report to the extension — no reload", async () => {
    const reports = projectReports()
    render(<AppShell />)
    expect(await projectNames()).toEqual(["History IA", "Physics EE"])
    await waitFor(() => expect(reports.length).toBeGreaterThan(0))
    const before = reports.at(-1)!.revision!

    otherTabWrites((store) => ({ ...store, workspaces: [...store.workspaces, { id: "ws-bio", name: "Biology", tabs: [], sections: [], createdAt: 3, updatedAt: 3 }] }))
    await waitFor(() => expect(reports.at(-1)?.projects?.map((project) => project.name)).toEqual(["History IA", "Physics EE", "Biology"]))
    expect(reports.at(-1)!.revision!).toBeGreaterThan(before)
    expect(await projectNames()).toEqual(["History IA", "Physics EE", "Biology"])
  }, 30_000)

  it("a rename there is reported here, and this tab keeps the project it has open", async () => {
    const reports = projectReports()
    render(<AppShell />)
    await projectNames()
    otherTabWrites((store) => ({ ...store, currentId: "ws-physics", workspaces: store.workspaces.map((w) => (w.id === "ws-history" ? { ...w, name: "History IA (final)" } : w)) }))
    await waitFor(() => expect(reports.at(-1)?.projects?.[0]?.name).toBe("History IA (final)"))
    expect(reports.at(-1)?.focus?.id).toBe("ws-history")
  }, 30_000)

  it("deleting this tab's open project there moves this tab off it, and the extension hears the shorter list", async () => {
    const reports = projectReports()
    render(<AppShell />)
    await projectNames()
    otherTabWrites((store) => ({ ...store, currentId: "ws-physics", workspaces: store.workspaces.filter((w) => w.id !== "ws-history") }))
    await waitFor(() => expect(reports.at(-1)?.projects?.map((project) => project.id)).toEqual(["ws-physics"]))
    expect(reports.at(-1)?.focus?.id).toBe("ws-physics")
  }, 30_000)

  it("a conversation saved in this tab no longer erases a project another tab made (and the other way round)", async () => {
    render(<AppShell />)
    await projectNames()
    otherTabWrites((store) => ({ ...store, workspaces: [...store.workspaces, { id: "ws-bio", name: "Biology", tabs: [], sections: [], createdAt: 3, updatedAt: 3 }] }))
    await waitFor(async () => expect(await projectNames()).toContain("Biology"))
    expect(await pageRequest("capture", { workspaceId: "ws-physics", captureId: "cap-1", capture: CAPTURE })).toMatchObject({ ok: true, result: { outcome: "added", project: "Physics EE" } })
    const onDisk = loadWorkspaceStore()!
    expect(onDisk.workspaces.map((w) => w.id)).toEqual(["ws-history", "ws-physics", "ws-bio"])
    expect(onDisk.workspaces.find((w) => w.id === "ws-physics")!.tabs.map((tab) => tab.url)).toEqual([CHAT])
  }, 30_000)
})

describe("a conversation from ChatGPT", () => {
  it("is answered saved once it is on disk, into the project named, and shows there", async () => {
    render(<AppShell />)
    const answer = await pageRequest("capture", { workspaceId: "ws-history", captureId: "cap-2", capture: CAPTURE })
    expect(answer).toMatchObject({ ok: true, result: { outcome: "added", turns: 2, project: "History IA" } })
    expect(loadWorkspaceStore()!.workspaces.find((w) => w.id === "ws-history")!.tabs).toEqual([expect.objectContaining({ url: CHAT })])
    // Where the extension then says it is saved.
    expect(await pageRequest("saved", { url: CHAT })).toMatchObject({ ok: true, result: { conversation: true, saved: [expect.objectContaining({ workspaceId: "ws-history", hasText: true })] } })
    // The same save again (a retry after a lost answer): the first answer, one copy.
    expect(await pageRequest("capture", { workspaceId: "ws-history", captureId: "cap-2", capture: CAPTURE })).toMatchObject({ ok: true, result: { outcome: "added" } })
    expect(loadWorkspaceStore()!.workspaces.find((w) => w.id === "ws-history")!.tabs).toHaveLength(1)
  }, 30_000)

  it("is a failure, never a success held in memory, when localStorage can't take it", async () => {
    render(<AppShell />)
    await projectNames()
    const key = workspaceStoreStorageKey()
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name: string, value: string) {
      if (name === key) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
      return setItem.call(this, name, value)
    })
    expect(await pageRequest("capture", { workspaceId: "ws-history", captureId: "cap-3", capture: CAPTURE })).toEqual(expect.objectContaining({ ok: false, error: "storage-failed" }))
    // Nothing claims it: not this page, not the extension's "where is it saved".
    expect(await pageRequest("saved", { url: CHAT })).toMatchObject({ ok: true, result: { saved: [] } })
    vi.mocked(Storage.prototype.setItem).mockRestore()
    // Room again: the retry goes in.
    expect(await pageRequest("capture", { workspaceId: "ws-history", captureId: "cap-3", capture: CAPTURE })).toMatchObject({ ok: true, result: { outcome: "added" } })
  }, 30_000)
})
