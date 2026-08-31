import { afterEach, describe, expect, it, vi } from "vitest"

const sendBrowserCommandMock = vi.hoisted(() => vi.fn())
vi.mock("./bridge", () => ({ sendBrowserCommand: sendBrowserCommandMock }))

const { fetchBrowserHistory } = await import("./history")

afterEach(() => {
  sendBrowserCommandMock.mockReset()
})

describe("fetchBrowserHistory", () => {
  it("sends a get_history command with the given range", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { items: [] } })
    await fetchBrowserHistory(1000, 2000, 500)
    expect(sendBrowserCommandMock).toHaveBeenCalledWith(
      "get_history",
      { startTime: 1000, endTime: 2000, maxResults: 500 },
      { timeoutMs: expect.any(Number) }
    )
  })

  it("resolves with the returned items on success", async () => {
    const items = [{ url: "https://a.example", title: "A", lastVisitTime: 1000, visitCount: 2, historyItemId: "1" }]
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { items } })
    const result = await fetchBrowserHistory(0)
    expect(result).toEqual({ ok: true, items })
  })

  it("reports not-connected when the bridge times out", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "Timed out waiting for the browser extension to respond." })
    const result = await fetchBrowserHistory(0)
    expect(result).toEqual({ ok: false, reason: "not-connected" })
  })

  it("reports not-connected when the extension is unreachable", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "extension-unreachable" })
    const result = await fetchBrowserHistory(0)
    expect(result).toEqual({ ok: false, reason: "not-connected" })
  })

  it("reports a generic error for any other failure", async () => {
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "Unknown or disallowed browser action." })
    const result = await fetchBrowserHistory(0)
    expect(result).toEqual({ ok: false, reason: "error", error: "Unknown or disallowed browser action." })
  })
})
