import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import type { ReleaseView } from "@/lib/desktop/artifacts"
import { AI_PROVIDER_IDS, AI_PROVIDERS } from "@/lib/providers/registry"
import { CONNECTORS_AVAILABILITY, LaunchPage } from "./launch-page"
import { capabilityLine } from "./showcase/sections"

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

function renderPage() {
  return render(<LaunchPage release={RELEASE} />)
}

function hero() {
  return screen.getByRole("heading", { level: 1 }).closest("section")!
}

describe("LaunchPage", () => {
  it("leads with one sentence, Download Hubble as the action, and the product itself", () => {
    renderPage()
    expect(screen.getByRole("heading", { level: 1, name: "Hubble is the control layer for your work with AI." })).toBeTruthy()
    expect(hero().textContent).toMatch(/An app for your computer/)
    const download = within(hero()).getByRole("link", { name: /Download Hubble/ })
    expect(download.getAttribute("href")).toBe("/download")
    expect(hero().textContent).toContain("Version 0.2.0")
    expect(within(hero()).getByRole("figure", { name: /Hubble with the sample project History IA/ })).toBeTruthy()
    expect(within(hero()).getByRole("figure", { name: /Claude in Chrome with Hubble's context/ })).toBeTruthy()
    expect(hero().textContent).toContain("A sample project. Nothing on this page reads or stores your data.")
  })

  it("downloads the visitor's installer straight from the hero once their OS is known", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(WINDOWS_UA)
    renderPage()
    const link = await within(hero()).findByRole("link", { name: /Download for Windows/ })
    expect(link.getAttribute("href")).toBe("/api/download?platform=windows")
  })

  it("never offers to open Hubble in the browser", () => {
    renderPage()
    expect(screen.queryByRole("button", { name: /Open Hubble|Get started/ })).toBeNull()
    expect(screen.queryByRole("link", { name: /Open Hubble|Use Hubble in your browser/ })).toBeNull()
  })

  it("presents Hubble for Chrome as the desktop app's companion", () => {
    renderPage()
    const section = document.getElementById("desktop-and-chrome")!
    expect(section.textContent).toContain("The app is Hubble. Chrome is how your browser reaches it.")
    expect(section.textContent).toMatch(/Paired on this computer/)
    expect(section.textContent).toMatch(/Kept until Hubble is open/)
    expect(within(section).getByRole("link", { name: /Get Hubble for Chrome/ }).getAttribute("href")).toBe("/download#chrome")
    expect(within(section).getByRole("link", { name: /How they connect/ }).getAttribute("href")).toBe("/download#how-they-connect")
  })

  it("plays the loop as five chapters the visitor can jump between", () => {
    renderPage()
    const rail = screen.getByRole("list", { name: "The Hubble loop" })
    const steps = within(rail).getAllByRole("button")
    expect(steps.map((step) => step.getAttribute("aria-label"))).toEqual(["Show Workspace", "Show Context", "Show Agent", "Show Action", "Show Review"])
    fireEvent.click(steps[4]!)
    const demo = document.querySelector<HTMLElement>("[data-hero-demo]")!
    expect(demo.dataset.frame).toBe("6")
    expect(within(demo).getByText("Claude proposed 2 changes in “History IA”")).toBeTruthy()
    fireEvent.click(within(demo).getByRole("button", { name: "Approve" }))
    expect(demo.dataset.frame).toBe("7")
    expect(within(demo).getByText("Applied and verified.")).toBeTruthy()
  })

  it("hands Claude the context the product's own bundle code writes, and uses only the connector's real tools", () => {
    renderPage()
    const demo = document.querySelector<HTMLElement>("[data-hero-demo]")!
    expect(demo.textContent).toContain("Context from my Hubble project: History IA")
    for (const tool of ["get_project_context", "search_workspace", "save_project_context", "propose_organization"]) expect(demo.textContent).toContain(tool)
  })

  it("says what works with each AI app from the provider registry, never more", () => {
    renderPage()
    expect(screen.getByRole("heading", { name: "Works with the AI apps you already use" })).toBeTruthy()
    for (const id of AI_PROVIDER_IDS) {
      const tile = document.querySelector(`[data-works-with="${AI_PROVIDERS[id].name}"]`)!
      expect(tile.textContent).toContain(capabilityLine(AI_PROVIDERS[id]))
    }
    expect(capabilityLine(AI_PROVIDERS.chatgpt)).toBe("Save · Import · Use in AI · Connector")
    expect(capabilityLine(AI_PROVIDERS.perplexity)).toBe("Save · Use in AI")
    expect(document.querySelector('[data-works-with="Desktop"]')!.textContent).toContain("The Hubble app")
    expect(document.querySelector('[data-works-with="Chrome"]')!.textContent).toContain("Companion extension")
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

  it("keeps agents to what the connector does, and says plainly that connectors are not switched on yet", () => {
    renderPage()
    const agents = document.getElementById("agents")!
    expect(agents.textContent).toContain("Nothing is reorganised until you approve it.")
    expect(agents.textContent).toContain(CONNECTORS_AVAILABILITY)
    expect(hero().textContent).toContain(CONNECTORS_AVAILABILITY)
    // The apps shown as connectable are the registry's.
    const connectable = AI_PROVIDER_IDS.filter((id) => AI_PROVIDERS[id].capabilities.connector.supported).map((id) => AI_PROVIDERS[id].name)
    for (const name of connectable) expect(agents.textContent).toContain(name)
    // Nothing points into an app the website no longer serves.
    expect(screen.queryByRole("button", { name: /Set up AI connectors/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/command cent(re|er)|runtime/i)
  })

  it("never uses the old name", () => {
    renderPage()
    expect(document.body.textContent).not.toMatch(/TabDump|Tab Dump|Agent World/)
    expect(screen.getAllByText("HUBBLE").length).toBeGreaterThan(0)
  })

  it("sends every download link to the download page or the measured download endpoint", () => {
    renderPage()
    const links = screen.getAllByRole("link", { name: /Download|All platforms/ })
    expect(links.length).toBeGreaterThan(3)
    for (const link of links) expect(link.getAttribute("href")).toMatch(/^\/download($|#)|^\/api\/download\?/)
  })

  it("has a section for every header link on this page", () => {
    renderPage()
    const nav = screen.getByRole("navigation", { name: "Sections" })
    for (const link of within(nav).getAllByRole("link")) {
      const href = link.getAttribute("href")!
      if (!href.startsWith("/#")) continue
      expect(document.querySelector(href.slice(1)), href).not.toBeNull()
    }
  })

  it("offers to move web-era projects only to someone who has them", async () => {
    const { unmount } = renderPage()
    expect(screen.queryByRole("region", { name: "Your projects in this browser" })).toBeNull()
    unmount()
    window.localStorage.setItem(
      "tabdump:workspaces:v1",
      JSON.stringify({ version: 1, currentId: "w1", workspaces: [{ id: "w1", name: "Biology", tabs: [{ id: "t1", url: "https://example.com/", normalizedUrl: "https://example.com/", domain: "example.com", title: "x" }], createdAt: 1, updatedAt: 1 }] })
    )
    renderPage()
    const notice = await screen.findByRole("region", { name: "Your projects in this browser" })
    expect(notice.textContent).toContain("Your project is still saved in this browser")
    expect(within(notice).getByRole("link").getAttribute("href")).toBe("/move")
  })

  it("writes nothing to storage just by being viewed", () => {
    renderPage()
    expect(window.localStorage.length).toBe(0)
  })
})
