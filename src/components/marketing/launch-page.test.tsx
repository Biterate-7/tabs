import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { LaunchPage } from "./launch-page"
import type { ReleaseView } from "@/lib/desktop/artifacts"

const RELEASE: ReleaseView = {
  version: "0.2.0",
  tag: "desktop-v0.2.0",
  publishedAt: "2026-11-19T10:00:00Z",
  notes: "",
  artifacts: [{ os: "windows", format: "nsis", arch: "x64", name: "Hubble_0.2.0_x64-setup.exe", bytes: 31_000_000, sha256: "a".repeat(64) }],
  source: "github",
  pageUrl: "https://github.com/Biterate-7/tabs/releases/tag/desktop-v0.2.0",
}

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function hero() {
  return screen.getByRole("heading", { level: 1 }).closest("section")!
}

describe("LaunchPage", () => {
  it("leads with Hubble as a desktop app and Download Hubble as the action", () => {
    render(<LaunchPage release={RELEASE} />)
    expect(screen.getByRole("heading", { level: 1, name: "One connected workspace for everything you learn with AI." })).toBeTruthy()
    expect(hero().textContent).toMatch(/An app for your computer/)
    const download = within(hero()).getByRole("link", { name: /Download Hubble/ })
    expect(download.getAttribute("href")).toBe("/download")
    expect(hero().textContent).toContain("Version 0.2.0")
    expect(screen.getByRole("figure", { name: /Sample Hubble project/ })).toBeTruthy()
  })

  it("downloads the visitor's installer straight from the hero once their OS is known", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(WINDOWS_UA)
    render(<LaunchPage release={RELEASE} />)
    const link = await within(hero()).findByRole("link", { name: /Download for Windows/ })
    expect(link.getAttribute("href")).toBe("/api/download?platform=windows")
  })

  it("never offers to open Hubble in the browser", () => {
    render(<LaunchPage release={RELEASE} />)
    expect(screen.queryByRole("button", { name: /Open Hubble|Get started/ })).toBeNull()
    expect(screen.queryByRole("link", { name: /Open Hubble|Use Hubble in your browser/ })).toBeNull()
  })

  it("presents Hubble for Chrome as the desktop app's companion", () => {
    render(<LaunchPage release={RELEASE} />)
    const section = document.getElementById("desktop-and-chrome")!
    expect(section.textContent).toContain("The app is Hubble. Chrome is how your browser reaches it.")
    expect(section.textContent).toMatch(/Paired on this computer/)
    expect(section.textContent).toMatch(/Kept until Hubble is open/)
    expect(within(section).getByRole("link", { name: /Get Hubble for Chrome/ }).getAttribute("href")).toBe("/download#chrome")
  })

  it("explains the loop: capture, connect, find, reuse", () => {
    render(<LaunchPage release={RELEASE} />)
    const loop = document.getElementById("how-it-works")!
    expect([...loop.querySelectorAll("li p:first-of-type")].map((p) => p.textContent)).toEqual(["Capture", "Connect", "Find", "Reuse"])
  })

  it("says what works with each AI app from the provider registry, never more", () => {
    render(<LaunchPage release={RELEASE} />)
    const row = screen.getByRole("heading", { name: "Works beside the AI apps you already use" }).closest("section")!
    expect(row.textContent).toContain("Save from the page · Import export")
    expect(row.textContent).not.toMatch(/paste/i)
  })

  it("illustrates every feature with a sample computed by the product's own code", () => {
    render(<LaunchPage release={RELEASE} />)
    for (const id of ["capture", "find", "reuse"]) {
      expect(document.getElementById(id)?.querySelector("[data-hubble-illustration]"), id).not.toBeNull()
    }
  })

  it("says nothing about agents and never the old name", () => {
    render(<LaunchPage release={RELEASE} />)
    const words = document.querySelector("main")!.textContent ?? ""
    expect(words).not.toMatch(/\bagents?\b|command cent(re|er)/i)
    expect(document.body.textContent).not.toMatch(/TabDump|Tab Dump|Agent World/)
    expect(screen.getAllByText("HUBBLE").length).toBeGreaterThan(0)
  })

  it("offers to move web-era projects only to someone who has them", async () => {
    const { unmount } = render(<LaunchPage release={RELEASE} />)
    expect(screen.queryByRole("region", { name: "Your projects in this browser" })).toBeNull()
    unmount()
    window.localStorage.setItem(
      "tabdump:workspaces:v1",
      JSON.stringify({ version: 1, currentId: "w1", workspaces: [{ id: "w1", name: "Biology", tabs: [{ id: "t1", url: "https://example.com/", normalizedUrl: "https://example.com/", domain: "example.com", title: "x" }], createdAt: 1, updatedAt: 1 }] })
    )
    render(<LaunchPage release={RELEASE} />)
    const notice = await screen.findByRole("region", { name: "Your projects in this browser" })
    expect(notice.textContent).toContain("Your project is still saved in this browser")
    expect(within(notice).getByRole("link").getAttribute("href")).toBe("/move")
  })

  it("writes nothing to storage just by being viewed", () => {
    render(<LaunchPage release={RELEASE} />)
    expect(window.localStorage.length).toBe(0)
  })
})
