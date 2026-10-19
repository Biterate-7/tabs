import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { FileDetailsDialog } from "./file-details-dialog"
import { documentNodes } from "./docx-viewer"
import { MarkdownViewer, safeHref } from "./markdown-viewer"
import { MARKDOWN_RENDER_LIMIT, showsOriginal } from "./file-reader"
import { makeDocx, p } from "@/lib/files/__fixtures__/docx"
import { composeFileNote } from "@/lib/files/note"
import { putContent, putFile, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { ProjectNote } from "@/lib/notes/notes"

/**
 * The reader for formats that are not PDFs: Markdown and Word documents are
 * formatted (never inserted as markup), other text formats stay text, and a
 * file that can't be shown says so and offers the text Hubble read. The PDF
 * reader is tested in pdf-viewer.test.tsx and project-files.test.tsx.
 */

const NOW = Date.UTC(2026, 9, 19)

function note(name: string, format: "markdown" | "docx" | "text" | "html", patch: Partial<NonNullable<ProjectNote["file"]>> = {}): ProjectNote {
  const base = composeFileNote({ id: "n1", name, format, size: 1000, hash: "0123456789abcdef", now: NOW })
  return { ...base, file: { ...base.file!, status: "ready", ...patch } }
}

function open(target: ProjectNote) {
  return render(<FileDetailsDialog note={target} workspaceId="w" onOpenChange={vi.fn()} onDownload={vi.fn()} onRetry={vi.fn()} onRemove={vi.fn()} />)
}

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

afterEach(() => resetContentStoreForTests())

describe("which files are drawn from their original", () => {
  it("is PDFs, Word documents and Markdown — once they have been kept and read, even a scan", () => {
    const file = (format: "pdf" | "docx" | "markdown" | "text" | "csv" | "json" | "html", status: "ready" | "partial" | "failed" | "processing") => ({ name: "x", format, size: 1, status, attempts: 1 }) as NonNullable<ProjectNote["file"]>
    for (const format of ["pdf", "docx", "markdown"] as const) {
      expect(showsOriginal(file(format, "ready"))).toBe(true)
      expect(showsOriginal(file(format, "partial"))).toBe(true)
      expect(showsOriginal(file(format, "failed"))).toBe(false)
      expect(showsOriginal(file(format, "processing"))).toBe(false)
    }
    // Text formats are their own text already; HTML is never run.
    for (const format of ["text", "csv", "json", "html"] as const) expect(showsOriginal(file(format, "ready"))).toBe(false)
  })
})

describe("Markdown", () => {
  it("is formatted: headings, lists, tables, quotes and code", () => {
    render(<MarkdownViewer label="Notes" source={"# Entropy\n\nA **measure** of _disorder_.\n\n- one\n- two\n\n1. first\n2. second\n\n| Law | Says |\n|---|---|\n| Second | S rises |\n\n> quoted\n\n```\nlet S = k * ln(W)\n```\n"} />)
    const doc = within(screen.getByRole("document", { name: "Notes" }))
    expect(doc.getByRole("heading", { name: "Entropy", level: 1 })).toBeTruthy()
    expect(doc.getByText("measure").tagName).toBe("STRONG")
    expect(doc.getAllByRole("listitem")).toHaveLength(4)
    expect(doc.getByRole("table")).toBeTruthy()
    expect(doc.getByRole("cell", { name: "S rises" })).toBeTruthy()
    expect(doc.getByText("let S = k * ln(W)").closest("pre")).toBeTruthy()
  })

  it("never runs what the file contains: HTML is text, scripts don't link, pictures aren't fetched", () => {
    const { container } = render(
      <MarkdownViewer label="Notes" source={'<script>alert(1)</script>\n\n<img src="https://tracker.example/x.png" onerror="alert(2)">\n\n[click](javascript:alert(3)) and [safe](https://example.com/page)\n\n![diagram](https://tracker.example/pixel.png)\n'} />
    )
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("[onerror]")).toBeNull()
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
    const links = [...container.querySelectorAll("a")]
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com/page"])
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer nofollow")
    expect(screen.getByText("[diagram]")).toBeTruthy()
  })

  it("keeps links to the web and email, and nothing else", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a")
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com")
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///C:/secret", "/relative", "#anchor", undefined]) expect(safeHref(bad)).toBeUndefined()
  })

  it("opens from the kept original in the file's dialog", async () => {
    await putFile("w", "n1", bytesOf("# Lecture notes\n\n- Entropy rises\n"), { name: "notes.md", type: "text/markdown", now: NOW })
    open(note("notes.md", "markdown"))
    const dialog = within(await screen.findByRole("dialog", { name: "notes" }))
    expect(await dialog.findByRole("heading", { name: "Lecture notes" })).toBeTruthy()
    expect(dialog.getByRole("listitem").textContent).toBe("Entropy rises")
    expect(dialog.queryByRole("region", { name: "Text from the file" })).toBeNull()
  })

  it("shows the first part of an enormous file and says so", async () => {
    await putFile("w", "n1", bytesOf(`# Start\n\n${"word ".repeat(MARKDOWN_RENDER_LIMIT / 4)}`), { name: "huge.md", type: "text/markdown", now: NOW })
    open(note("huge.md", "markdown"))
    const dialog = within(await screen.findByRole("dialog", { name: "huge" }))
    expect(await dialog.findByText(/only the first part is shown/)).toBeTruthy()
  })
})

