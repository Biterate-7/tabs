import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useExtensionWorkspaceQuery } from "./use-extension-workspace-query"
import type { Tab } from "@/lib/tabs/types"

function makeTab(over: Partial<Tab> & { id: string; normalizedUrl: string }): Tab {
  return { url: over.normalizedUrl, domain: "example.com", ...over }
}

function postFromContentScript(data: unknown, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: window }))
}

function askForReply(fn: () => void): Promise<MessageEvent> {
  return new Promise((resolve) => {
    // Filters for the RESULT type specifically: `fn()` itself dispatches a
    // synchronous "message" event (the request), which this same listener
    // would otherwise also observe before the hook's own async
    // `window.postMessage` reply ever arrives.
    function handler(event: Event) {
      const data = (event as MessageEvent).data as { type?: unknown } | null
      if (!data || data.type !== "TABDUMP_CHECK_IMPORTED_RESULT") return
      window.removeEventListener("message", handler)
      resolve(event as MessageEvent)
    }
    window.addEventListener("message", handler)
    fn()
  })
}

describe("useExtensionWorkspaceQuery", () => {
  it("replies with the subset of urls already present in the given tabs", async () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://github.com/a" }),
      makeTab({ id: "2", normalizedUrl: "https://example.com/b" }),
    ]
    renderHook(() => useExtensionWorkspaceQuery(tabs))

    const reply = await askForReply(() => {
      postFromContentScript({
        source: "tabdump-extension",
        type: "TABDUMP_CHECK_IMPORTED",
        payload: { requestId: "r1", urls: ["https://github.com/a", "https://new.example"] },
      })
    })

    expect(reply.data).toEqual({
      source: "tabdump-extension",
      type: "TABDUMP_CHECK_IMPORTED_RESULT",
      payload: { requestId: "r1", existingUrls: ["https://github.com/a"] },
    })
  })

  it("matches using normalization (tracking params, trailing slash) like the workspace's own dedup", async () => {
    const tabs = [makeTab({ id: "1", normalizedUrl: "https://example.com/page" })]
    renderHook(() => useExtensionWorkspaceQuery(tabs))

    const reply = await askForReply(() => {
      postFromContentScript({
        source: "tabdump-extension",
        type: "TABDUMP_CHECK_IMPORTED",
        payload: { requestId: "r2", urls: ["https://example.com/page/?utm_source=x"] },
      })
    })

    expect((reply.data as { payload: { existingUrls: string[] } }).payload.existingUrls).toEqual([
      "https://example.com/page/?utm_source=x",
    ])
  })

  it("returns an empty existingUrls list when nothing matches", async () => {
    renderHook(() => useExtensionWorkspaceQuery([]))

    const reply = await askForReply(() => {
      postFromContentScript({
        source: "tabdump-extension",
        type: "TABDUMP_CHECK_IMPORTED",
        payload: { requestId: "r3", urls: ["https://a.example", "https://b.example"] },
      })
    })

    expect((reply.data as { payload: { existingUrls: string[] } }).payload.existingUrls).toEqual([])
  })

  it("ignores an unparseable candidate url instead of throwing", async () => {
    const tabs = [makeTab({ id: "1", normalizedUrl: "https://a.example" })]
    renderHook(() => useExtensionWorkspaceQuery(tabs))

    const reply = await askForReply(() => {
      postFromContentScript({
        source: "tabdump-extension",
        type: "TABDUMP_CHECK_IMPORTED",
        payload: { requestId: "r4", urls: ["not a url", "https://a.example"] },
      })
    })

    expect((reply.data as { payload: { existingUrls: string[] } }).payload.existingUrls).toEqual([
      "https://a.example",
    ])
  })

  it("ignores messages from a different origin", () => {
    const postSpy = vi.spyOn(window, "postMessage")
    renderHook(() => useExtensionWorkspaceQuery([]))

    postFromContentScript(
      { source: "tabdump-extension", type: "TABDUMP_CHECK_IMPORTED", payload: { requestId: "r5", urls: [] } },
      "https://evil.example"
    )

    expect(postSpy).not.toHaveBeenCalled()
    postSpy.mockRestore()
  })

  it("ignores a malformed request without throwing", () => {
    renderHook(() => useExtensionWorkspaceQuery([]))

    expect(() => postFromContentScript(null)).not.toThrow()
    expect(() => postFromContentScript({ source: "tabdump-extension", type: "TABDUMP_CHECK_IMPORTED" })).not.toThrow()
    expect(() =>
      postFromContentScript({
        source: "tabdump-extension",
        type: "TABDUMP_CHECK_IMPORTED",
        payload: { requestId: 42, urls: [] },
      })
    ).not.toThrow()
  })

  it("stops listening after unmount", () => {
    const postSpy = vi.spyOn(window, "postMessage")
    const { unmount } = renderHook(() => useExtensionWorkspaceQuery([]))
    unmount()

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_CHECK_IMPORTED",
      payload: { requestId: "r6", urls: [] },
    })

    expect(postSpy).not.toHaveBeenCalled()
    postSpy.mockRestore()
  })

  it("always answers using the latest tabs without resubscribing the listener", async () => {
    const { rerender } = renderHook(({ tabs }) => useExtensionWorkspaceQuery(tabs), {
      initialProps: { tabs: [] as Tab[] },
    })

    rerender({ tabs: [makeTab({ id: "1", normalizedUrl: "https://fresh.example" })] })

    const reply = await askForReply(() => {
      postFromContentScript({
        source: "tabdump-extension",
        type: "TABDUMP_CHECK_IMPORTED",
        payload: { requestId: "r7", urls: ["https://fresh.example"] },
      })
    })

    expect((reply.data as { payload: { existingUrls: string[] } }).payload.existingUrls).toEqual([
      "https://fresh.example",
    ])
  })
})
