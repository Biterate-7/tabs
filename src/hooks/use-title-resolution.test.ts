import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useTitleResolution } from "./use-title-resolution"
import { getCachedTitle, recordFailure, recordSuccess, shouldSkipResolution } from "@/lib/titles/client/cache"
import { requestTitles } from "@/lib/titles/client/queue"
import type { Tab } from "@/lib/tabs/types"

vi.mock("@/lib/titles/client/cache", () => ({
  getCachedTitle: vi.fn(),
  shouldSkipResolution: vi.fn(),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}))

vi.mock("@/lib/titles/client/queue", () => ({
  requestTitles: vi.fn(),
}))

function makeTab(over: Partial<Tab> & { id: string; normalizedUrl: string }): Tab {
  return {
    url: over.normalizedUrl,
    domain: "example.com",
    category: "other",
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCachedTitle).mockReturnValue(null)
  vi.mocked(shouldSkipResolution).mockReturnValue(false)
  vi.mocked(requestTitles).mockResolvedValue([])
})

describe("useTitleResolution", () => {
  it("applies a cache hit synchronously without calling requestTitles", async () => {
    vi.mocked(getCachedTitle).mockReturnValue({ title: "Cached Title", source: "generic" })
    const onResolved = vi.fn()
    const tab = makeTab({ id: "1", normalizedUrl: "https://example.com/a" })

    renderHook(() => useTitleResolution([tab], onResolved))

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith([{ ...tab, title: "Cached Title" }]))
    expect(requestTitles).not.toHaveBeenCalled()
  })

  it("requests titles for tabs missing one and patches successful results in", async () => {
    const tab = makeTab({ id: "1", normalizedUrl: "https://example.com/a" })
    vi.mocked(requestTitles).mockResolvedValue([
      { url: "https://example.com/a", ok: true, title: "Resolved Title", source: "generic" },
    ])
    const onResolved = vi.fn()

    renderHook(() => useTitleResolution([tab], onResolved))

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith([{ ...tab, title: "Resolved Title" }])
    )
    expect(recordSuccess).toHaveBeenCalledWith("https://example.com/a", "Resolved Title", "generic")
  })

  it("records a failure without patching a title, and does not call onResolved when nothing changed", async () => {
    const tab = makeTab({ id: "1", normalizedUrl: "https://example.com/a" })
    vi.mocked(requestTitles).mockResolvedValue([
      { url: "https://example.com/a", ok: false, reason: "no-title", permanent: true },
    ])
    const onResolved = vi.fn()

    renderHook(() => useTitleResolution([tab], onResolved))

    await waitFor(() => expect(recordFailure).toHaveBeenCalledWith("https://example.com/a", true))
    expect(onResolved).not.toHaveBeenCalled()
  })

  it("skips tabs already in a permanent-failure cooldown", () => {
    vi.mocked(shouldSkipResolution).mockReturnValue(true)
    const tab = makeTab({ id: "1", normalizedUrl: "https://example.com/a" })

    renderHook(() => useTitleResolution([tab], vi.fn()))

    expect(requestTitles).not.toHaveBeenCalled()
  })

  it("does not skip tabs that already have a title", () => {
    const tab = makeTab({ id: "1", normalizedUrl: "https://example.com/a", title: "Already Has One" })

    renderHook(() => useTitleResolution([tab], vi.fn()))

    expect(requestTitles).not.toHaveBeenCalled()
    expect(getCachedTitle).not.toHaveBeenCalled()
  })

  it("does not re-request a URL it has already attempted, even if the tab still has no title", async () => {
    const tab = makeTab({ id: "1", normalizedUrl: "https://example.com/a" })
    vi.mocked(requestTitles).mockResolvedValue([
      { url: "https://example.com/a", ok: false, reason: "network-error", permanent: false },
    ])
    const onResolved = vi.fn()

    const { rerender } = renderHook(({ tabs }) => useTitleResolution(tabs, onResolved), {
      initialProps: { tabs: [tab] },
    })

    await waitFor(() => expect(requestTitles).toHaveBeenCalledTimes(1))

    // Same tab, still no title (as if the parent re-rendered for an unrelated reason).
    rerender({ tabs: [{ ...tab }] })

    expect(requestTitles).toHaveBeenCalledTimes(1)
  })

  it("deduplicates multiple tabs sharing the same normalizedUrl into one request", () => {
    const tabA = makeTab({ id: "1", normalizedUrl: "https://example.com/a" })
    const tabB = makeTab({ id: "2", normalizedUrl: "https://example.com/a" })

    renderHook(() => useTitleResolution([tabA, tabB], vi.fn()))

    expect(requestTitles).toHaveBeenCalledTimes(1)
    expect(requestTitles).toHaveBeenCalledWith(["https://example.com/a"])
  })
})
