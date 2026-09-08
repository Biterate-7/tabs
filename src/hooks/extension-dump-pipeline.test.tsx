/**
 * The whole dump pipeline, end to end, with nothing between the pieces
 * faked: the extension's real background service worker, its real content
 * script, and the real <AppShell/> — wired together through a chrome.* mock
 * that only stands in for the browser itself (tab creation, the
 * tabs.sendMessage transport, storage.session).
 *
 * It exists because every layer's own unit tests passed while the product
 * was broken for every user who wasn't the developer. The reason they could
 * all pass is that each half asserted on its own edge of the boundary —
 * background.js proved it called chrome.tabs.sendMessage, the app proved it
 * handled a `message` event someone else dispatched — and the bug lived
 * precisely in the ordering *between* them, which nothing owned.
 *
 * The scenario reproduced below is the reported one exactly:
 *
 *   fresh profile → no TabDump tab open → click Dump → a tab is created →
 *   Chrome reports it `complete` → the extension delivers → and only THEN
 *   does React finish hydrating and attach its listener.
 *
 * That ordering is not a contrived worst case, it is the norm: measured
 * against a production build served over localhost on a fast machine, the
 * app's import listener attaches between 1ms and 105ms after the load event,
 * i.e. always after the moment the extension fires. A developer's own
 * machine escaped it only by having a warm, already-hydrated TabDump tab for
 * the extension to reuse.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { loadWorkspaceStore } from "@/lib/workspace/persistence"

vi.mock("@/lib/browser/history", () => ({ fetchBrowserHistory: vi.fn() }))

const MSG_DUMP_TABS = "DUMP_TABS"

type Listener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => unknown

let allListeners: Listener[]
let contentScriptListeners: Listener[]
let sessionStore: Record<string, unknown>
let onUpdatedListeners: ((tabId: number, changeInfo: { status?: string }) => void)[]
let onRemovedListeners: ((tabId: number) => void)[]
let openTabDumpTabs: { id: number; windowId: number; url: string; active?: boolean }[]
let createdTabId: number | undefined

function browserTabs(urls: string[]) {
  return urls.map((url, i) => ({ id: i + 1, windowId: 1, url, title: `Tab ${i}`, status: "complete", index: i }))
}

/**
 * Chrome's own transport between the service worker and a tab's content
 * script, including the part that matters: a listener returning `true` keeps
 * the channel open, so the promise resolves only when that listener actually
 * calls sendResponse. Faking this synchronously would fake away the delay
 * the ack handshake depends on.
 */
function deliverToContentScript(message: unknown) {
  return new Promise((resolve) => {
    let keptOpen = false
    let responded = false
    for (const listener of contentScriptListeners) {
      const kept = listener(message, {}, (response?: unknown) => {
        responded = true
        resolve(response)
      })
      if (kept === true) keptOpen = true
    }
    if (!keptOpen && !responded) resolve(undefined)
  })
}

beforeEach(() => {
  window.localStorage.clear()
  // Every test here is a fresh tab. content-script.js marks its isolated
  // world once so a chrome.scripting repair injection into a tab that already
  // has a copy stays inert, but jsdom reuses one window across the file — so
  // without clearing the mark, every test after the first would boot an
  // intentionally dead content script.
  delete (window as { __tabdumpBridgeRegistered?: boolean }).__tabdumpBridgeRegistered
  allListeners = []
  contentScriptListeners = []
  sessionStore = {}
  onUpdatedListeners = []
  onRemovedListeners = []
  openTabDumpTabs = []
  createdTabId = undefined
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      onMessage: { addListener: (fn: Listener) => allListeners.push(fn) },
      sendMessage: vi.fn(),
    },
    tabs: {
      query: vi.fn(async (query: { currentWindow?: boolean; url?: string }) => {
        if (query.currentWindow) return browserTabs(["https://a.example/one", "https://b.example/two", "chrome://settings"])
        if (query.url) return openTabDumpTabs
        return []
      }),
      create: vi.fn(async ({ url }: { url: string }) => {
        createdTabId = 500
        openTabDumpTabs = [{ id: 500, windowId: 9, url, active: false }]
        return { id: 500, windowId: 9, url, active: false }
      }),
      update: vi.fn(async () => ({})),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => deliverToContentScript(message)),
      onUpdated: {
        addListener: (fn: (tabId: number, changeInfo: { status?: string }) => void) => onUpdatedListeners.push(fn),
        removeListener: (fn: unknown) => {
          onUpdatedListeners = onUpdatedListeners.filter((l) => l !== fn)
        },
      },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => onRemovedListeners.push(fn),
        removeListener: (fn: unknown) => {
          onRemovedListeners = onRemovedListeners.filter((l) => l !== fn)
        },
      },
    },
    windows: { update: vi.fn(async () => ({})) },
    // Present so background.js's missing-receiver repair is reachable here
    // exactly as it is in Chrome. This pipeline delivers through a live
    // content script, so it should never actually need to fire.
    scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items)
        }),
      },
    },
  }
})

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
  vi.resetModules()
})

