import { afterEach, describe, expect, it, vi } from "vitest"

const isBrowserConnectedMock = vi.hoisted(() => vi.fn())
const sendBrowserCommandMock = vi.hoisted(() => vi.fn())
vi.mock("./bridge", () => ({
  isBrowserConnected: isBrowserConnectedMock,
  sendBrowserCommand: sendBrowserCommandMock,
}))

const toastInfoMock = vi.hoisted(() => vi.fn())
const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: { info: toastInfoMock, error: toastErrorMock } }))

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
  toastErrorMock.mockReset()
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

/**
 * The invariant: no user-controlled URL may reach a navigation API unless it
 * is http(s).
 *
 * This matters most on the web, where the fallback path navigates the page
 * itself. `javascript://example.com/%0aalert(1)` parses as a perfectly valid
 * URL with a dotted hostname — `//example.com/` is a JS line comment and
 * `%0a` is a newline — so handing it to location.assign() runs script in
 * TabDump's own origin.
 *
 * The guard sits at the top of openTab() rather than in front of each sink,
 * so it also covers URLs already sitting in a user's localStorage from
 * before this check existed. Desktop (Rust safelist) and the extension
 * (isSafeOpenUrl) keep their own checks — this is the third layer, not a
 * replacement for either.
 */
describe("unsafe URL schemes never reach a navigation API", () => {
  const UNSAFE = [
    "javascript:alert(1)",
    "javascript://example.com/%0aalert(1)",
    "JavaScript://example.com/%0aalert(1)",
    "data:text/html,<h1>x</h1>",
    "data://example.com/x",
    "file:///etc/passwd",
    "file://example.com/share",
    "vbscript:msgbox(1)",
    "vbscript://example.com/x",
    "about:blank",
    "blob:https://example.com/9b7a-1",
    "chrome://settings",
  ]

  for (const url of UNSAFE) {
    it(`refuses ${url}`, async () => {
      isBrowserConnectedMock.mockReturnValue(false)

      await openTab(url)

      expect(locationAssignMock).not.toHaveBeenCalled()
      expect(windowOpenMock).not.toHaveBeenCalled()
      expect(sendBrowserCommandMock).not.toHaveBeenCalled()
      expect(openExternalMock).not.toHaveBeenCalled()
      expect(toastErrorMock).toHaveBeenCalledTimes(1)
    })

    it(`refuses ${url} on the newTab path too`, async () => {
      isBrowserConnectedMock.mockReturnValue(false)

      await openTab(url, { newTab: true })

      expect(windowOpenMock).not.toHaveBeenCalled()
      expect(locationAssignMock).not.toHaveBeenCalled()
    })
  }

  it("refuses an unsafe URL on desktop before it reaches the IPC bridge", async () => {
    isDesktopMock.mockReturnValue(true)

    await openTab("javascript://example.com/%0aalert(1)")

    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it("refuses an unsafe URL even when the extension is connected", async () => {
    isBrowserConnectedMock.mockReturnValue(true)

    await openTab("javascript://example.com/%0aalert(1)")

    expect(sendBrowserCommandMock).not.toHaveBeenCalled()
  })

  it("refuses malformed input instead of passing it through", async () => {
    isBrowserConnectedMock.mockReturnValue(false)

    for (const bad of ["", "   ", "not a url", "://missing-scheme"]) {
      await openTab(bad)
    }

    expect(locationAssignMock).not.toHaveBeenCalled()
    expect(windowOpenMock).not.toHaveBeenCalled()
  })

  it("still opens ordinary http(s) URLs, underscores and all", async () => {
    isBrowserConnectedMock.mockReturnValue(false)

    await openTab("https://example.com/path_with_underscores")
    expect(locationAssignMock).toHaveBeenCalledWith("https://example.com/path_with_underscores")

    locationAssignMock.mockReset()
    await openTab("http://example.com/search?q=hello_world")
    expect(locationAssignMock).toHaveBeenCalledWith("http://example.com/search?q=hello_world")

    locationAssignMock.mockReset()
    await openTab("https://example.com:8443/a?x=1&y=2#section_name")
    expect(locationAssignMock).toHaveBeenCalledWith("https://example.com:8443/a?x=1&y=2#section_name")

    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("still opens http(s) URLs in a new tab when asked", async () => {
    isBrowserConnectedMock.mockReturnValue(false)

    await openTab("https://example.com/a_b", { newTab: true })

    expect(windowOpenMock).toHaveBeenCalledWith(
      "https://example.com/a_b",
      "_blank",
      "noopener,noreferrer"
    )
  })
})

/**
 * TabDump is local-first, so a workspace saved before parseSingleUrl started
 * rejecting unsafe schemes can still hold one. Those rows are deliberately
 * NOT migrated or deleted — the user's data is theirs — which makes the
 * opening guard the thing that actually protects them. A fix that only
 * covered newly-imported URLs would leave every existing install exposed.
 */
describe("legacy unsafe URLs already in local storage", () => {
  it("cannot be opened even though they are already stored", async () => {
    // Exactly what a pre-fix dump would have persisted.
    const legacyTab = {
      id: "tab-legacy-1",
      url: "javascript://example.com/%0aalert(1)",
      normalizedUrl: "javascript://example.com/%0aalert(1)",
      domain: "example.com",
    }
    isBrowserConnectedMock.mockReturnValue(false)

    await openTab(legacyTab.url)

    expect(locationAssignMock).not.toHaveBeenCalled()
    expect(windowOpenMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it("does not stop the rest of the workspace from working", async () => {
    isBrowserConnectedMock.mockReturnValue(false)

    await openTab("javascript://example.com/%0aalert(1)")
    await openTab("https://example.com/still_fine")

    expect(locationAssignMock).toHaveBeenCalledTimes(1)
    expect(locationAssignMock).toHaveBeenCalledWith("https://example.com/still_fine")
  })
})
