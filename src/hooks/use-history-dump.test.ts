import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

const fetchBrowserHistoryMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/browser/history", () => ({ fetchBrowserHistory: fetchBrowserHistoryMock }))

const { useHistoryDump } = await import("./use-history-dump")

afterEach(() => {
  fetchBrowserHistoryMock.mockReset()
})

describe("useHistoryDump", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useHistoryDump())
    expect(result.current.stage).toBe("idle")
  })

  it("moves through scanning to ready with built candidates on success", async () => {
    fetchBrowserHistoryMock.mockResolvedValue({
      ok: true,
      items: [{ url: "https://en.wikipedia.org/wiki/Tab", title: "Tab", lastVisitTime: Date.now(), visitCount: 3, historyItemId: "1" }],
    })
    const { result } = renderHook(() => useHistoryDump())

    await act(async () => {
      await result.current.scan("7d", new Set())
    })

    expect(result.current.stage).toBe("ready")
    expect(result.current.result?.candidates).toHaveLength(1)
    expect(result.current.result?.candidates[0].domain).toBe("en.wikipedia.org")
  })

  it("moves to error and reports not-connected when the extension is unavailable", async () => {
    fetchBrowserHistoryMock.mockResolvedValue({ ok: false, reason: "not-connected" })
    const { result } = renderHook(() => useHistoryDump())

    await act(async () => {
      await result.current.scan("7d", new Set())
    })

    expect(result.current.stage).toBe("error")
    expect(result.current.error).toEqual({ reason: "not-connected", message: undefined })
    expect(result.current.result).toBeNull()
  })

  it("reset returns to idle and clears any result/error", async () => {
    fetchBrowserHistoryMock.mockResolvedValue({ ok: false, reason: "error", error: "boom" })
    const { result } = renderHook(() => useHistoryDump())

    await act(async () => {
      await result.current.scan("7d", new Set())
    })
    expect(result.current.stage).toBe("error")

    act(() => result.current.reset())
    expect(result.current.stage).toBe("idle")
    expect(result.current.error).toBeNull()
    expect(result.current.result).toBeNull()
  })

  it("ignores a stale scan's response when a newer scan has already started", async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    fetchBrowserHistoryMock.mockImplementationOnce(() => first)
    fetchBrowserHistoryMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, items: [] })
    )

    const { result } = renderHook(() => useHistoryDump())

    let firstScanDone!: Promise<void>
    act(() => {
      firstScanDone = result.current.scan("today", new Set())
    })
    await act(async () => {
      await result.current.scan("7d", new Set())
    })
    expect(result.current.stage).toBe("ready")

    await act(async () => {
      resolveFirst({ ok: true, items: [{ url: "https://stale.example", title: "Stale", lastVisitTime: 1, visitCount: 1, historyItemId: "x" }] })
      await firstScanDone
    })

    // The stale first response must not have overwritten the second scan's ready result.
    expect(result.current.stage).toBe("ready")
    expect(result.current.result?.candidates ?? []).not.toContainEqual(expect.objectContaining({ domain: "stale.example" }))
  })
})
