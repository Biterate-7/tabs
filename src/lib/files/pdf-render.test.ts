// @vitest-environment node
import { describe, expect, it } from "vitest"
import { extractFile } from "./extract"
import { mathExamPdf, scannedPdf, textPdf } from "./__fixtures__/pdf"

/**
 * The reader draws the original PDF, so what a person sees must be the page —
 * not the text Hubble extracted from it. These tests draw real PDFs with the
 * same pdf.js the reader uses (on a Node canvas) and look at the pixels:
 * a graph, a diagram, a fraction bar or a scanned page is *there*, even where
 * the extracted text has nothing for it.
 */

type Canvas = { width: number; height: number; getContext: (kind: "2d") => { getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } }; toBuffer: (type: "image/png") => Buffer }

const NOW = Date.UTC(2026, 9, 19)
// pdf.js draws on a Node canvas only where its optional @napi-rs/canvas binary exists for this platform.
const canvasAvailable = await import("@napi-rs/canvas").then(() => true).catch(() => false)

async function draw(bytes: Uint8Array<ArrayBuffer>, scale = 1): Promise<Canvas[]> {
  const { createCanvas } = await import("@napi-rs/canvas")
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const loading = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/" })
  const document = await loading.promise
  const pages: Canvas[] = []
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext("2d")
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context as never, canvas: canvas as never, viewport }).promise
    pages.push(canvas as unknown as Canvas)
  }
  await loading.destroy()
  return pages
}

/** How many pixels in a region (in PDF points from the page's top-left) are not paper-white. */
function ink(canvas: Canvas, x: number, y: number, width: number, height: number, test: (r: number, g: number, b: number) => boolean = (r, g, b) => r < 200 || g < 200 || b < 200): number {
  const { data } = canvas.getContext("2d").getImageData(x, y, width, height)
  let count = 0
  for (let at = 0; at < data.length; at += 4) if (test(data[at]!, data[at + 1]!, data[at + 2]!)) count += 1
  return count
}

describe.skipIf(!canvasAvailable)("the original PDF is drawn, not its text", () => {
  it("draws every page of a mathematics paper with its equations, graph, diagrams and answer boxes", async () => {
    const pages = await draw(mathExamPdf())
    expect(pages).toHaveLength(3)
    expect(pages.every((page) => page.width === 612 && page.height === 792)).toBe(true)

    // Page 1: the equation line, the fraction bar between numerator and denominator, the radical sign, an answer box's outline.
    expect(ink(pages[0]!, 110, 140, 100, 20)).toBeGreaterThan(80)
    expect(ink(pages[0]!, 125, 303, 62, 3)).toBeGreaterThan(50)
    expect(ink(pages[0]!, 108, 456, 20, 18)).toBeGreaterThan(10)
    expect(ink(pages[0]!, 110, 180, 380, 3)).toBeGreaterThan(300)

    // Page 2: the red curve of the graph, which is drawing and not text.
    const red = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80
    expect(ink(pages[1]!, 170, 130, 260, 220, red)).toBeGreaterThan(300)
    // Page 3: the triangle's slanted side and the circle.
    expect(ink(pages[2]!, 150, 150, 170, 130)).toBeGreaterThan(200)
    expect(ink(pages[2]!, 375, 440, 90, 90)).toBeGreaterThan(150)
  })

  it("has none of the graph or diagrams in the text Hubble extracted — so a transcript could never show them", async () => {
    const extraction = await extractFile(mathExamPdf(), "pdf", NOW)
    expect(extraction.status).toBe("ready")
    if (extraction.status !== "ready" || extraction.content.kind !== "pdf") throw new Error("expected text")
    const pages = extraction.content.pages ?? []
    expect(pages).toHaveLength(3)
    expect(pages[0]).toContain("Solve the quadratic equation")
    // The curve, axes, triangle and circle are strokes: nothing about them exists as text.
    expect(pages[1]).not.toMatch(/curve|parabola|axis/i)
    expect(pages[1]!.replace(/\s+/g, " ").length).toBeLessThan(400)
  })

  it("draws a scanned PDF, which has no text to extract at all", async () => {
    const bytes = scannedPdf(2)
    const extraction = await extractFile(bytes, "pdf", NOW)
    expect(extraction.status).toBe("partial")
    const pages = await draw(bytes)
    expect(pages).toHaveLength(2)
    // The picture of writing is there: dark bars across the page.
    expect(ink(pages[0]!, 60, 90, 500, 40, (r, g, b) => r < 60 && g < 60 && b < 60)).toBeGreaterThan(1000)
  })

  it("draws a plain text document and a long multi-page one", async () => {
    const lines = textPdf(Array.from({ length: 40 }, (_, page) => [`Chapter ${page + 1}`, "Entropy always increases in an isolated system."]))
    const pages = await draw(lines)
    expect(pages).toHaveLength(40)
    expect(ink(pages[39]!, 60, 50, 300, 30)).toBeGreaterThan(50)
    // Text and drawing agree on the page numbers.
    const extraction = await extractFile(lines, "pdf", NOW)
    if (extraction.status !== "ready" || extraction.content.kind !== "pdf") throw new Error("expected text")
    expect(extraction.content.pages?.[39]).toContain("Chapter 40")
  })
})
