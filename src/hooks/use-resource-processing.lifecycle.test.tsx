import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useResourceProcessing } from "./use-resource-processing"
import { getContent, putContent, pruneContentExcept, resetContentStoreForTests } from "@/lib/resources/content-store"
import { ingestResources } from "@/lib/resources/ingest"
import { searchProject } from "@/lib/resources/search"
import { removeTabs } from "@/lib/workspace/cleanup"
import { deleteWorkspace, moveTabsBetweenWorkspaces, updateWorkspaceTabs } from "@/lib/workspace/store"
import { setStorageNamespace } from "@/lib/storage/namespace"
import type { Tab } from "@/lib/tabs/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * Stored content (transcripts, PDF pages, page text) follows its tab out of a
 * project, whichever door it leaves by. Each test drives the store through
 * the exact transition a real deletion path produces — using that path's own
 * domain function where it has one — against the real content store.
 */

const GRACE = 40
const NOW = 1_800_000_000_000

let store: WorkspaceStore

async function seed(): Promise<{ video: Tab; pdf: Tab; other: Tab }> {
  let next: WorkspaceStore = {
    version: 1,
    currentId: "physics",
    workspaces: [
      { id: "physics", name: "Physics", tabs: [], sections: [], createdAt: 1, updatedAt: 1 },
      { id: "chem", name: "Chemistry", tabs: [], sections: [], createdAt: 1, updatedAt: 1 },
    ],
  }
  next = ingestResources(next, "physics", [{ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "Physics revision" }, { url: "https://example.com/notes.pdf" }], "manual", NOW)!.store
  next = ingestResources(next, "chem", [{ url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", title: "Energetics" }], "manual", NOW)!.store
  // Resources that hold content are "ready" — nothing is reading them, as on any real reload.
  const ready = async (workspaceId: string, tab: Tab, content: Parameters<typeof putContent>[2]): Promise<Tab> => ({
    ...tab,
    resource: { ...tab.resource!, status: "ready", content: await putContent(workspaceId, tab.id, content) },
  })
  const video = await ready("physics", next.workspaces[0]!.tabs[0]!, { kind: "youtube", extractedAt: 1, transcript: [{ start: 522, text: "Gravitational potential energy." }] })
  const pdf = await ready("physics", next.workspaces[0]!.tabs[1]!, { kind: "pdf", extractedAt: 1, pages: ["Energy is conserved."] })
  const other = await ready("chem", next.workspaces[1]!.tabs[0]!, { kind: "youtube", extractedAt: 1, transcript: [{ start: 60, text: "Activation energy." }] })
  next = updateWorkspaceTabs(updateWorkspaceTabs(next, "physics", [video, pdf]), "chem", [other])
  store = next
  return { video, pdf, other }
}

function mount() {
  const hook = renderHook(({ current }) => useResourceProcessing({ store: current, getStore: () => store, commit: (next) => (store = next), enabled: true, graceMs: GRACE, deps: { extract: async () => ({ ok: false, error: { code: "offline", message: "x", retryable: true } }) } }), {
    initialProps: { current: store },
  })
  return {
    ...hook,
    set(next: WorkspaceStore) {
      store = next
      hook.rerender({ current: next })
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const stored = (workspaceId: string, tabId: string) => getContent(workspaceId, tabId)

beforeEach(async () => {
  resetContentStoreForTests()
  setStorageNamespace(null)
  // Each test starts from an empty store: earlier tests' records would otherwise be swept here.
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase("hubble-resources")
    request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined)
  })
})
afterEach(() => setStorageNamespace(null))

describe("content follows its tab out of a project", () => {
  /** The content of tabs that left: kept for the session (Undo can bring the tab back), gone after the next load. */
  async function expectKeptThenSwept(view: ReturnType<typeof mount>, gone: [string, string][], kept: [string, string][]) {
    await sleep(GRACE * 3)
    for (const [workspaceId, tabId] of gone) expect(await stored(workspaceId, tabId)).toBeDefined()
    view.unmount()
    const next = mount() // the next page load
    await waitFor(async () => {
      for (const [workspaceId, tabId] of gone) expect(await stored(workspaceId, tabId)).toBeUndefined()
    })
    for (const [workspaceId, tabId] of kept) expect(await stored(workspaceId, tabId)).toBeDefined()
    next.unmount()
  }

  it("Remove on a resource card: unsearchable at once, kept while Undo is possible, swept on the next load", async () => {
    const { video, pdf, other } = await seed()
    const view = mount()
    view.set(updateWorkspaceTabs(store, "physics", store.workspaces[0]!.tabs.filter((tab) => tab.id !== video.id)))
    // Search runs over the project's current tabs: gone from results at once, whatever is still stored.
    const contents = new Map([[video.id, (await stored("physics", video.id))!]])
    expect(searchProject({ query: "gravitational", tabs: store.workspaces[0]!.tabs, contents })).toEqual([])
    await expectKeptThenSwept(view, [["physics", video.id]], [["physics", pdf.id], ["chem", other.id]])
  })

  it("delete selected and Clean up in the tab view, and Delete in the graph (removeTabs)", async () => {
    const { video, pdf, other } = await seed()
    const view = mount()
    view.set(updateWorkspaceTabs(store, "physics", removeTabs(store.workspaces[0]!.tabs, [video.id, pdf.id])))
    await expectKeptThenSwept(view, [["physics", video.id], ["physics", pdf.id]], [["chem", other.id]])
  })

  it("Clear", async () => {
    const { video, pdf, other } = await seed()
    const view = mount()
    view.set(updateWorkspaceTabs(store, "physics", []))
    await expectKeptThenSwept(view, [["physics", video.id], ["physics", pdf.id]], [["chem", other.id]])
  })

  it("deleting a subject (the shell also prunes it at once)", async () => {
    const { video, other } = await seed()
    const view = mount()
    view.set(deleteWorkspace(store, "physics"))
    await expectKeptThenSwept(view, [["physics", video.id]], [["chem", other.id]])
  })

  it("a deletion synced from another device (the whole store replaced)", async () => {
    const { video, pdf } = await seed()
    const view = mount()
    const synced = JSON.parse(JSON.stringify(store)) as WorkspaceStore
    synced.workspaces[0]!.tabs = synced.workspaces[0]!.tabs.filter((tab) => tab.id !== video.id)
    view.set(synced)
    await expectKeptThenSwept(view, [["physics", video.id]], [["physics", pdf.id]])
  })

  it("Undo long after the removal — a toast paused while the window was hidden — still restores the content", async () => {
    const { video } = await seed()
    const view = mount()
    const before = store
    view.set(updateWorkspaceTabs(store, "physics", store.workspaces[0]!.tabs.filter((tab) => tab.id !== video.id)))
    await sleep(GRACE * 4)
    view.set(before)
    expect((await stored("physics", video.id))?.transcript).toEqual([{ start: 522, text: "Gravitational potential energy." }])
    // …and a reload with the tab restored keeps it.
    view.unmount()
    const next = mount()
    await sleep(GRACE * 3)
    expect(await stored("physics", video.id)).toBeDefined()
    next.unmount()
  })

  it("moving a video to another subject carries its transcript, so it stays searchable there", async () => {
    const { video, other } = await seed()
    const view = mount()
    view.set(moveTabsBetweenWorkspaces(store, [video.id], "chem").store)
    await waitFor(async () => expect((await stored("chem", video.id))?.transcript).toEqual([{ start: 522, text: "Gravitational potential energy." }]))
    expect(await stored("physics", video.id)).toBeUndefined()
    expect(await stored("chem", other.id)).toBeDefined()
    await sleep(GRACE * 3)
    expect(await stored("chem", video.id)).toBeDefined()
    view.unmount()
  })

  it("the load sweep never acts for an account that is no longer signed in", async () => {
    const { video } = await seed()
    store = updateWorkspaceTabs(store, "physics", store.workspaces[0]!.tabs.filter((tab) => tab.id !== video.id))
    const view = mount() // a load with the video already gone: its sweep is pending
    setStorageNamespace("someone-else")
    await sleep(GRACE * 3)
    setStorageNamespace(null)
    expect(await stored("physics", video.id)).toBeDefined()
    view.unmount()
  })
})

describe("pruneContentExcept", () => {
  it("removes only this account's records for tabs that exist nowhere, and is idempotent", async () => {
    await putContent("a", "keep", { kind: "webpage", text: "keep", extractedAt: 1 })
    await putContent("a", "gone", { kind: "webpage", text: "gone", extractedAt: 1 })
    await putContent("deleted-subject", "x", { kind: "webpage", text: "x", extractedAt: 1 })
    setStorageNamespace("other-account")
    await putContent("a", "gone", { kind: "webpage", text: "theirs", extractedAt: 1 })
    setStorageNamespace(null)

    const present = new Map([["a", new Set(["keep"])]])
    expect(await pruneContentExcept(present)).toBe(2)
    expect(await pruneContentExcept(present)).toBe(0)
    expect(await getContent("a", "keep")).toBeDefined()
    expect(await getContent("a", "gone")).toBeUndefined()
    expect(await getContent("deleted-subject", "x")).toBeUndefined()
    setStorageNamespace("other-account")
    expect((await getContent("a", "gone"))?.text).toBe("theirs")
  })
})
