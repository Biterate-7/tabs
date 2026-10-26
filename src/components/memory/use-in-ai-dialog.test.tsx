import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ReuseDialog } from "./reuse-dialog"
import { composeFileNote } from "@/lib/files/note"
import { putContent, putFile, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { ProjectNote } from "@/lib/notes/notes"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The Use in AI dialog end to end in the page, with a stand-in for Hubble
 * for Chrome listening on the window (the real content script's place):
 * which app, which mode, which files and which text actually leave Hubble,
 * and what the person is told at each outcome.
 */

const openExternal = vi.fn(async (url: string) => void url)
const saveFile = vi.fn(async () => true)
vi.mock("@/lib/platform", async (original) => ({ ...(await original<typeof import("@/lib/platform")>()), openExternal: (url: string) => openExternal(url), saveFile: () => saveFile() }))

const SOURCE = "tabdump-extension"
const NOW = Date.UTC(2026, 9, 19, 9)
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 lecture")

function fileNote(id: string, name: string, size: number, chars: number): ProjectNote {
  const base = composeFileNote({ id, name, format: "pdf", size, hash: id.padEnd(16, "0").slice(0, 16), now: NOW })
  return { ...base, chars, file: { ...base.file!, status: "ready", pages: 1 } }
}

const lecture = fileNote("lect1", "Lecture 4.pdf", PDF_BYTES.byteLength, 40)
const workspace: Workspace = { id: "w", name: "Physics HL", tabs: [], sections: [], createdAt: 1, updatedAt: 1, notes: [lecture] } as Workspace

type Seen = { type: string; payload: Record<string, unknown> }
let seen: Seen[] = []
let listener: ((event: MessageEvent) => void) | undefined
let answer: (payload: Record<string, unknown>) => Record<string, unknown> | undefined

/** Hubble for Chrome, as the page sees it: answers the hello, takes a transfer, reports progress, answers. */
function installExtension() {
  listener = (event: MessageEvent) => {
    const data = event.data
    if (data?.source !== SOURCE) return
    const reply = (type: string, payload: unknown) => window.postMessage({ source: SOURCE, type, payload }, window.location.origin)
    if (data.type === "HUBBLE_AI_TRANSFER_HELLO") reply("HUBBLE_AI_TRANSFER_HELLO_RESULT", { requestId: data.payload.requestId, protocol: 1 })
    if (data.type === "HUBBLE_AI_TRANSFER") {
      seen.push({ type: data.type, payload: data.payload })
      reply("HUBBLE_AI_TRANSFER_PROGRESS", { opId: data.payload.opId, state: "inserting" })
      const result = answer(data.payload)
      if (result) setTimeout(() => reply("HUBBLE_AI_TRANSFER_RESULT", { opId: data.payload.opId, ...result }), 10)
    }
  }
  window.addEventListener("message", listener)
}

beforeEach(async () => {
  resetContentStoreForTests()
  seen = []
  answer = () => ({ ok: true, state: "ready-for-review", attached: ["Lecture 4.pdf"], notAttached: [], usedFallback: false, reusedTab: false })
  openExternal.mockClear()
  saveFile.mockClear()
  window.localStorage.clear()
  await putContent("w", lecture.id, { kind: "pdf", extractedAt: NOW, pages: ["Entropy always increases in an isolated system."] })
  await putFile("w", lecture.id, PDF_BYTES.buffer.slice(0) as ArrayBuffer, { name: "Lecture 4.pdf", type: "application/pdf", now: NOW })
})

afterEach(() => {
  if (listener) window.removeEventListener("message", listener)
  listener = undefined
})

function renderDialog(props: Partial<Parameters<typeof ReuseDialog>[0]> = {}) {
  const onTransferred = vi.fn()
  render(<ReuseDialog open onOpenChange={vi.fn()} workspace={workspace} initialRefs={[{ kind: "note", noteId: lecture.id }]} onTransferred={onTransferred} {...props} />)
  return { dialog: within(screen.getByRole("dialog", { name: "Use in AI" })), onTransferred }
}

describe("Use in AI with Hubble for Chrome", () => {
  beforeEach(installExtension)

  it("prepares by default: opens the chosen app with the instructions, the message and the original PDF — never asking to send", async () => {
    const user = userEvent.setup()
    const { dialog, onTransferred } = renderDialog()
    await user.click(dialog.getByRole("radio", { name: "Claude" }))
    expect(dialog.getByRole("radio", { name: "Prepare message" }).getAttribute("aria-checked")).toBe("true")
    await user.type(dialog.getByLabelText("Instructions"), "Summarize these documents and identify the key arguments.")
    const action = await dialog.findByRole("button", { name: "Open in Claude" })
    await waitFor(() => expect(action.hasAttribute("disabled")).toBe(false))
    await user.click(action)

    await waitFor(() => expect(seen).toHaveLength(1))
    const sent = seen[0]!.payload as { provider: string; mode: string; text: string; fallbackText?: string; files: { name: string; type: string; size: number; data: string }[] }
    expect(sent.provider).toBe("claude")
    expect(sent.mode).toBe("prepare")
    expect(sent.text).toContain("The original file, “Lecture 4.pdf”, is attached to this message.")
    expect(sent.text.endsWith("**What I want to do now:** Summarize these documents and identify the key arguments.")).toBe(true)
    expect(sent.fallbackText).toContain("> (p. 1) Entropy always increases in an isolated system.")
    expect(sent.files).toEqual([{ name: "Lecture 4.pdf", type: "application/pdf", size: PDF_BYTES.byteLength, data: btoa("%PDF-1.4 lecture") }])

    expect(await dialog.findByText("Ready in Claude. Review it there, then send it yourself.")).toBeTruthy()
    expect(dialog.getByText("Attached Lecture 4.pdf.")).toBeTruthy()
    expect(onTransferred).toHaveBeenCalledWith({ items: 1, provider: "claude", sent: false })
    expect(window.localStorage.getItem("hubble.useInAi.provider")).toBe("claude")
  })

  it("shows the message as formatted text, keeps its Markdown for Edit, and sends the Markdown unchanged", async () => {
    const user = userEvent.setup()
    const { dialog } = renderDialog()
    await user.click(await dialog.findByRole("checkbox", { name: "Attach original files" }))
    const reading = await dialog.findByRole("region", { name: "Message for the AI app" })
    await waitFor(() => expect(reading.textContent).toContain("Entropy always increases in an isolated system."))
    expect(reading.textContent).not.toMatch(/^#|\*\*|^> /m)
    expect(reading.querySelector("h1,h2,h3,h4,h5,h6")).toBeTruthy()
    expect(reading.className).not.toContain("font-mono")

    await user.click(dialog.getByRole("button", { name: "Edit" }))
    const editor = dialog.getByLabelText("Message for the AI app") as HTMLTextAreaElement
    expect(editor.className).not.toContain("font-mono")
    expect(editor.value).toMatch(/^#/m)
    await user.click(dialog.getByRole("button", { name: "Done" }))

    await user.click(dialog.getByRole("button", { name: "Open in ChatGPT" }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.payload.text).toBe(editor.value)
  })

  it("sends only when the person chooses Send automatically, and says sent only when it was", async () => {
    answer = () => ({ ok: true, state: "submitted", attached: [], notAttached: [], usedFallback: false, reusedTab: true })
    const user = userEvent.setup()
    const { dialog, onTransferred } = renderDialog()
    await user.click(await dialog.findByRole("radio", { name: "Send automatically" }))
    await user.click(await dialog.findByRole("button", { name: "Send to ChatGPT" }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.payload.mode).toBe("send")
    expect(await dialog.findByText("Sent in ChatGPT.")).toBeTruthy()
    expect(onTransferred).toHaveBeenCalledWith({ items: 1, provider: "chatgpt", sent: true })
  })

  it("sends the text instead of the file when attaching is turned off", async () => {
    const user = userEvent.setup()
    const { dialog } = renderDialog()
    await user.click(await dialog.findByRole("checkbox", { name: "Attach original files" }))
    await user.click(dialog.getByRole("button", { name: "Open in ChatGPT" }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.payload.files).toEqual([])
    expect(seen[0]!.payload.text).toContain("> (p. 1) Entropy always increases")
    expect(seen[0]!.payload.fallbackText).toBeUndefined()
  })

  it("says what failed and retries the same operation, so the extension never types twice", async () => {
    let calls = 0
    answer = () => (++calls === 1 ? { ok: false, error: "composer-has-draft" } : { ok: true, state: "ready-for-review", attached: [], notAttached: [], usedFallback: false, reusedTab: false })
    const user = userEvent.setup()
    const { dialog } = renderDialog()
    await user.click(await dialog.findByRole("button", { name: "Open in ChatGPT" }))
    expect(await dialog.findByText(/already has text you haven't sent, and Hubble won't overwrite it/)).toBeTruthy()
    await user.click(dialog.getByRole("button", { name: "Try again" }))
    expect(await dialog.findByText(/Ready in ChatGPT/)).toBeTruthy()
    expect(seen).toHaveLength(2)
    expect(seen[1]!.payload.opId).toBe(seen[0]!.payload.opId)
  })

  it("is honest when a file didn't attach: names it, and says its text went instead", async () => {
    answer = () => ({ ok: true, state: "ready-for-review", attached: [], notAttached: [{ name: "Lecture 4.pdf", reason: "Gemini didn't show it as attached" }], usedFallback: true, reusedTab: false })
    const user = userEvent.setup()
    const { dialog } = renderDialog()
    await user.click(dialog.getByRole("radio", { name: "Gemini" }))
    await user.click(await dialog.findByRole("button", { name: "Open in Gemini" }))
    expect(await dialog.findByText(/Lecture 4.pdf: Gemini didn't show it as attached — so the files' text was put in the message instead./)).toBeTruthy()
  })

  it("re-plans a file whose original is missing on this device as text before sending", async () => {
    // A file whose original was never kept on this device (its text was).
    const elsewhere = fileNote("away1", "Lecture 4.pdf", PDF_BYTES.byteLength, 40)
    await putContent("w", elsewhere.id, { kind: "pdf", extractedAt: NOW, pages: ["Entropy always increases in an isolated system."] })
    const user = userEvent.setup()
    const { dialog } = renderDialog({ workspace: { ...workspace, notes: [elsewhere] } as Workspace, initialRefs: [{ kind: "note", noteId: elsewhere.id }] })
    await user.click(await dialog.findByRole("button", { name: "Open in ChatGPT" }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.payload.files).toEqual([])
    expect(seen[0]!.payload.text).not.toContain("is attached to this message")
    expect(seen[0]!.payload.text).toContain("Entropy always increases")
  })
})

describe("Use in AI without Hubble for Chrome", () => {
  it("copies the message (files as text), opens the app, and offers the originals to attach by hand", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const { dialog } = renderDialog()
    const action = await dialog.findByRole("button", { name: "Copy & open ChatGPT" }, { timeout: 3000 })
    expect(dialog.queryByRole("radio", { name: "Send automatically" })).toBeNull()
    expect(await dialog.findByText(/Install Hubble for Chrome/)).toBeTruthy()
    await user.click(action)
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(copied).toContain("Entropy always increases")
    expect(copied).not.toContain("is attached to this message")
    expect(openExternal).toHaveBeenCalledWith("https://chatgpt.com/")
    expect(await dialog.findByText(/Copied, and ChatGPT opened in a new tab/)).toBeTruthy()
    await user.click(dialog.getByRole("button", { name: "Lecture 4.pdf" }))
    await waitFor(() => expect(saveFile).toHaveBeenCalled())
  })
})

describe("Use in AI in Hubble Desktop", () => {
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it("says it can't type into the browser, and copies and opens the app there instead", async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const { dialog } = renderDialog()
    expect(await dialog.findByText(/Hubble Desktop can't type into your browser/)).toBeTruthy()
    await user.click(dialog.getByRole("radio", { name: "Perplexity" }))
    await user.click(dialog.getByRole("button", { name: "Copy & open Perplexity" }))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith("https://www.perplexity.ai/")
    expect(await dialog.findByText(/Copied, and Perplexity opened in your browser/)).toBeTruthy()
  })
})
