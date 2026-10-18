import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectHome } from "./project-home"
import { AddMenu } from "./add-menu"
import { MemoryActionsProvider } from "@/components/memory/memory-actions"
import { composeFileNote } from "@/lib/files/note"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { MemoryActions } from "@/components/memory/memory-actions"
import type { ProjectFileActions } from "./project-home"
import type { ResourceActions } from "@/hooks/use-resource-processing"
import type { UploadOutcome } from "@/hooks/use-file-uploads"
import type { ProjectNote } from "@/lib/notes/notes"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Files on the project page: + Add → Upload files, each chosen file's line
 * from adding to ready (or why not), file cards, a drop on the page, the
 * reader, and search into a file's pages. The upload pipeline itself is
 * tested in hooks/use-file-uploads.test.tsx; here it is a stub.
 */

const NOW = Date.UTC(2026, 9, 18, 12)
const resources: ResourceActions = { retry: vi.fn(), attachPdf: vi.fn(), attachTranscript: vi.fn(async () => ({})), forget: vi.fn() }

function file(id: string, name: string, patch: Partial<NonNullable<ProjectNote["file"]>> = {}, chars = 0): ProjectNote {
  const base = composeFileNote({ id, name, format: name.endsWith(".pdf") ? "pdf" : "markdown", size: 4096, hash: id.padEnd(16, "0").slice(0, 16), now: NOW - 60_000 })
  return { ...base, chars, file: { ...base.file!, ...patch } }
}

function project(notes: ProjectNote[] = []): Workspace {
  return { id: "w", name: "Physics HL", tabs: [], sections: [], createdAt: 1, updatedAt: 1, ...(notes.length ? { notes } : {}) }
}

function renderHome(workspace: Workspace, files: Partial<ProjectFileActions> = {}) {
  const notes = { update: vi.fn(), saveText: vi.fn(async () => true), remove: vi.fn() }
  const actions: ProjectFileActions = { upload: vi.fn(async () => []), retry: vi.fn(), download: vi.fn(), ...files }
  const memory: MemoryActions = { currentWorkspaceId: workspace.id, reuse: vi.fn() }
  const props = {
    workspace,
    now: NOW,
    onAddSources: vi.fn(() => []),
    resources,
    notes,
    files: actions,
    onRenameSource: vi.fn(),
    onRemoveSources: vi.fn(),
    onOpenSource: vi.fn(),
    onCapture: vi.fn(),
  }
  const view = render(
    <MemoryActionsProvider value={memory}>
      <ProjectHome {...props} />
    </MemoryActionsProvider>
  )
  const rerender = (next: Workspace) =>
    view.rerender(
      <MemoryActionsProvider value={memory}>
        <ProjectHome {...props} workspace={next} />
      </MemoryActionsProvider>
    )
  return { ...props, memory, rerender }
}

afterEach(() => {
  localStorage.clear()
  resetContentStoreForTests()
})

