import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { DownloadPage, ReleaseNotes } from "./download-page"
import type { ReleaseView } from "@/lib/desktop/artifacts"

const SHA = "b".repeat(64)

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
}

function release(artifacts: ReleaseView["artifacts"]): ReleaseView {
  return {
    version: "0.2.0",
    tag: "desktop-v0.2.0",
    publishedAt: "2026-11-19T10:00:00Z",
    notes: "## Highlights\n- Hubble is a desktop app\n- Pair [Hubble for Chrome](https://example.com) with it\n<script>alert(1)</script>",
    artifacts,
    source: "github",
    pageUrl: "https://github.com/Biterate-7/tabs/releases/tag/desktop-v0.2.0",
  }
}

const WINDOWS_ONLY = release([
  { os: "windows", format: "nsis", arch: "x64", name: "Hubble_0.2.0_x64-setup.exe", bytes: 31_000_000, sha256: SHA },
  { os: "windows", format: "msi", arch: "x64", name: "Hubble_0.2.0_x64_en-US.msi", bytes: 32_000_000, sha256: SHA },
])

const ALL = release([
  ...WINDOWS_ONLY.artifacts,
  { os: "macos", format: "dmg", arch: "universal", name: "Hubble_0.2.0_universal.dmg", bytes: 40_000_000, sha256: SHA },
  { os: "linux", format: "appimage", arch: "x64", name: "Hubble_0.2.0_amd64.AppImage", bytes: 90_000_000, sha256: SHA },
  { os: "linux", format: "deb", arch: "x64", name: "Hubble_0.2.0_amd64.deb", bytes: 20_000_000, sha256: SHA },
])

function asVisitor(userAgent: string) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent)
}

function hero() {
  return screen.getByRole("heading", { level: 1 }).closest("section")!
}

function platformCard(name: string) {
  const list = document.getElementById("platforms")!
  return [...list.querySelectorAll("ul > li")].find((li) => li.querySelector("p")?.textContent === name) as HTMLElement
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("/download", () => {
  it("offers a Windows visitor the Windows installer, through the measured link", async () => {
    asVisitor(UA.windows)
    render(<DownloadPage release={WINDOWS_ONLY} />)
    const link = await within(hero()).findByRole("link", { name: /Download for Windows/ })
    expect(link.getAttribute("href")).toBe("/api/download?platform=windows")
    expect(hero().textContent).toContain("Version 0.2.0 · Windows 10 or 11, 64-bit · 31 MB")
    // Never the GitHub asset itself.
    expect(document.body.innerHTML).not.toContain("releases/download")
  })

  it("lists every installer of the release with its checksum, and offers nothing for an OS without one", async () => {
    asVisitor(UA.windows)
    render(<DownloadPage release={WINDOWS_ONLY} />)
    const windows = platformCard("Windows")
    expect(within(windows).getByRole("link", { name: /Installer \(\.exe\)/ }).getAttribute("href")).toBe("/api/download?platform=windows")
    expect(within(windows).getByRole("link", { name: /Windows Installer \(\.msi\)/ }).getAttribute("href")).toBe("/api/download?platform=windows&format=msi&arch=x64")
    expect(windows.textContent).toContain(`SHA-256 ${SHA}`)
    for (const name of ["macOS", "Linux"]) {
      const card = platformCard(name)
      expect(within(card).queryByRole("link")).toBeNull()
      expect(card.textContent).toContain("Not available yet")
    }
    // Install steps only for a platform that has a build.
    const install = document.getElementById("install")!
    expect(install.textContent).toContain("Windows")
    expect(install.textContent).not.toMatch(/macOS|Linux/)
  })

  it("never names a platform in the main button that has no installer", async () => {
    asVisitor(UA.mac)
    render(<DownloadPage release={WINDOWS_ONLY} />)
    await waitFor(() => expect(within(hero()).getByRole("link", { name: /Download Hubble/ })).toBeTruthy())
    expect(within(hero()).queryByRole("link", { name: /Download for macOS/ })).toBeNull()
    expect(within(hero()).getByRole("link", { name: /Download Hubble/ }).getAttribute("href")).toBe("/download")
  })

  it("offers macOS and Linux visitors their own builds once the release has them", async () => {
    asVisitor(UA.mac)
    const { unmount } = render(<DownloadPage release={ALL} />)
    expect((await within(hero()).findByRole("link", { name: /Download for macOS/ })).getAttribute("href")).toBe("/api/download?platform=macos")
    unmount()
    asVisitor(UA.linux)
    render(<DownloadPage release={ALL} />)
    expect((await within(hero()).findByRole("link", { name: /Download for Linux/ })).getAttribute("href")).toBe("/api/download?platform=linux")
    expect(within(platformCard("Linux")).getByRole("link", { name: /Debian/ }).getAttribute("href")).toBe("/api/download?platform=linux&format=deb&arch=x64")
  })

  it("sends a phone to the full list rather than an installer", async () => {
    asVisitor(UA.iphone)
    render(<DownloadPage release={ALL} />)
    await waitFor(() => expect(within(hero()).getByRole("link", { name: /Download Hubble/ }).getAttribute("href")).toBe("/download"))
  })

  it("says so when there is no release at all, and links to nothing", () => {
    asVisitor(UA.windows)
    render(<DownloadPage release={null} />)
    expect(hero().textContent).toContain("isn’t available to download yet")
    expect(document.getElementById("release")).toBeNull()
    expect(document.body.innerHTML).not.toContain("/api/download")
  })

  it("shows the release notes as text, never as HTML, with a link to the release", () => {
    render(<DownloadPage release={WINDOWS_ONLY} />)
    const notes = document.getElementById("release")!
    expect(notes.textContent).toContain("Hubble is a desktop app")
    expect(notes.textContent).toContain("Pair Hubble for Chrome with it")
    expect(notes.querySelector("script")).toBeNull()
    expect(within(notes).getByRole("link", { name: /Release on GitHub/ }).getAttribute("href")).toBe(WINDOWS_ONLY.pageUrl)
  })

  it("presents Hubble for Chrome as the companion, with how they connect", () => {
    render(<DownloadPage release={WINDOWS_ONLY} />)
    const chrome = document.getElementById("chrome")!
    expect(chrome.textContent).toMatch(/companion extension/i)
    expect(within(chrome).getByRole("link", { name: /Download Hubble for Chrome/ }).getAttribute("href")).toBe("/hubble-extension.zip")
    expect(document.getElementById("how-they-connect")!.textContent).toMatch(/Nothing goes through a server/)
    expect(screen.getByRole("link", { name: /Move your projects to Hubble Desktop/ }).getAttribute("href")).toBe("/move")
  })

  it("says the visitor already has Hubble inside the desktop app, and offers no download", () => {
    window.__TAURI_INTERNALS__ = {}
    try {
      render(<DownloadPage release={ALL} />)
      expect(screen.getByRole("status").textContent).toContain("You’re using Hubble Desktop")
      expect(document.getElementById("platforms")).toBeNull()
    } finally {
      delete window.__TAURI_INTERNALS__
    }
  })
})

describe("ReleaseNotes", () => {
  it("renders headings, paragraphs and bullets as plain words", () => {
    render(<ReleaseNotes notes={"# Title\n\nSome **bold** text.\n- one\n- `two`"} />)
    expect(screen.getByText("Title")).toBeTruthy()
    expect(screen.getByText("Some bold text.")).toBeTruthy()
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["one", "two"])
  })
})
