import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useRef, useState } from "react"
import { useFileUploads } from "./use-file-uploads"
import { makeTestPdf } from "@/lib/resources/__fixtures__/pdf"
import { deleteContent, getContent, getFile, getProjectContents, putContent, putFile, pruneContentExcept, resetContentStoreForTests } from "@/lib/resources/content-store"
import { composeFileNote } from "@/lib/files/note"
import { removeProjectNotes } from "@/lib/notes/notes"
import { setStorageNamespace } from "@/lib/storage/namespace"
import type { FileUploadDeps, UploadOutcome } from "./use-file-uploads"
import type { ProjectNote } from "@/lib/notes/notes"
import type { WorkspaceStore } from "@/lib/workspace/types"

const saveFile = vi.hoisted(() => vi.fn(async () => true))
vi.mock("@/lib/platform", async (original) => ({ ...(await original<typeof import("@/lib/platform")>()), saveFile }))

/**
 * Uploaded files across their life in a project — chosen, kept, read,
 * re-read after a reload, retried, downloaded and removed — against the real
 * content store (fake-indexeddb), the real readers and the real note model.
 */

const NOW = Date.UTC(2026, 9, 18, 12)

function world(notes: { physics?: ProjectNote[]; history?: ProjectNote[] } = {}): WorkspaceStore {
  return {
    version: 1,
    currentId: "physics",
    workspaces: [
      { id: "physics", name: "Physics", tabs: [], sections: [], createdAt: 1, updatedAt: 1, ...(notes.physics ? { notes: notes.physics } : {}) },
      { id: "history", name: "History", tabs: [], sections: [], createdAt: 1, updatedAt: 1, ...(notes.history ? { notes: notes.history } : {}) },
    ],
  }
}

function setup(initial: WorkspaceStore, deps: Partial<FileUploadDeps> = {}) {
  let ids = 0
  const hook = renderHook(() => {
    const [store, setStore] = useState(initial)
    const ref = useRef(initial)
    const actions = useFileUploads({
      store,
      getStore: () => ref.current,
      commit: (next) => {
        ref.current = next
        setStore(next)
      },
      enabled: true,
      deps: { now: () => NOW, newId: () => `file${++ids}`, ...deps },
    })
    return { actions, ref }
  })
  return {
    actions: () => hook.result.current.actions,
    store: () => hook.result.current.ref.current,
    notes: (workspaceId = "physics") => hook.result.current.ref.current.workspaces.find((workspace) => workspace.id === workspaceId)?.notes ?? [],
    hook,
  }
}

const pdf = (name: string, pages: string[]) => new File([makeTestPdf(pages)], name, { type: "application/pdf" })
const text = (name: string, body: string, type = "text/markdown") => new File([body], name, { type })

beforeEach(async () => {
  resetContentStoreForTests()
  setStorageNamespace(null)
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("hubble-resources")
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })
  saveFile.mockClear()
})

