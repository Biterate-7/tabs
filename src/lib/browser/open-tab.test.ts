import { afterEach, describe, expect, it, vi } from "vitest"

const isBrowserConnectedMock = vi.hoisted(() => vi.fn())
const sendBrowserCommandMock = vi.hoisted(() => vi.fn())
vi.mock("./bridge", () => ({
  isBrowserConnected: isBrowserConnectedMock,
  sendBrowserCommand: sendBrowserCommandMock,
}))

const toastInfoMock = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: { info: toastInfoMock } }))

// `isDesktop` defaults to falsy under mockReset(), so every case below that
// doesn't opt in exercises the web paths exactly as it did before the
// desktop app existed.
const isDesktopMock = vi.hoisted(() => vi.fn())
const openExternalMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/platform", () => ({
  isDesktop: isDesktopMock,
  openExternal: openExternalMock,
}))

const { openTab } = await import("./open-tab")

const windowOpenMock = vi.fn()
vi.stubGlobal("open", windowOpenMock)

// jsdom's window.location.assign is neither writable nor configurable, so
// neither plain reassignment nor vi.spyOn can replace it directly — stub the
// whole `location` object instead (Object.defineProperty on `window` itself
// works fine).
const locationAssignMock = vi.fn()
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, assign: locationAssignMock },
})

afterEach(() => {
  isBrowserConnectedMock.mockReset()
  sendBrowserCommandMock.mockReset()
  toastInfoMock.mockReset()
  windowOpenMock.mockReset()
  locationAssignMock.mockReset()
  isDesktopMock.mockReset()
  openExternalMock.mockReset()
})

describe("openTab", () => {
  describe("default (reuse the current tab)", () => {
    it("falls back to navigating the current tab when the extension isn't connected", async () => {
      isBrowserConnectedMock.mockReturnValue(false)
      await openTab("https://example.com")
      expect(sendBrowserCommandMock).not.toHaveBeenCalled()
      expect(locationAssignMock).toHaveBeenCalledWith("https://example.com")
      expect(windowOpenMock).not.toHaveBeenCalled()
      expect(toastInfoMock).not.toHaveBeenCalled()
    })

    it("asks the extension to reuse the current tab, and does not open/navigate locally when that succeeds", async () => {
      isBrowserConnectedMock.mockReturnValue(true)
      sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { tab: { tabId: 1 }, alreadyOpen: false } })
      await openTab("https://example.com")
      expect(sendBrowserCommandMock).toHaveBeenCalledWith("open_url", {
        url: "https://example.com",
        reuseCurrentTab: true,
      })
      expect(windowOpenMock).not.toHaveBeenCalled()
      expect(locationAssignMock).not.toHaveBeenCalled()
      expect(toastInfoMock).not.toHaveBeenCalled()
    })

    it("shows an 'already open' toast and activates the existing tab instead of navigating the current one", async () => {
      isBrowserConnectedMock.mockReturnValue(true)
      sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { tab: { tabId: 1 }, alreadyOpen: true } })
      await openTab("https://example.com")
      expect(windowOpenMock).not.toHaveBeenCalled()
      expect(locationAssignMock).not.toHaveBeenCalled()
      expect(toastInfoMock).toHaveBeenCalledWith("Already open", { description: "Taking you to the existing tab…" })
    })

    it("falls back to navigating the current tab when the extension is connected but the command fails", async () => {
      isBrowserConnectedMock.mockReturnValue(true)
      sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "Timed out." })
      await openTab("https://example.com")
      expect(locationAssignMock).toHaveBeenCalledWith("https://example.com")
      expect(windowOpenMock).not.toHaveBeenCalled()
      expect(toastInfoMock).not.toHaveBeenCalled()
    })
  })

  describe("{ newTab: true } (e.g. opening several urls at once)", () => {
    it("falls back to window.open, not current-tab navigation, when the extension isn't connected", async () => {
      isBrowserConnectedMock.mockReturnValue(false)
      await openTab("https://example.com", { newTab: true })
      expect(sendBrowserCommandMock).not.toHaveBeenCalled()
      expect(windowOpenMock).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
      expect(locationAssignMock).not.toHaveBeenCalled()
    })

    it("tells the extension not to reuse the current tab", async () => {
      isBrowserConnectedMock.mockReturnValue(true)
      sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: true, result: { tab: { tabId: 1 }, alreadyOpen: false } })
      await openTab("https://example.com", { newTab: true })
      expect(sendBrowserCommandMock).toHaveBeenCalledWith("open_url", {
        url: "https://example.com",
        reuseCurrentTab: false,
      })
      expect(windowOpenMock).not.toHaveBeenCalled()
    })

    it("falls back to window.open when the extension is connected but the command fails", async () => {
      isBrowserConnectedMock.mockReturnValue(true)
      sendBrowserCommandMock.mockResolvedValue({ id: "1", ok: false, error: "Timed out." })
      await openTab("https://example.com", { newTab: true })
      expect(windowOpenMock).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
      expect(locationAssignMock).not.toHaveBeenCalled()
    })
  })
})

describe("on the desktop app", () => {
  it("opens a saved tab in the default browser instead of navigating the app window", async () => {
    isDesktopMock.mockReturnValue(true)
    isBrowserConnectedMock.mockReturnValue(false)

    await openTab("https://example.com/saved")

    expect(openExternalMock).toHaveBeenCalledWith("https://example.com/saved")
    // The three things that would turn the desktop window into a browser.
    expect(locationAssignMock).not.toHaveBeenCalled()
    expect(windowOpenMock).not.toHaveBeenCalled()
    expect(sendBrowserCommandMock).not.toHaveBeenCalled()
  })

  it("does the same for newTab flows like 'open selected'", async () => {
    isDesktopMock.mockReturnValue(true)

    await openTab("https://example.com/one", { newTab: true })

    expect(openExternalMock).toHaveBeenCalledWith("https://example.com/one")
    expect(windowOpenMock).not.toHaveBeenCalled()
    expect(locationAssignMock).not.toHaveBeenCalled()
  })

  it("ignores the extension bridge entirely, which cannot reach a Tauri webview anyway", async () => {
    isDesktopMock.mockReturnValue(true)
    // Even if something claimed a connection, desktop must not route through it.
    isBrowserConnectedMock.mockReturnValue(true)

    await openTab("https://example.com/x")

    expect(sendBrowserCommandMock).not.toHaveBeenCalled()
    expect(openExternalMock).toHaveBeenCalledTimes(1)
  })
})
