import { describe, expect, it, vi } from "vitest"
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
