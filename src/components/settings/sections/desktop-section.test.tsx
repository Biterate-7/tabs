import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs"

const invoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const { DesktopSection } = await import("./desktop-section")

const SHA = "a".repeat(64)
const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
}
const realUserAgent = navigator.userAgent
const fetchMock = vi.fn<typeof fetch>()

function setDesktop(on: boolean) {
  if (on) (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  else delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}
function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true })
}
/** What `fetch(…, { redirect: "manual" })` resolves to for a 302. */
function redirect(): Response {
  return { type: "opaqueredirect", status: 0, ok: false } as Response
}
function manifest(windowsVersion: string): Response {
  return Response.json({
    builds: {
      windows: { status: "published", version: windowsVersion, sha256: SHA, bytes: 31_000_000 },
      macos: { status: "coming_soon" },
      linux: { status: "unsupported" },
    },
  })
}
const APP_INFO = { version: "0.1.0", tauriVersion: "2.9.0", os: "windows", arch: "x86_64", debug: false }

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  setUserAgent(UA.windows)
})

afterEach(() => {
  cleanup()
  setDesktop(false)
  setUserAgent(realUserAgent)
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  invoke.mockReset()
})

describe("Settings → Desktop app on Hubble Web", () => {
  it("offers the published Windows installer through the measured endpoint once it answers", async () => {
    fetchMock.mockResolvedValue(redirect())
    render(<DesktopSection />)

    expect(screen.getByText("Web")).toBeTruthy()
    expect(screen.getByText("You're using Hubble Web, in your browser.")).toBeTruthy()
    const link = screen.getByRole("link", { name: /Download for Windows/ })
    expect(link.getAttribute("href")).toBe("/api/download?platform=windows")
    expect(screen.getByText(/Version 0\.1\.0 · Windows 10 or 11, 64-bit · 30 MB/)).toBeTruthy()

    // The probe is a HEAD that never follows the redirect (and is never counted).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("/api/download?platform=windows")
    expect(init).toMatchObject({ method: "HEAD", redirect: "manual" })
    await waitFor(() => expect(screen.queryByText(/Checking the download/)).toBeNull())

    fireEvent.click(link)
    expect(screen.getByRole("status").textContent).toMatch(/Downloading Hubble_0\.1\.0_x64-setup\.exe/)
    expect(screen.getByText(/Open Hubble_0\.1\.0_x64-setup\.exe from your browser's downloads/)).toBeTruthy()
  })

  it("links the version's real release page as the fallback", () => {
    fetchMock.mockResolvedValue(redirect())
    render(<DesktopSection />)
    const releases = screen.getByRole("link", { name: /Releases/ })
    expect(releases.getAttribute("href")).toBe("https://github.com/Biterate-7/tabs/releases/tag/desktop-v0.1.0")
    expect(releases.getAttribute("target")).toBe("_blank")
  })

  it("disables the download and points at the releases page when the endpoint has no build", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    render(<DesktopSection />)
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/isn.t available from Hubble right now/))
    const button = screen.getByRole("button", { name: /Download for Windows/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.queryByRole("link", { name: /Download for Windows/ })).toBeNull()
  })

  it("says when the download server can't be reached, and tries again on request", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(redirect())
    render(<DesktopSection />)
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Couldn.t reach Hubble.s download server/))
    // The link still works — a failed probe is not proof the download would fail.
    expect(screen.getByRole("link", { name: /Download for Windows/ })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /Try again/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(""))
  })

  it("tells a Mac visitor there is no Mac build, and keeps the Windows installer as a secondary choice", async () => {
    setUserAgent(UA.mac)
    fetchMock.mockResolvedValue(redirect())
    render(<DesktopSection />)
    await waitFor(() => expect(screen.getByText("Hubble for macOS")).toBeTruthy())
    expect(screen.getByText("Coming soon")).toBeTruthy()
    expect(screen.getByRole("link", { name: /Download for Windows/ }).className).toMatch(/border/)
    expect(screen.queryByText(/Download for macOS/)).toBeNull()
  })

  it("offers no installer on a phone", async () => {
    setUserAgent(UA.iphone)
    fetchMock.mockResolvedValue(redirect())
    render(<DesktopSection />)
    await waitFor(() => expect(screen.getByText(/runs on a computer/)).toBeTruthy())
    expect(screen.queryByRole("link", { name: /Download for Windows/ })).toBeNull()
  })
})

