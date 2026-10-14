import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { MarketingPage } from "./marketing-page"

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  )
})
afterEach(() => vi.unstubAllGlobals())

describe("MarketingPage", () => {
  it("leads with one sentence, the calls to action and a sample project", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    expect(screen.getByRole("heading", { level: 1, name: "One connected workspace for everything you learn with AI." })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /Get started/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole("link", { name: "Explore Hubble" })[0].getAttribute("href")).toBe("#capture")
    expect(screen.getByRole("figure", { name: /Sample Hubble project/ })).toBeTruthy()
    expect(screen.getByText("A sample project. Nothing on this page reads or stores your data.")).toBeTruthy()
  })

  it("explains the loop: capture, connect, find, reuse", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    const loop = document.getElementById("how-it-works")!
    expect([...loop.querySelectorAll("li p:first-of-type")].map((p) => p.textContent)).toEqual(["Capture", "Connect", "Find", "Reuse"])
  })

  it("says what works with each AI app from the provider registry, never more", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    const row = screen.getByRole("heading", { name: "Works beside the AI apps you already use" }).closest("section")!
    const cards = Object.fromEntries([...row.querySelectorAll("li")].map((li) => [li.querySelector("span span")!.textContent, li.textContent]))
    expect(cards.ChatGPT).toContain("Save from the page · Import export")
    expect(cards.Claude).toContain("Save from the page · Import export")
    expect(cards.Gemini).toContain("Save from the page · Paste")
    expect(cards.Perplexity).toContain("Save from the page · Paste")
    expect(document.body.textContent).not.toMatch(/\bsync(s|ed|ing)? (automatically|your (chats|conversations))/i)
  })

  it("illustrates every feature with a sample computed by the product's own search and context code", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    for (const id of ["capture", "find", "reuse"]) {
      const section = document.getElementById(id)
      expect(section, id).not.toBeNull()
      expect(section!.querySelector("[data-hubble-illustration]"), id).not.toBeNull()
    }
    expect(document.getElementById("reuse")!.textContent).toContain("Context from my Hubble project")
  })

  it("says nothing about agents, sessions or a Command Centre", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    expect(document.body.textContent).not.toMatch(/\bagents?\b|command cent(re|er)|runtime|approval/i)
  })

  it("shows the wordmark in capitals and never the old name", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    expect(screen.getAllByText("HUBBLE").length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/TabDump|Tab Dump|Agent World/)
  })

  it("enters the app from Get started and Open Hubble", () => {
    const onPasteTabs = vi.fn()
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={onPasteTabs} />)
    fireEvent.click(screen.getAllByRole("button", { name: /Get started/ })[0])
    fireEvent.click(screen.getAllByRole("button", { name: "Open Hubble" })[0])
    expect(onPasteTabs).toHaveBeenCalledTimes(2)
  })

  it("leads to the download page from the header, the closing actions and the footer", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    // Windows 0.1.0 is published (release.ts), so the links say "Download Hubble".
    const links = screen.getAllByRole("link", { name: "Download Hubble" })
    // Header, closing pair, footer — all to the page, never straight to an installer.
    expect(links).toHaveLength(3)
    for (const link of links) expect(link.getAttribute("href")).toBe("/download")
    // The hero's pair is Get started and Explore Hubble.
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!
    expect(within(hero).getByRole("link", { name: "Explore Hubble" })).toBeTruthy()
    expect(within(hero).queryByRole("link", { name: "Download Hubble" })).toBeNull()
  })

  it("does not offer Hubble Desktop inside Hubble Desktop", () => {
    window.__TAURI_INTERNALS__ = {}
    try {
      render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
      expect(screen.queryByRole("link", { name: /Hubble Desktop|Download Hubble/ })).toBeNull()
      // The closing pair falls back to its original second action.
      expect(screen.getAllByRole("link", { name: "Explore Hubble" })).toHaveLength(2)
    } finally {
      delete window.__TAURI_INTERNALS__
    }
  })

  it("writes nothing to storage just by being viewed", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    expect(window.localStorage.length).toBe(0)
  })
})
