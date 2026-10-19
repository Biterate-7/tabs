import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PdfViewer, ZOOM_STEPS } from "./pdf-viewer"
import { fakePdfView } from "@/lib/files/__fixtures__/fake-pdf-view"
import { findMatchRanges, PDF_HIGHLIGHT_NAME } from "@/lib/files/pdf-highlight"
import { paintRatio, MAX_CANVAS_PIXELS } from "@/lib/files/pdf-view"

/**
 * The page column of the reader: continuous pages boxed at their real size,
 * only those near the screen painted, zoom and fit, opening at a search
 * hit's page and marking its words. Drawn against a fake PdfView (see
 * fake-pdf-view.ts); the pixels themselves are checked in pdf-render.test.ts.
 */

let observers: { callback: IntersectionObserverCallback; targets: Set<Element> }[] = []

class FakeIntersectionObserver {
  readonly entry: { callback: IntersectionObserverCallback; targets: Set<Element> }
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, targets: new Set() }
    observers.push(this.entry)
  }
  observe(element: Element) {
    this.entry.targets.add(element)
  }
  unobserve(element: Element) {
    this.entry.targets.delete(element)
  }
  disconnect() {
    this.entry.targets.clear()
  }
}

/** Pages `near` are on screen; the rest are not. */
function scrollTo(near: number[]) {
  act(() => {
    for (const { callback, targets } of observers) {
      const entries = [...targets].map((target) => ({ target, isIntersecting: near.includes(Number((target as HTMLElement).dataset.filePage)) }))
      callback(entries as IntersectionObserverEntry[], {} as IntersectionObserver)
    }
  })
}

const scrolled: number[] = []

beforeEach(() => {
  observers = []
  scrolled.length = 0
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
  // jsdom has no layout: page n sits at 1000 * (n - 1), and every scroll position set is recorded.
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get: function (this: HTMLElement) {
      return Number(this.dataset.filePage ?? 1) * 1000 - 1000
    },
  })
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrolled[scrolled.length - 1] ?? 0,
    set: (value: number) => void scrolled.push(value),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop
})

const pages = (count: number) => Array.from({ length: count }, (_, index) => `Text of page ${index + 1}`)

