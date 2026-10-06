import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
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
  it("leads with one sentence, the calls to action and a live Hubble window", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    expect(screen.getByRole("heading", { level: 1, name: /structured context for your AI agents/ })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /Get started/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole("link", { name: "Explore Hubble" })[0].getAttribute("href")).toBe("#workspaces")
    expect(screen.getByRole("region", { name: /Interactive Hubble demo/ })).toBeTruthy()
  })

  it("renders only the hero's window on load; the rest wait until they are near", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    expect(document.querySelectorAll("[data-hubble-demo]")).toHaveLength(1)
  })

  it("without IntersectionObserver, mounts the windows on the visitor's first scroll", () => {
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    act(() => {
      window.dispatchEvent(new Event("scroll"))
    })
    expect(document.querySelectorAll("[data-hubble-demo]")).toHaveLength(6)
  })

  it("has a live window in every feature section once near, each with its own isolated state", () => {
    // Report every window as near, as a browser does when the visitor reaches it.
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
        }
        disconnect() {}
        unobserve() {}
      }
    )
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    for (const id of ["workspaces", "command-centre", "graph", "context", "agents"]) {
      const section = document.getElementById(id)
      expect(section, id).not.toBeNull()
      expect(section!.querySelector("[data-hubble-demo]"), id).not.toBeNull()
    }
    expect(document.querySelectorAll("[data-hubble-demo]")).toHaveLength(6)
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
    // The hero is unchanged: its pair is still Get started and Explore Hubble.
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
