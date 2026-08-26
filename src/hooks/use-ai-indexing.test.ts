import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useAiIndexing } from "./use-ai-indexing"
import { indexWorkspace } from "@/lib/ai/indexer"
import type { Tab } from "@/lib/tabs/types"

vi.mock("@/lib/ai/indexer", () => ({
  indexWorkspace: vi.fn(),
}))

function makeTab(id: string): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", category: "other" }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(indexWorkspace).mockResolvedValue(undefined)
})

describe("useAiIndexing", () => {
  it("does not index when disabled — AI indexing is a fallback, never automatic", () => {
    renderHook(() => useAiIndexing("ws-1", [makeTab("a")], false))
    expect(indexWorkspace).not.toHaveBeenCalled()
  })

  it("indexes once enabled", async () => {
    renderHook(() => useAiIndexing("ws-1", [makeTab("a")], true))
    await waitFor(() => expect(indexWorkspace).toHaveBeenCalledWith("ws-1", [makeTab("a")], expect.any(Function)))
  })

  it("starts indexing once a previously-disabled hook becomes enabled", async () => {
    const tabs = [makeTab("a")]
    const { rerender } = renderHook(({ enabled }) => useAiIndexing("ws-1", tabs, enabled), {
      initialProps: { enabled: false },
    })
    expect(indexWorkspace).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await waitFor(() => expect(indexWorkspace).toHaveBeenCalledTimes(1))
  })

  it("does not start a new run when re-rendered while still disabled", () => {
    const tabs = [makeTab("a")]
    const { rerender } = renderHook(({ enabled }) => useAiIndexing("ws-1", tabs, enabled), {
      initialProps: { enabled: false },
    })
    rerender({ enabled: false })
    rerender({ enabled: false })
    expect(indexWorkspace).not.toHaveBeenCalled()
  })
})