describe("Word documents", () => {
  const html = '<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> text and a <a href="https://example.com">link</a>.</p><ul><li>one</li><li>two</li></ul><table><tr><th>A</th><td colspan="2">B</td></tr></table>'

  it("keep their headings, emphasis, lists, tables and links", () => {
    render(<div role="document">{documentNodes(html)}</div>)
    expect(screen.getByRole("heading", { name: "Title", level: 1 })).toBeTruthy()
    expect(screen.getByText("bold").tagName).toBe("STRONG")
    expect(screen.getByText("italic").tagName).toBe("EM")
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByRole("cell", { name: "B" }).getAttribute("colspan")).toBe("2")
    expect(screen.getByRole("link", { name: "link" }).getAttribute("href")).toBe("https://example.com/")
  })

  it("lose anything that could run, and any picture that isn't embedded in the file", () => {
    const hostile =
      '<p onclick="alert(1)">hi<script>alert(2)</script></p><iframe src="https://evil.example"></iframe><a href="javascript:alert(3)">bad</a>' +
      '<img src="https://tracker.example/x.png"><img alt="drawing" src="data:image/png;base64,iVBORw0KGgo=">' +
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'
    const { container } = render(<div>{documentNodes(hostile)}</div>)
    expect(container.querySelector("script,iframe")).toBeNull()
    expect(container.querySelector("[onclick]")).toBeNull()
    expect(container.querySelector("a")).toBeNull()
    expect(screen.getByText("bad")).toBeTruthy()
    const images = [...container.querySelectorAll("img")]
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["drawing"])
  })

  it("open from the kept original, formatted, with a note that page layout isn't reproduced", async () => {
    const body = p("Entropy ", "always increases.") + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Law</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
    await putFile("w", "n1", makeDocx(body).buffer, { name: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", now: NOW })
    open(note("report.docx", "docx"))
    const dialog = within(await screen.findByRole("dialog", { name: "report" }))
    expect(await dialog.findByText("Entropy always increases.")).toBeTruthy()
    expect(dialog.getByRole("cell", { name: "Second" })).toBeTruthy()
    expect(dialog.getByText(/page layout aren't reproduced/)).toBeTruthy()
    expect(dialog.queryByRole("region", { name: "Text from the file" })).toBeNull()
  })

  it("that can't be opened say so and offer the text Hubble read", async () => {
    await putContent("w", "n1", { kind: "document", extractedAt: NOW, text: "Entropy always increases." })
    await putFile("w", "n1", bytesOf("this is not a zip archive"), { name: "report.docx", type: "application/octet-stream", now: NOW })
    open(note("report.docx", "docx"))
    const dialog = within(await screen.findByRole("dialog", { name: "report" }))
    await waitFor(() => expect(dialog.getByRole("alert").textContent).toMatch(/couldn't show this Word document/))
    expect(await dialog.findByText("Entropy always increases.")).toBeTruthy()
  })
})

describe("formats that are text already", () => {
  it("stay as the text Hubble read, with no original to draw", async () => {
    await putContent("w", "n1", { kind: "document", extractedAt: NOW, text: "Heading\n<b>not bold</b>" })
    open(note("page.html", "html"))
    const dialog = within(await screen.findByRole("dialog", { name: "page" }))
    expect(await dialog.findByText(/<b>not bold<\/b>/)).toBeTruthy()
    expect(document.querySelector("[data-file-dialog] b")).toBeNull()
    expect(dialog.queryByRole("document")).toBeNull()
  })
})