describe("+ Add → Upload files", () => {
  it("is offered in the Add menu, apart from importing AI chats", async () => {
    const user = userEvent.setup()
    const onUpload = vi.fn()
    render(<AddMenu subjectName="Physics HL" onAdd={() => []} onOpenLink={vi.fn()} onCapture={vi.fn()} onUpload={onUpload} />)
    await user.click(screen.getByRole("button", { name: /^Add/ }))
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["Paste a conversation", "Write a note", "Import AI chats", "Upload files", "Browser tabs", "Link"])
    await user.click(screen.getByRole("menuitem", { name: "Upload files" }))
    expect(onUpload).toHaveBeenCalledOnce()
  })

  it("uploads the chosen files and follows each one: adding, reading, ready — or why not", async () => {
    // A picker's "All files" lets anything through the accept filter; Hubble still says what it can't read.
    const user = userEvent.setup({ applyAccept: false })
    let report: ((index: number, outcome: UploadOutcome) => void) | undefined
    const upload = vi.fn(async (_files: readonly File[], onOutcome: (index: number, outcome: UploadOutcome) => void) => {
      report = onOutcome
      return []
    })
    const home = renderHome(project(), { upload })
    await user.click(screen.getByRole("button", { name: "Upload files" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Upload files" }))
    expect(dialog.getByText("PDF, Word, Markdown or text · up to 25 MB each")).toBeTruthy()

    const lecture = new File(["%PDF-1.4"], "Lecture 4.pdf", { type: "application/pdf" })
    const notes = new File(["# notes"], "notes.md", { type: "text/markdown" })
    const old = new File(["x"], "old.doc")
    await user.upload(dialog.getByLabelText("Choose files to add to Physics HL"), [lecture, notes, old])
    expect(upload).toHaveBeenCalledWith([lecture, notes, old], expect.any(Function))
    const rows = within(dialog.getByRole("list", { name: "Chosen files" }))
    expect(rows.getAllByText("Adding…")).toHaveLength(3)

    act(() => {
      report!(0, { status: "added", name: "Lecture 4.pdf", noteId: "n1" })
      report!(1, { status: "added", name: "notes.md", noteId: "n2" })
      report!(2, { status: "rejected", name: "old.doc", message: "Older Word files (.doc) can't be read. Save it as .docx or PDF and add that." })
    })
    // The project now lists the two files; their lines follow the project's records.
    home.rerender(project([file("n1", "Lecture 4.pdf"), file("n2", "notes.md", { status: "ready" }, 600)]))
    const lines = within(screen.getByRole("dialog", { name: "Upload files" }))
    expect(lines.getByText("Reading…")).toBeTruthy()
    expect(lines.getByText(/100 words/)).toBeTruthy()
    expect(lines.getByText("Can't add")).toBeTruthy()
    expect(lines.getByText(/Save it as \.docx or PDF/)).toBeTruthy()
    expect(lines.getByText(/you can close this/)).toBeTruthy()

    home.rerender(project([file("n1", "Lecture 4.pdf", { status: "failed", error: { code: "interrupted", message: "Reading was interrupted several times. Try again.", retryable: true } }), file("n2", "notes.md", { status: "ready" }, 600)]))
    await user.click(within(screen.getByRole("dialog", { name: "Upload files" })).getByRole("button", { name: "Read Lecture 4.pdf again" }))
    expect(home.files.retry).toHaveBeenCalledWith("n1")
  })

  it("uploads a file dropped anywhere on the project, and shows its progress", async () => {
    const home = renderHome(project())
    const dropped = new File(["# notes"], "notes.md", { type: "text/markdown" })
    const transfer = { types: ["Files"], getData: () => "", files: [dropped], dropEffect: "none" }
    act(() => {
      fireEvent.dragEnter(window, { dataTransfer: transfer })
      fireEvent.dragOver(window, { dataTransfer: transfer })
    })
    act(() => void fireEvent.drop(window, { dataTransfer: transfer }))
    expect(home.files.upload).toHaveBeenCalledWith([dropped], expect.any(Function))
    expect(await screen.findByRole("dialog", { name: "Upload files" })).toBeTruthy()
  })
})

describe("files in the project", () => {
  const lecture = file("n1", "Lecture 4.pdf", { status: "ready", pages: 3 }, 300)
  const scan = file("n2", "Scanned handout.pdf", { status: "partial", pages: 2, error: { code: "no_text", message: "No text found — this PDF may be a scan. Hubble can't read scanned pages.", retryable: false } })
  const failed = file("n3", "notes.md", { status: "failed", error: { code: "interrupted", message: "Hubble read this file but couldn't save its text on this device. Try again.", retryable: true } })
  const reading = file("n4", "Big book.pdf")

  it("are listed with the other sources, each saying only what isn't simply ready", async () => {
    const user = userEvent.setup()
    const home = renderHome(project([lecture, scan, failed, reading]))
    const list = within(screen.getByRole("list", { name: "Knowledge in Physics HL" }))
    const card = (id: string) => within(list.getAllByRole("listitem").find((item) => item.getAttribute("data-file-card") === id)!)

    expect(card("n1").getByText("· 3 pages")).toBeTruthy()
    expect(card("n1").queryByText("Ready")).toBeNull()
    expect(card("n2").getByText("Saved")).toBeTruthy()
    expect(card("n2").getByText(/may be a scan/)).toBeTruthy()
    expect(card("n2").queryByRole("button", { name: /again/ })).toBeNull()
    expect(card("n4").getByText("Reading…")).toBeTruthy()
    // Only a ready file can be used in an AI chat.
    expect(card("n4").queryByRole("button", { name: /in an AI chat/ })).toBeNull()

    await user.click(card("n3").getByRole("button", { name: "Read notes again" }))
    expect(home.files.retry).toHaveBeenCalledWith("n3")
    await user.click(card("n1").getByRole("button", { name: "Use Lecture 4 in an AI chat" }))
    expect(home.memory.reuse).toHaveBeenCalledWith({ workspaceId: "w", refs: [{ kind: "note", noteId: "n1" }] })

    await user.click(card("n1").getByRole("button", { name: "More actions for Lecture 4" }))
    await user.click(await screen.findByRole("menuitem", { name: "Download original" }))
    expect(home.files.download).toHaveBeenCalledWith("n1")
    await user.click(card("n1").getByRole("button", { name: "More actions for Lecture 4" }))
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }))
    expect(home.notes.remove).toHaveBeenCalledWith(["n1"])
  })

  it("open in a reader that shows the text page by page, as text", async () => {
    const user = userEvent.setup()
    await putContent("w", "n1", { kind: "pdf", extractedAt: NOW, pages: ["Introduction.", "<b>Entropy</b> always increases.", ""] })
    renderHome(project([lecture]))
    await user.click(screen.getByRole("button", { name: "Read Lecture 4" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Lecture 4" }))
    expect(dialog.getByText("Lecture 4.pdf")).toBeTruthy()
    expect(await dialog.findByText("<b>Entropy</b> always increases.")).toBeTruthy()
    expect(dialog.getByRole("article", { name: "Page 2" })).toBeTruthy()
    expect(dialog.getByText("No text on this page.")).toBeTruthy()
    expect(document.querySelector("[data-file-dialog] b")).toBeNull()
  })

  it("are found by what their pages say, and a hit opens the file at that page", async () => {
    const user = userEvent.setup()
    await putContent("w", "n1", { kind: "pdf", extractedAt: NOW, pages: ["Introduction.", "Entropy always increases in an isolated system.", "The third law."] })
    renderHome(project([lecture, scan]))
    await user.type(screen.getByPlaceholderText("Search Physics HL…"), "isolated system")
    const results = within(await screen.findByRole("list", { name: "Search results" }))
    const hit = await results.findByText(/page 2/)
    await user.click(hit)
    const dialog = await screen.findByRole("dialog", { name: "Lecture 4" })
    await waitFor(() => expect(within(dialog).getByRole("article", { name: "Page 2" })).toBeTruthy())
  })
})

describe("Use in AI chat with uploaded files", () => {
  it("takes every file at once, quotes the ones Hubble read with their pages, and names the ones it couldn't", async () => {
    const { ReuseDialog } = await import("@/components/memory/reuse-dialog")
    const user = userEvent.setup()
    const lecture = file("n1", "Lecture 4.pdf", { status: "ready", pages: 2 }, 80)
    const scan = file("n2", "Scanned handout.pdf", { status: "partial", error: { code: "no_text", message: "No text found — this PDF may be a scan. Hubble can't read scanned pages.", retryable: false } })
    await putContent("w", "n1", { kind: "pdf", extractedAt: NOW, pages: ["Heat engines.", "Entropy always increases in an isolated system."] })
    render(<ReuseDialog open onOpenChange={vi.fn()} workspace={project([lecture, scan])} initialRefs={[]} />)
    const dialog = within(await screen.findByRole("dialog", { name: "Use in AI chat" }))
    expect(dialog.getByText("no text")).toBeTruthy()
    await user.click(dialog.getByRole("button", { name: "Select all" }))
    await user.type(dialog.getByPlaceholderText("Optional — picks the most relevant parts"), "entropy")
    const preview = dialog.getByLabelText("Text to paste into an AI chat") as HTMLTextAreaElement
    await waitFor(() => expect(preview.value).toContain("> (p. 2) Entropy always increases in an isolated system."))
    expect(preview.value).toContain("_uploaded file “Lecture 4.pdf”, 2 pages")
    expect(preview.value).toContain("say which document — and the page")
    expect(preview.value).toContain("#### Scanned handout")
    expect(preview.value).toContain("Nothing from it is quoted here.")
    expect(dialog.getByRole("button", { name: "Select none" })).toBeTruthy()
  })
})