describe("uploading files to a project", () => {
  it("keeps each original, reads it here, and lists it Ready with its text stored — a PDF page by page", async () => {
    const t = setup(world())
    const heard: UploadOutcome[] = []
    let outcomes: UploadOutcome[] = []
    await act(async () => {
      outcomes = await t.actions().upload("physics", [pdf("Lecture 4.pdf", ["Entropy always increases.", "Heat engines."]), text("notes.md", "# Revision\n\nThe second law.")], (_, outcome) => heard.push(outcome))
    })
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["added", "added"])
    expect(heard).toHaveLength(2)
    await waitFor(() => expect(t.notes().map((note) => note.file?.status)).toEqual(["ready", "ready"]))

    const [lecture, notes] = t.notes()
    expect(lecture).toMatchObject({ kind: "file", title: "Lecture 4", origin: "upload", file: { name: "Lecture 4.pdf", format: "pdf", pages: 2 } })
    expect(lecture!.chars).toBeGreaterThan(0)
    expect(notes).toMatchObject({ title: "notes", file: { format: "markdown" } })
    expect((await getContent("physics", lecture!.id))?.pages).toEqual(["Entropy always increases.", "Heat engines."])
    expect((await getContent("physics", notes!.id))?.text).toBe("# Revision\n\nThe second law.")
    const original = await getFile("physics", lecture!.id)
    // Compared as numbers: the bytes come back from another realm's typed array.
    expect(Array.from(new Uint8Array(original!.bytes))).toEqual(Array.from(makeTestPdf(["Entropy always increases.", "Heat engines."])))
    expect(original!.type).toBe("application/pdf")
  })

  it("adds the same file once, and refuses unsupported and empty files with reasons — the rest of the batch still lands", async () => {
    const t = setup(world())
    let outcomes: UploadOutcome[] = []
    await act(async () => {
      outcomes = await t.actions().upload("physics", [text("a.md", "same body"), text("copy of a.md", "same body"), new File(["x"], "old.doc"), new File([], "empty.txt", { type: "text/plain" })])
    })
    expect(outcomes[0]).toMatchObject({ status: "added" })
    expect(outcomes[1]).toMatchObject({ status: "duplicate", noteId: (outcomes[0] as { noteId: string }).noteId })
    expect(outcomes[2]).toMatchObject({ status: "rejected", message: expect.stringContaining(".docx") })
    expect(outcomes[3]).toMatchObject({ status: "rejected", message: "This file is empty." })
    expect(t.notes()).toHaveLength(1)
  })

  it("adds nothing when the device refuses to keep the original", async () => {
    const t = setup(world(), { putFile: async () => Promise.reject(new DOMException("full", "QuotaExceededError")) })
    let outcomes: UploadOutcome[] = []
    await act(async () => {
      outcomes = await t.actions().upload("physics", [text("a.md", "body")])
    })
    expect(outcomes[0]).toMatchObject({ status: "failed", message: expect.stringContaining("room") })
    expect(t.notes()).toHaveLength(0)
  })

  it("keeps projects apart: a file added to one is in no other project's content", async () => {
    const t = setup(world())
    await act(async () => void (await t.actions().upload("physics", [text("physics.md", "Only physics.")])))
    await waitFor(() => expect(t.notes()[0]?.file?.status).toBe("ready"))
    expect(t.notes("history")).toHaveLength(0)
    expect((await getProjectContents("history")).size).toBe(0)
    expect(await getFile("history", t.notes()[0]!.id)).toBeUndefined()
  })

  it("marks a scan as saved without text, never Ready", async () => {
    const t = setup(world())
    await act(async () => void (await t.actions().upload("physics", [pdf("scan.pdf", ["", ""])])))
    await waitFor(() => expect(t.notes()[0]?.file?.status).toBe("partial"))
    expect(t.notes()[0]!.file).toMatchObject({ error: { code: "no_text" }, pages: 2 })
    expect(await getContent("physics", t.notes()[0]!.id)).toBeUndefined()
  })
})

describe("after a reload", () => {
  it("reads again, from the kept original, a file that was still being read", async () => {
    const note = composeFileNote({ id: "kept", name: "notes.txt", format: "text", size: 12, hash: "00000000000000aa", now: NOW })
    await putFile("physics", "kept", new TextEncoder().encode("Read me again").buffer, { name: "notes.txt", type: "text/plain", now: NOW })
    const t = setup(world({ physics: [note] }))
    await waitFor(() => expect(t.notes()[0]?.file?.status).toBe("ready"))
    expect(t.notes()[0]!.file?.attempts).toBe(2)
    expect((await getContent("physics", "kept"))?.text).toBe("Read me again")
  })

  it("says the original is gone — without offering Try again — when this device no longer has it", async () => {
    const note = composeFileNote({ id: "lost", name: "lost.pdf", format: "pdf", size: 12, hash: "00000000000000bb", now: NOW })
    const t = setup(world({ physics: [note] }))
    await waitFor(() => expect(t.notes()[0]?.file?.status).toBe("failed"))
    expect(t.notes()[0]!.file?.error).toMatchObject({ message: expect.stringContaining("Upload it again"), retryable: false })
  })

  it("stops re-reading a file that keeps getting interrupted, and offers Try again", async () => {
    const note = composeFileNote({ id: "crashy", name: "big.pdf", format: "pdf", size: 12, hash: "00000000000000cc", now: NOW })
    note.file!.attempts = 3
    const t = setup(world({ physics: [note] }))
    await waitFor(() => expect(t.notes()[0]?.file?.status).toBe("failed"))
    expect(t.notes()[0]!.file?.error).toMatchObject({ code: "interrupted", retryable: true })
  })
})