describe("Settings → Desktop app in Hubble Desktop", () => {
  beforeEach(() => setDesktop(true))

  it("identifies the running app from the binary, never as Web", async () => {
    invoke.mockResolvedValue(APP_INFO)
    fetchMock.mockResolvedValue(manifest("0.1.0"))
    render(<DesktopSection />)

    expect(screen.getByText("You're running Hubble Desktop.")).toBeTruthy()
    expect(screen.getByText("Desktop")).toBeTruthy()
    expect(screen.queryByText("Web")).toBeNull()
    expect(screen.queryByRole("link", { name: /Download for Windows/ })).toBeNull()

    await waitFor(() => expect(screen.getByText("0.1.0")).toBeTruthy())
    expect(invoke).toHaveBeenCalledWith("app_info", {})
    expect(screen.getByText("Windows · 64-bit")).toBeTruthy()
    expect(screen.getByText("Release")).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/You have the latest version/)).toBeTruthy())
    expect(fetchMock.mock.calls[0]![0]).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/api/desktop/release`)
  })

  it("links a newer published build's installer and notes, built from the version alone", async () => {
    invoke.mockResolvedValue(APP_INFO)
    fetchMock.mockResolvedValue(manifest("0.2.0"))
    render(<DesktopSection />)

    await waitFor(() => expect(screen.getByText("Hubble 0.2.0 is available")).toBeTruthy())
    expect(screen.getByText(/replaces 0\.1\.0 and keeps your projects\. 31 MB\./)).toBeTruthy()
    const download = screen.getByRole("link", { name: /Download 0\.2\.0/ })
    expect(download.getAttribute("href")).toBe(`${CANONICAL_PRODUCTION_ORIGIN}/api/download?platform=windows`)
    expect(download.getAttribute("target")).toBe("_blank")
    expect(screen.getByRole("link", { name: /What.s new/ }).getAttribute("href")).toBe(
      "https://github.com/Biterate-7/tabs/releases/tag/desktop-v0.2.0"
    )
  })

  it("reports a failed update check with the releases page and a retry", async () => {
    invoke.mockResolvedValue(APP_INFO)
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(manifest("0.1.0"))
    render(<DesktopSection />)

    await waitFor(() => expect(screen.getByText("Couldn't check for updates")).toBeTruthy())
    expect(screen.getByText(/Couldn't reach Hubble's release server/)).toBeTruthy()
    expect(screen.getByRole("link", { name: /Releases/ }).getAttribute("href")).toBe("https://github.com/Biterate-7/tabs/releases")

    fireEvent.click(screen.getByRole("button", { name: /Check again/ }))
    await waitFor(() => expect(screen.getByText(/You have the latest version/)).toBeTruthy())
  })

  it("says so when the binary can't report itself, instead of guessing a version", async () => {
    invoke.mockRejectedValue(new Error("command app_info not found"))
    render(<DesktopSection />)

    await waitFor(() => expect(screen.getByText("Couldn't read this install")).toBeTruthy())
    expect(screen.getByText("command app_info not found")).toBeTruthy()
    expect(screen.getByText("Unknown")).toBeTruthy()
    expect(screen.getByText("You're running Hubble Desktop.")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("marks a development build", async () => {
    invoke.mockResolvedValue({ ...APP_INFO, version: "0.2.0", debug: true })
    fetchMock.mockResolvedValue(manifest("0.1.0"))
    render(<DesktopSection />)
    await waitFor(() => expect(screen.getByText("Development")).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/newer than the latest release \(0\.1\.0\)/)).toBeTruthy())
  })
})
