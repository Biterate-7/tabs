import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { MarketingPage } from "./marketing-page"
import { REVEAL_THRESHOLD } from "./reveal"

/** Every section below the hero, by what it is about. */
const SECTION_TEXT = [
  "Works with the agents and tools you already use",
  "Your context, structured.",
  "Command your agents.",
  "See your work spatially.",
  "Give agents the right context.",
  "One interface for your agents.",
  "A calmer way to work with agents.",
  "Changelog",
  "Try Hubble now.",
]

/** An IntersectionObserver the test drives by hand, as scrolling would. */
class ManualObserver {
  static all: ManualObserver[] = []
  targets = new Set<Element>()
  constructor(
    private callback: IntersectionObserverCallback,
    public options: IntersectionObserverInit = {}
  ) {
    ManualObserver.all.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
  }
  takeRecords() {
    return []
  }
  static scroll(target: Element, intersectionRatio: number) {
    for (const observer of ManualObserver.all) {
      if (!observer.targets.has(target)) continue
      const entry = { target, isIntersecting: intersectionRatio > 0, intersectionRatio } as IntersectionObserverEntry
      act(() => observer.callback([entry], observer as unknown as IntersectionObserver))
    }
  }
}

function stubMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
}

/** Puts every section below the fold, where a visitor who has not scrolled finds them. */
function belowTheFold() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ top: 5000, bottom: 6000, left: 0, right: 1000, width: 1000, height: 1000, x: 0, y: 5000, toJSON: () => ({}) } as DOMRect)
}

function sections() {
  return Array.from(document.querySelectorAll<HTMLElement>(".m-reveal"))
}

function renderPage() {
  return render(<MarketingPage onInstallExtension={vi.fn()} onPasteTabs={vi.fn()} />)
}

beforeEach(() => {
  window.localStorage.clear()
  ManualObserver.all = []
  stubMotion(false)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("scroll reveal", () => {
  it("covers every major section below the hero, and never the hero, header or footer", () => {
    renderPage()
    const revealing = sections()
    for (const text of SECTION_TEXT) {
      expect(revealing.some((section) => section.textContent?.includes(text)), text).toBe(true)
    }
    for (const id of ["workspaces", "command-centre", "graph", "context", "agents", "changelog"]) {
      expect(document.getElementById(id)?.classList.contains("m-reveal"), id).toBe(true)
    }
    for (const section of revealing) {
      expect(section.querySelectorAll(".m-reveal-item").length).toBeGreaterThan(1)
    }
    expect(document.querySelector("h1")!.closest(".m-reveal")).toBeNull()
    expect(document.querySelector("header")!.closest(".m-reveal")).toBeNull()
    expect(document.querySelector("footer")!.closest(".m-reveal")).toBeNull()
    expect(document.querySelector("[data-hubble-demo]")!.closest(".m-reveal")).toBeNull()
  })

  it("staggers a feature section as title, body, link, then its window", () => {
    renderPage()
    const items = Array.from(document.getElementById("command-centre")!.querySelectorAll<HTMLElement>(".m-reveal-item"))
    expect(items.map((item) => item.style.getPropertyValue("--m-reveal-step"))).toEqual(["0", "1", "2", "3"])
    expect(items[0].textContent).toBe("Command your agents.")
    expect(items[3].querySelector(".m-stage")).not.toBeNull()
    // No link, so the window follows the body directly.
    const graph = Array.from(document.getElementById("graph")!.querySelectorAll<HTMLElement>(".m-reveal-item"))
    expect(graph.map((item) => item.style.getPropertyValue("--m-reveal-step"))).toEqual(["0", "1", "2"])
  })

  it("holds a section below the fold until it is meaningfully in view, then reveals it", () => {
    vi.stubGlobal("IntersectionObserver", ManualObserver)
    belowTheFold()
    renderPage()
    const graph = document.getElementById("graph")!
    for (const section of sections()) expect(section.dataset.reveal).toBe("pending")
    expect(ManualObserver.all.find((observer) => observer.targets.has(graph))?.options.threshold).toBe(REVEAL_THRESHOLD)

    ManualObserver.scroll(graph, 0.05)
    expect(graph.dataset.reveal).toBe("pending")

    ManualObserver.scroll(graph, REVEAL_THRESHOLD)
    expect(graph.dataset.reveal).toBe("revealed")
    // Only the section that was reached.
    expect(document.getElementById("context")!.dataset.reveal).toBe("pending")
  })

  it("stays revealed when the visitor scrolls away and back", () => {
    vi.stubGlobal("IntersectionObserver", ManualObserver)
    belowTheFold()
    renderPage()
    const graph = document.getElementById("graph")!
    ManualObserver.scroll(graph, 0.5)
    expect(graph.dataset.reveal).toBe("revealed")

    ManualObserver.scroll(graph, 0)
    ManualObserver.scroll(graph, 0.5)
    expect(graph.dataset.reveal).toBe("revealed")
    // It stops watching once revealed.
    expect(ManualObserver.all.some((observer) => observer.targets.has(graph))).toBe(false)
  })

  it("never hides a section that is already on screen when the page mounts", () => {
    vi.stubGlobal("IntersectionObserver", ManualObserver)
    // jsdom lays nothing out, so every section reports top 0: in view.
    renderPage()
    for (const section of sections()) expect(section.dataset.reveal).toBeUndefined()
  })

  it("reveals independently of whether the section's live window has mounted", () => {
    vi.stubGlobal("IntersectionObserver", ManualObserver)
    belowTheFold()
    renderPage()
    const graph = document.getElementById("graph")!
    ManualObserver.scroll(graph, 0.5)
    expect(graph.dataset.reveal).toBe("revealed")
    expect(graph.querySelector("[data-hubble-demo]")).toBeNull()
  })

  it("without IntersectionObserver, renders every section as it is", () => {
    belowTheFold()
    renderPage()
    for (const section of sections()) expect(section.dataset.reveal).toBeUndefined()
    for (const text of SECTION_TEXT) expect(document.body.textContent).toContain(text)
    // WhenNear's own fallback is untouched: the windows still mount on first scroll.
    act(() => {
      window.dispatchEvent(new Event("scroll"))
    })
    expect(document.querySelectorAll("[data-hubble-demo]")).toHaveLength(6)
  })

  it("for a visitor who prefers reduced motion, hides nothing", () => {
    stubMotion(true)
    vi.stubGlobal("IntersectionObserver", ManualObserver)
    belowTheFold()
    renderPage()
    for (const section of sections()) expect(section.dataset.reveal).toBeUndefined()
  })

  it("forces content visible in CSS under reduced motion, whatever state a section is in", () => {
    const css = readFileSync(join(process.cwd(), "src/app/marketing.css"), "utf8")
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(block).toMatch(/\.m-reveal \.m-reveal-item\s*\{[^}]*opacity:\s*1 !important;[^}]*transform:\s*none !important;[^}]*transition:\s*none !important;/)
    // The revealed state sets no transform, so it never becomes a containing block for the windows' fixed tooltips.
    const revealed = css.match(/\.m-reveal\[data-reveal="revealed"\] \.m-reveal-item\s*\{([^}]*)\}/)
    expect(revealed?.[1]).not.toMatch(/(^|[^-])transform:/)
  })
})
