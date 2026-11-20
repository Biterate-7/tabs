import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { AI_PROVIDER_IDS, AI_PROVIDERS } from "@/lib/providers/registry"
import { MarketingPage } from "./marketing-page"
import { capabilityLine } from "./showcase/sections"

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  )
})
afterEach(() => vi.unstubAllGlobals())

function renderPage(props: Partial<Parameters<typeof MarketingPage>[0]> = {}) {
  return render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} onOpenConnectors={vi.fn()} {...props} />)
}

describe("MarketingPage", () => {
  it("leads with one sentence, the calls to action and the product itself", () => {
    renderPage()
    expect(screen.getByRole("heading", { level: 1, name: "Hubble is the control layer for your work with AI." })).toBeTruthy()
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!
    expect(within(hero).getByRole("button", { name: /Get started/ })).toBeTruthy()
    expect(within(hero).getByRole("link", { name: /Download Hubble/ }).getAttribute("href")).toBe("/download")
    expect(within(hero).getByRole("figure", { name: /Hubble with the sample project History IA/ })).toBeTruthy()
    expect(within(hero).getByRole("figure", { name: /Claude in Chrome with Hubble's context/ })).toBeTruthy()
    expect(within(hero).getByText("A sample project. Nothing on this page reads or stores your data.")).toBeTruthy()
  })

  it("plays the loop as five chapters the visitor can jump between", () => {
    renderPage()
    const rail = screen.getByRole("list", { name: "The Hubble loop" })
    const steps = within(rail).getAllByRole("button")
    expect(steps.map((step) => step.getAttribute("aria-label"))).toEqual(["Show Workspace", "Show Context", "Show Agent", "Show Action", "Show Review"])
    fireEvent.click(steps[4]!)
    const hero = document.querySelector<HTMLElement>("[data-hero-demo]")!
    expect(hero.dataset.frame).toBe("6")
    expect(within(hero).getByText("Claude proposed 2 changes in “History IA”")).toBeTruthy()
    fireEvent.click(within(hero).getByRole("button", { name: "Approve" }))
    expect(hero.dataset.frame).toBe("7")
    expect(within(hero).getByText("Applied and verified.")).toBeTruthy()
  })

  it("hands Claude the context the product's own bundle code writes", () => {
    renderPage()
    const hero = document.querySelector<HTMLElement>("[data-hero-demo]")!
    fireEvent.click(within(hero).getByRole("button", { name: "Show Context" }))
    fireEvent.click(within(hero).getByRole("button", { name: "Show Context" }))
    expect(hero.textContent).toContain("Context from my Hubble project: History IA")
    // Only the connector's real tool names.
    for (const tool of ["get_project_context", "search_workspace", "save_project_context", "propose_organization"]) expect(hero.textContent).toContain(tool)
  })

  it("says what works with each AI app from the provider registry, never more", () => {
    renderPage()
    for (const id of AI_PROVIDER_IDS) {
      const tile = document.querySelector(`[data-works-with="${AI_PROVIDERS[id].name}"]`)!
      expect(tile.textContent).toContain(capabilityLine(AI_PROVIDERS[id]))
    }
    expect(capabilityLine(AI_PROVIDERS.chatgpt)).toBe("Save · Import · Use in AI · Connector")
    expect(capabilityLine(AI_PROVIDERS.perplexity)).toBe("Save · Use in AI")
    expect(document.body.textContent).not.toMatch(/\bsync(s|ed|ing)? (automatically|your (chats|conversations))/i)
  })

  it("shows every capability in a window computed by the product's own search and context code", () => {
    renderPage()
    for (const id of ["capture", "find", "reuse", "agents"]) {
      const section = document.getElementById(id)
      expect(section, id).not.toBeNull()
      expect(section!.querySelector("[data-hubble-illustration]"), id).not.toBeNull()
    }
    expect(within(document.getElementById("find")!).getByRole("list", { name: "Results for alliance system" }).children.length).toBe(5)
    // The message box shows the end of the text, as a scrolled box would: the bundle's own closing line.
    expect(document.getElementById("reuse")!.textContent).toContain("What I want to do now:")
  })

  it("lets the visitor drive the search and the hand-off", () => {
    renderPage()
    const find = document.getElementById("find")!
    fireEvent.click(within(find).getByRole("button", { name: "Italy" }))
    expect(within(find).getByRole("list", { name: "Results for Italy" }).children.length).toBe(2)
    const reuse = document.getElementById("reuse")!
    fireEvent.click(within(reuse).getByRole("button", { name: /Perplexity/ }))
    expect(reuse.querySelector<HTMLElement>("[data-handoff-demo]")!.dataset.target).toBe("perplexity")
    expect(reuse.textContent).toContain("perplexity.ai")
  })

  it("keeps agents to what the connector does: reads, saves, proposes — and waits for approval", () => {
    renderPage()
    const agents = document.getElementById("agents")!
    expect(agents.textContent).toContain("Nothing is reorganised until you approve it.")
    // The apps listed as connectable are the registry's.
    const connectable = AI_PROVIDER_IDS.filter((id) => AI_PROVIDERS[id].capabilities.connector.supported).map((id) => AI_PROVIDERS[id].name)
    for (const name of connectable) expect(agents.textContent).toContain(name)
    expect(document.body.textContent).not.toMatch(/command cent(re|er)|runtime/i)
  })

  it("shows the wordmark in capitals and never the old name", () => {
    renderPage()
    expect(screen.getAllByText("HUBBLE").length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/TabDump|Tab Dump|Agent World/)
  })

  it("enters the app from Get started, Open Hubble and the footer", () => {
    const onPasteTabs = vi.fn()
    renderPage({ onPasteTabs })
    fireEvent.click(screen.getAllByRole("button", { name: /Get started/ })[0]!)
    fireEvent.click(screen.getAllByRole("button", { name: "Open Hubble" })[0]!)
    fireEvent.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "Open Hubble" }))
    expect(onPasteTabs).toHaveBeenCalledTimes(3)
  })

  it("opens AI connectors from the agents section, and hides those links without a way there", () => {
    const onOpenConnectors = vi.fn()
    const { unmount } = renderPage({ onOpenConnectors })
    fireEvent.click(within(document.getElementById("agents")!).getByRole("button", { name: /Set up AI connectors/ }))
    expect(onOpenConnectors).toHaveBeenCalledTimes(1)
    unmount()
    render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /Set up AI connectors/ })).toBeNull()
  })

  it("leads to the download page from the header, hero, desktop card, closing actions and footer", () => {
    renderPage()
    // Windows 0.1.0 is published (release.ts), so the links say "Download Hubble".
    const links = screen.getAllByRole("link", { name: /Download Hubble/ })
    // Header (and its phone menu), hero, desktop card, closing pair, footer — all to the page, never straight to an installer.
    expect(links.length).toBe(6)
    for (const link of links) expect(link.getAttribute("href")).toBe("/download")
  })

  it("does not offer Hubble Desktop inside Hubble Desktop", () => {
    window.__TAURI_INTERNALS__ = {}
    try {
      renderPage()
      expect(screen.queryByRole("link", { name: /Hubble Desktop|Download Hubble/ })).toBeNull()
      // The hero and closing pairs fall back to their original second action.
      expect(screen.getAllByRole("link", { name: "Explore Hubble" })).toHaveLength(2)
    } finally {
      delete window.__TAURI_INTERNALS__
    }
  })

  it("has a section for every header link", () => {
    renderPage()
    const nav = screen.getByRole("navigation", { name: "Sections" })
    for (const link of within(nav).getAllByRole("link")) {
      const href = link.getAttribute("href")!
      expect(document.querySelector(href), href).not.toBeNull()
    }
  })

  it("writes nothing to storage just by being viewed", () => {
    renderPage()
    expect(window.localStorage.length).toBe(0)
  })
})
