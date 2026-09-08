import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useExtensionImport } from "./use-extension-import"

function postFromContentScript(data: unknown, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: window }))
}

describe("useExtensionImport", () => {
  it("calls onImport with valid entries from a well-formed message", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: { tabs: [{ url: "https://github.com/a", title: "A repo", pinned: true }] },
    })

    expect(onImport).toHaveBeenCalledWith([
      { url: "https://github.com/a", title: "A repo", pinned: true },
    ])
  })

  it("ignores messages from a different origin", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    postFromContentScript(
      { source: "tabdump-extension", type: "TABDUMP_IMPORT", payload: { tabs: [{ url: "https://a.example" }] } },
      "https://evil.example"
    )

    expect(onImport).not.toHaveBeenCalled()
  })

  it("ignores messages with the wrong source tag", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    postFromContentScript({
      source: "some-other-extension",
      type: "TABDUMP_IMPORT",
      payload: { tabs: [{ url: "https://a.example" }] },
    })

    expect(onImport).not.toHaveBeenCalled()
  })

  it("ignores messages with the wrong type", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    postFromContentScript({
      source: "tabdump-extension",
      type: "SOMETHING_ELSE",
      payload: { tabs: [{ url: "https://a.example" }] },
    })

    expect(onImport).not.toHaveBeenCalled()
  })

  it("ignores completely malformed message data without throwing", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    expect(() => postFromContentScript(null)).not.toThrow()
    expect(() => postFromContentScript("just a string")).not.toThrow()
    expect(() => postFromContentScript({ source: "tabdump-extension" })).not.toThrow()
    expect(() =>
      postFromContentScript({ source: "tabdump-extension", type: "TABDUMP_IMPORT", payload: {} })
    ).not.toThrow()
    expect(() =>
      postFromContentScript({
        source: "tabdump-extension",
        type: "TABDUMP_IMPORT",
        payload: { tabs: "not an array" },
      })
    ).not.toThrow()

    expect(onImport).not.toHaveBeenCalled()
  })

  it("filters out individually invalid entries but keeps valid ones from the same batch", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: {
        tabs: [
          { url: "https://a.example" },
          { url: 123 }, // malformed: url must be a string
          { title: "no url at all" },
          { url: "https://b.example", pinned: "not-a-boolean" }, // malformed pinned
        ],
      },
    })

    expect(onImport).toHaveBeenCalledWith([{ url: "https://a.example" }])
  })

  it("does not call onImport for an empty tabs array", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    postFromContentScript({ source: "tabdump-extension", type: "TABDUMP_IMPORT", payload: { tabs: [] } })

    expect(onImport).not.toHaveBeenCalled()
  })

  it("truncates an oversized batch instead of processing it in full", () => {
    const onImport = vi.fn()
    renderHook(() => useExtensionImport(onImport))

    const tabs = Array.from({ length: 600 }, (_, i) => ({ url: `https://example.com/${i}` }))
    postFromContentScript({ source: "tabdump-extension", type: "TABDUMP_IMPORT", payload: { tabs } })

    expect(onImport).toHaveBeenCalledOnce()
    expect(onImport.mock.calls[0][0]).toHaveLength(500)
  })

  it("stops listening after unmount", () => {
    const onImport = vi.fn()
    const { unmount } = renderHook(() => useExtensionImport(onImport))
    unmount()

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: { tabs: [{ url: "https://a.example" }] },
    })

    expect(onImport).not.toHaveBeenCalled()
  })
})

/**
 * The page's half of the import handshake. Its purpose is that the extension
 * can tell "the app took these tabs" from "a content script accepted the
 * message" — the distinction the whole cross-machine dump failure turned on,
 * since the app's `message` listener attaches strictly after the load event
 * and the extension delivers at exactly that moment.
 */
describe("useExtensionImport handshake", () => {
  type PostedMessage = { type?: string; payload?: Record<string, unknown> }
  let posted: PostedMessage[]
  const realPostMessage = window.postMessage

  function postedMessages() {
    return posted
  }

  beforeEach(() => {
    posted = []
    window.postMessage = ((data: unknown) => {
      posted.push(data as PostedMessage)
    }) as typeof window.postMessage
  })

  afterEach(() => {
    window.postMessage = realPostMessage
  })

  it("announces readiness as soon as the app can ingest, and not before", () => {
    const { rerender } = renderHook(({ ready }) => useExtensionImport(() => 0, ready), {
      initialProps: { ready: false },
    })

    expect(postedMessages().some((m) => m.type === "TABDUMP_PAGE_READY")).toBe(false)

    rerender({ ready: true })
    expect(postedMessages().some((m) => m.type === "TABDUMP_PAGE_READY")).toBe(true)
  })

  it("acks a batch with the count the app actually accepted, not the count it was sent", () => {
    const onImport = vi.fn().mockReturnValue(2)
    renderHook(() => useExtensionImport(onImport, true))

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: {
        importId: "imp-1",
        tabs: [{ url: "https://a.example" }, { url: "https://b.example" }, { url: "https://c.example" }],
      },
    })

    expect(postedMessages()).toContainEqual(
      expect.objectContaining({ type: "TABDUMP_IMPORT_ACK", payload: { importId: "imp-1", accepted: 2 } })
    )
  })

  it("acks zero rather than staying silent when nothing usable came through", () => {
    renderHook(() => useExtensionImport(() => 0, true))

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: { importId: "imp-2", tabs: [{ url: 123 }] },
    })

    expect(postedMessages()).toContainEqual(
      expect.objectContaining({ type: "TABDUMP_IMPORT_ACK", payload: { importId: "imp-2", accepted: 0 } })
    )
  })

  // Declining without acking is what lets the content script hold the batch
  // and re-deliver it on TABDUMP_PAGE_READY. Acking here — or worse,
  // importing into a store that isn't loaded — is what silently lost dumps.
  it("neither imports nor acks while the app still can't ingest", () => {
    const onImport = vi.fn().mockReturnValue(1)
    renderHook(() => useExtensionImport(onImport, false))

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: { importId: "imp-3", tabs: [{ url: "https://a.example" }] },
    })

    expect(onImport).not.toHaveBeenCalled()
    expect(postedMessages().some((m) => m.type === "TABDUMP_IMPORT_ACK")).toBe(false)
  })

  it("imports and acks the re-delivered batch once it becomes ready", () => {
    const onImport = vi.fn().mockReturnValue(1)
    const { rerender } = renderHook(({ ready }) => useExtensionImport(onImport, ready), {
      initialProps: { ready: false },
    })

    const batch = {
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: { importId: "imp-4", tabs: [{ url: "https://a.example" }] },
    }
    postFromContentScript(batch)
    expect(onImport).not.toHaveBeenCalled()

    rerender({ ready: true })
    postFromContentScript(batch) // the content script's re-delivery

    expect(onImport).toHaveBeenCalledOnce()
    expect(postedMessages()).toContainEqual(
      expect.objectContaining({ type: "TABDUMP_IMPORT_ACK", payload: { importId: "imp-4", accepted: 1 } })
    )
  })

  it("does not ack a batch that arrived without an importId (nothing to correlate it to)", () => {
    renderHook(() => useExtensionImport(() => 1, true))

    postFromContentScript({
      source: "tabdump-extension",
      type: "TABDUMP_IMPORT",
      payload: { tabs: [{ url: "https://a.example" }] },
    })

    expect(postedMessages().some((m) => m.type === "TABDUMP_IMPORT_ACK")).toBe(false)
  })
})