describe("retrying, downloading and removing", () => {
  it("Try again reads the file once more from its original", async () => {
    let refuse = true
    const t = setup(world(), { putContent: async (...args) => (refuse ? Promise.reject(new Error("blocked")) : putContent(...args)) })
    await act(async () => void (await t.actions().upload("physics", [text("a.md", "Second time lucky.")])))
    await waitFor(() => expect(t.notes()[0]?.file?.status).toBe("failed"))
    expect(t.notes()[0]!.file?.error?.retryable).toBe(true)
    refuse = false
    act(() => t.actions().retry("physics", t.notes()[0]!.id))
    await waitFor(() => expect(t.notes()[0]?.file?.status).toBe("ready"))
    expect((await getContent("physics", t.notes()[0]!.id))?.text).toBe("Second time lucky.")
  })

  it("gives back the original file, by its own name and type", async () => {
    const t = setup(world())
    await act(async () => void (await t.actions().upload("physics", [pdf("Lecture 4.pdf", ["Text."])])))
    let result = ""
    await act(async () => {
      result = await t.actions().download("physics", t.notes()[0]!.id)
    })
    expect(result).toBe("saved")
    expect(saveFile).toHaveBeenCalledWith("Lecture 4.pdf", expect.anything(), "application/pdf")
    expect(Array.from((saveFile.mock.calls[0] as unknown as [string, Uint8Array])[1])).toEqual(Array.from(makeTestPdf(["Text."])))
  })

  it("forgets the text and the original of a file removed while it was being read", async () => {
    const harness: { t?: ReturnType<typeof setup> } = {}
    const removeThenStore: FileUploadDeps["putContent"] = async (workspaceId, itemId, content) => {
      // The person removes the file just as Hubble finishes reading it.
      const t = harness.t!
      t.hook.result.current.ref.current = removeProjectNotes(t.store(), workspaceId, [itemId], NOW)
      return putContent(workspaceId, itemId, content)
    }
    const t = setup(world(), { putContent: removeThenStore })
    harness.t = t
    await act(async () => void (await t.actions().upload("physics", [text("gone.md", "Removed mid-read.")])))
    await waitFor(async () => expect(await getFile("physics", "file1")).toBeUndefined())
    expect(await getContent("physics", "file1")).toBeUndefined()
  })

  it("removing a file's item takes its original with it — the content store's lifecycle covers both", async () => {
    await putContent("physics", "f", { kind: "document", text: "t", extractedAt: NOW })
    await putFile("physics", "f", new Uint8Array([1, 2, 3]).buffer, { name: "f.txt", type: "text/plain", now: NOW })
    await putFile("physics", "orphan", new Uint8Array([4]).buffer, { name: "o.txt", type: "text/plain", now: NOW })
    await putFile("history", "keep", new Uint8Array([5]).buffer, { name: "k.txt", type: "text/plain", now: NOW })
    await deleteContent("physics", ["f"])
    expect(await getContent("physics", "f")).toBeUndefined()
    expect(await getFile("physics", "f")).toBeUndefined()
    // The once-per-load sweep removes originals whose item is in no project, and nothing else.
    expect(await pruneContentExcept(new Map([["history", new Set(["keep"])]]))).toBe(1)
    expect(await getFile("physics", "orphan")).toBeUndefined()
    expect(await getFile("history", "keep")).toBeDefined()
  })
})