describe("PdfViewer", () => {
  it("boxes every page of a long file at its real proportions but paints only the pages near the screen", async () => {
    const view = fakePdfView(pages(300))
    render(<PdfViewer view={view} label="Lecture" />)
    expect(await screen.findByRole("article", { name: "Page 1" })).toBeTruthy()
    expect(screen.getAllByRole("article")).toHaveLength(300)
    // US Letter: 612 × 792 → every box is 1.294 as tall as wide.
    const first = screen.getByRole("article", { name: "Page 1" })
    expect(Number.parseInt(first.style.height) / Number.parseInt(first.style.width)).toBeCloseTo(792 / 612, 2)
    expect(view.painted).toHaveLength(0)

    scrollTo([1, 2])
    await waitFor(() => expect(view.painted.map((paint) => paint.page).sort()).toEqual([1, 2]))
    expect(screen.getByText("Page 1 of 300")).toBeTruthy()

    // Scrolling far away gives the first pages' pixels back and paints the new ones.
    scrollTo([150])
    await waitFor(() => expect(view.painted.some((paint) => paint.page === 150)).toBe(true))
    await waitFor(() => expect(view.released).toEqual(expect.arrayContaining([1, 2])))
    expect(view.painted.some((paint) => paint.page === 149)).toBe(false)
    expect(first.querySelector("canvas")).toBeNull()
    expect(screen.getByRole("article", { name: "Page 150" }).querySelector("canvas")).toBeTruthy()
  })

  it("lays each page's text over it, so words can be selected", async () => {
    render(<PdfViewer view={fakePdfView(pages(3))} label="Lecture" />)
    await screen.findByRole("article", { name: "Page 1" })
    scrollTo([2])
    const page = screen.getByRole("article", { name: "Page 2" })
    await waitFor(() => expect(page.querySelector(".pdf-text-layer")?.textContent).toBe("Text of page 2"))
  })

  it("opens at the page a search hit named", async () => {
    render(<PdfViewer view={fakePdfView(pages(12))} label="Lecture" focusPage={7} />)
    await screen.findByRole("article", { name: "Page 7" })
    // Page 7 sits at 6000; the viewer scrolls to it, a little margin above.
    await waitFor(() => expect(scrolled).toContain(6000 - 12))
  })

  it("zooms in steps, and fits to width again", async () => {
    const view = fakePdfView(pages(2))
    render(<PdfViewer view={view} label="Lecture" />)
    const page = await screen.findByRole("article", { name: "Page 1" })
    const fit = Number.parseInt(page.style.width)
    expect(screen.getByRole("button", { name: "Fit to width" }).textContent).toBe("100%")

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(Number.parseInt(page.style.width)).toBe(Math.round(fit * 1.25))
    expect(screen.getByRole("button", { name: "Fit to width" }).textContent).toBe("125%")
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }))
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }))
    expect(Number.parseInt(page.style.width)).toBe(Math.round(fit * 0.75))
    fireEvent.click(screen.getByRole("button", { name: "Fit to width" }))
    expect(Number.parseInt(page.style.width)).toBe(fit)

    // The end of the range disables its button.
    for (let index = 0; index < ZOOM_STEPS.length; index++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("repaints at the new size after a zoom", async () => {
    const view = fakePdfView(pages(1))
    render(<PdfViewer view={view} label="Lecture" />)
    await screen.findByRole("article", { name: "Page 1" })
    scrollTo([1])
    await waitFor(() => expect(view.painted).toHaveLength(1))
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    await waitFor(() => expect(view.painted).toHaveLength(2))
    expect(view.painted[1]!.scale).toBeCloseTo(view.painted[0]!.scale * 1.25, 2)
  })

  it("marks the searched words in the text over the page, and only those", async () => {
    class FakeHighlight {
      ranges: Range[]
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
    const registry = new Map<string, FakeHighlight>()
    vi.stubGlobal("Highlight", FakeHighlight)
    vi.stubGlobal("CSS", { highlights: { set: (name: string, value: FakeHighlight) => void registry.set(name, value), delete: (name: string) => void registry.delete(name) } })
    const view = fakePdfView(["Entropy always increases in an isolated system.", "The third law."])
    const { unmount } = render(<PdfViewer view={view} label="Lecture" terms={["entropy", "isolated"]} />)
    await screen.findByRole("article", { name: "Page 1" })
    scrollTo([1, 2])
    await waitFor(() => expect(registry.get(PDF_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual(["Entropy", "isolated"]))
    unmount()
    // Nothing stays marked once the reader closes.
    expect(registry.has(PDF_HIGHLIGHT_NAME)).toBe(false)
  })

  it("says so when a page can't be drawn, and keeps the others", async () => {
    const view = fakePdfView(pages(2))
    const original = view.page.bind(view)
    let calls = 0
    view.page = async (number) => {
      // The first request is the viewer sizing its boxes from page 1.
      if (number === 2 && ++calls > 0) throw new Error("bad page")
      return original(number)
    }
    render(<PdfViewer view={view} label="Lecture" />)
    await screen.findByRole("article", { name: "Page 1" })
    scrollTo([1, 2])
    expect(await screen.findByText("This page couldn't be drawn.")).toBeTruthy()
    expect(view.painted.map((paint) => paint.page)).toEqual([1])
  })

  it("says so when the first page can't be read", async () => {
    const view = fakePdfView(pages(2))
    view.page = async () => {
      throw new Error("damaged")
    }
    render(<PdfViewer view={view} label="Lecture" />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/first page couldn't be drawn/)
  })
})

describe("search marks", () => {
  it("finds each searched word in a page's text, with the search's own matching", () => {
    const root = document.createElement("div")
    root.innerHTML = "<span>Entropy always</span><span> increases; ENTROPY</span>"
    expect(findMatchRanges(root, ["entropy"]).map((range) => range.toString())).toEqual(["Entropy", "ENTROPY"])
    expect(findMatchRanges(root, [])).toEqual([])
  })
})

describe("page canvases", () => {
  it("are sharp on dense screens but never larger than a browser can hold", () => {
    expect(paintRatio(600, 800, 1)).toBe(1)
    expect(paintRatio(600, 800, 3)).toBe(2)
    const huge = paintRatio(6000, 8000, 2)
    expect(6000 * 8000 * huge * huge).toBeLessThanOrEqual(MAX_CANVAS_PIXELS * 1.001)
  })
})