/** Loads the service worker, then the content script, keeping their listener sets apart. */
async function bootExtension() {
  const background = await import("../../extension/background/background.js")
  const backgroundListenerCount = allListeners.length
  // Not an ES module, deliberately: a manifest-declared content script is
  // loaded as a classic script, so content-script.js has no imports or
  // exports to make it one. Importing it here is exactly the side effect
  // this test wants (its listeners registering), which is what TypeScript
  // objects to and what the runtime is fine with.
  // @ts-expect-error -- classic script, imported for its side effects only
  await import("../../extension/content/content-script.js")
  contentScriptListeners = allListeners.slice(backgroundListenerCount)
  return { dumpListener: allListeners[0], background }
}

function startDump(dumpListener: Listener) {
  return new Promise<Record<string, unknown>>((resolve) => {
    dumpListener({ type: MSG_DUMP_TABS, payload: {} }, {}, (response?: unknown) =>
      resolve(response as Record<string, unknown>)
    )
  })
}

/** Chrome reporting the freshly created tab finished loading — the instant the extension delivers. */
async function fireTabComplete() {
  await vi.waitFor(() => expect(onUpdatedListeners.length).toBeGreaterThan(0))
  for (const listener of [...onUpdatedListeners]) listener(createdTabId!, { status: "complete" })
}

async function mountApp() {
  const { AppShell } = await import("@/components/app-shell")
  render(<AppShell />)
}

describe("fresh-profile dump, end to end", () => {
  it("lands the tabs in the workspace even though the page finishes hydrating after the payload was already delivered", async () => {
    const { dumpListener } = await bootExtension()

    // The popup clicks Dump. No TabDump tab is open, so one gets created.
    const responsePromise = startDump(dumpListener)
    await fireTabComplete()

    // The payload has now been posted into a document where React has not
    // mounted anything yet. Under the old fire-and-forget relay this is the
    // exact moment the dump was lost — and reported as a success.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(loadWorkspaceStore()).toBeNull()

    // Hydration finally completes.
    await mountApp()

    const response = await responsePromise
    expect(response).toMatchObject({
      ok: true,
      status: "done",
      count: 2,
      accepted: 2,
      skippedRestricted: 1,
      focusTabId: 500,
    })

    // Not just "the extension thinks it worked" — the app really left the
    // empty landing page for the workspace view, and the tabs are really
    // persisted for the next visit.
    expect(await screen.findByPlaceholderText("Search tabs...")).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Paste your tabs/)).toBeNull()

    await vi.waitFor(() => {
      const persisted = loadWorkspaceStore()
      expect(persisted?.workspaces[0].tabs.map((t) => t.url).sort()).toEqual([
        "https://a.example/one",
        "https://b.example/two",
      ])
    })
  })

  it("reports a real failure — never a success — when the page never becomes able to ingest", async () => {
    vi.useFakeTimers()
    try {
      const { dumpListener } = await bootExtension()

      const responsePromise = startDump(dumpListener)
      await vi.waitFor(() => expect(onUpdatedListeners.length).toBeGreaterThan(0))
      for (const listener of [...onUpdatedListeners]) listener(500, { status: "complete" })

      // No app ever mounts (a route with no app shell, a broken deployment,
      // a renderer crash). Let both ack deadlines and the fresh-tab fallback
      // run to completion.
      await vi.advanceTimersByTimeAsync(60_000)

      const response = await responsePromise
      expect(response.ok).toBe(false)
      expect(response.reason).toBe("page-not-ready")
      expect(loadWorkspaceStore()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("delivers straight through when the page was already hydrated and listening", async () => {
    const { dumpListener } = await bootExtension()
    await mountApp()
    // The page has announced readiness before any dump starts.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const responsePromise = startDump(dumpListener)
    await fireTabComplete()

    expect(await responsePromise).toMatchObject({ ok: true, accepted: 2 })
    expect(await screen.findByPlaceholderText("Search tabs...")).toBeTruthy()
  })

  // The content script re-posts a held batch on every readiness
  // announcement, and readiness can land while the ack for that same batch
  // is still in flight — so the page has to be idempotent per importId or a
  // single dump quietly doubles every tab in the workspace.
  it("imports a re-posted batch exactly once, no matter how the two signals interleave", async () => {
    const { dumpListener } = await bootExtension()

    const responsePromise = startDump(dumpListener)
    await fireTabComplete()
    // Mount at the moment the first post is still in flight, so readiness
    // and delivery race each other.
    await mountApp()

    expect(await responsePromise).toMatchObject({ ok: true, accepted: 2 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(loadWorkspaceStore()?.workspaces[0].tabs).toHaveLength(2)
  })

  it("leaves a terminal record in session storage for a popup that closed mid-dump to recover", async () => {
    const { dumpListener } = await bootExtension()

    startDump(dumpListener)
    await fireTabComplete()
    await mountApp()

    await vi.waitFor(() => {
      expect(sessionStore.tabdump_dump_state).toMatchObject({
        status: "done",
        ok: true,
        accepted: 2,
        phase: "finished",
      })
    })
  })

  it("merges a second dump into the workspace the first one created, without losing either", async () => {
    const first = await bootExtension()
    startDump(first.dumpListener)
    await fireTabComplete()
    await mountApp()
    await vi.waitFor(() => expect(loadWorkspaceStore()?.workspaces[0].tabs).toHaveLength(2))

    // A second dump against the now-open, already-hydrated tab.
    const secondResponse = await startDump(first.dumpListener)
    expect(secondResponse).toMatchObject({ ok: true, accepted: 2 })

    await vi.waitFor(() => {
      expect(loadWorkspaceStore()?.workspaces[0].tabs).toHaveLength(4)
    })
  })
})
