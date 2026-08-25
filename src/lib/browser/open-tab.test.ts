import { afterEach, describe, expect, it, vi } from "vitest"

const isBrowserConnectedMock = vi.hoisted(() => vi.fn())
const sendBrowserCommandMock = vi.hoisted(() => vi.fn())
vi.mock("./bridge", () => ({
  isBrowserConnected: isBrowserConnectedMock,
  sendBrowserCommand: sendBrowserCommandMock,
}))

const toastInfoMock = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: { info: toastInfoMock } }))

const { openTab } = await import("./open-tab")

const windowOpenMock = vi.fn()
vi.stubGlobal("open", windowOpenMock)

afterEach(() => {
  isBrowserConnectedMock.mockReset()
  sendBrowserCommandMock.mockReset()
  toastInfoMock.mockReset()
  windowOpenMock.mockReset()
})

describe("openTab", () => {
  it("falls back to window.open when the extension isn't connected", async () => {
    isBrowserConnectedMock.mockReturnValue(false)
    await openTab("https://example.com")
    expect(sendBrowserCommandMock).not.toHaveBeenCalled()
    expect(windowOpenMock).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it("opens through the extension without a toast when the url wasn't already open", async () => {
    isBrowserConnectedMock.mockReturnValue(true)
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { tab: { tabId: 1 }, alreadyOpen: false } })
    await openTab("https://example.com")
    expect(sendBrowserCommandMock).toHaveBeenCalledWith("open_url", { url: "https://example.com" })
    expect(windowOpenMock).not.toHaveBeenCalled()
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it("shows an 'already open' toast and activates the existing tab instead of opening a new one", async () => {
    isBrowserConnectedMock.mockReturnValue(true)
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { tab: { tabId: 1 }, alreadyOpen: true } })
    await openTab("https://example.com")
    expect(windowOpenMock).not.toHaveBeenCalled()
    expect(toastInfoMock).toHaveBeenCalledWith("Already open", { description: "Taking you to the existing tab…" })
  })

  it("falls back to window.open when the extension is connected but the command fails", async () => {
    isBrowserConnectedMock.mockReturnValue(true)
    sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "Timed out." })
    await openTab("https://example.com")
    expect(windowOpenMock).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
    expect(toastInfoMock).not.toHaveBeenCalled()
  })
})
