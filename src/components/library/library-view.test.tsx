import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LibraryView } from "./library-view"
import type { Tab } from "@/lib/tabs/types"
import type { ProjectNote } from "@/lib/notes/notes"
import type { Workspace } from "@/lib/workspace/types"

const NOW = new Date(2026, 9, 20, 15, 0).getTime()

function conversation(id: string, url: string, title: string, provider: "chatgpt" | "claude"): Tab {
  return { id, url, normalizedUrl: url, domain: new URL(url).hostname, title, resource: { kind: "conversation", origin: "extension", status: "ready", addedAt: NOW - 1000, updatedAt: NOW - 1000, meta: { provider, capture: "page" }, content: { chars: 10, turns: 4, extractedAt: NOW } } }
}
const file: ProjectNote = { id: "f1", kind: "file", title: "Lecture 4.pdf", origin: "upload", createdAt: NOW, updatedAt: NOW, contentHash: "0123456789abcdef", chars: 100, file: { name: "Lecture 4.pdf", format: "pdf", size: 2048, status: "ready", pages: 3 } }

// Two distinct ChatGPT conversations, and one of them also saved in a second project.
const history: Workspace = {
  id: "h",
  name: "History",
  tabs: [conversation("a", "https://chatgpt.com/c/aaaaaaaa-1111", "Causes of WW1", "chatgpt"), conversation("b", "https://chatgpt.com/c/bbbbbbbb-2222", "Essay plan", "chatgpt")],
  notes: [file],
  createdAt: 0,
  updatedAt: 0,
}
const essay: Workspace = { id: "e", name: "Essay", tabs: [conversation("c", "https://chatgpt.com/c/aaaaaaaa-1111?model=gpt-5", "Causes of WW1", "chatgpt"), conversation("d", "https://claude.ai/chat/cccccccc-3333", "Outline critique", "claude")], createdAt: 0, updatedAt: 0 }

function renderLibrary() {
  const props = { workspaces: [history, essay], now: NOW, onOpenItem: vi.fn(), onUseInAi: vi.fn(), onOpenUrl: vi.fn() }
  render(<LibraryView {...props} />)
  return props
}

describe("LibraryView", () => {
  it("keeps separate conversations from one AI app separate, and marks the same conversation saved twice", () => {
    renderLibrary()
    expect(screen.getByText("Essay plan")).toBeTruthy()
    expect(screen.getAllByText("Causes of WW1")).toHaveLength(2)
    expect(screen.getByText(/Also in Essay/)).toBeTruthy()
    expect(screen.getByText(/Also in History/)).toBeTruthy()
    // "Outline critique" and "Essay plan" are not duplicates of anything.
    expect(screen.getAllByText(/Also in/)).toHaveLength(2)
  })

  it("filters by kind, with real counts", async () => {
    const user = userEvent.setup()
    renderLibrary()
    expect(screen.getByRole("tab", { name: /Conversations\s*4/ })).toBeTruthy()
    await user.click(screen.getByRole("tab", { name: /Files/ }))
    const files = screen.getByRole("list", { name: "Files" })
    expect(within(files).getByText("Lecture 4.pdf")).toBeTruthy()
    expect(within(files).getByText(/3 pages · 2 KB/)).toBeTruthy()
  })

  it("finds by AI app and opens the item where it lives", async () => {
    const user = userEvent.setup()
    const props = renderLibrary()
    await user.type(screen.getByLabelText("Find in the library"), "claude")
    expect(screen.queryByText("Essay plan")).toBeNull()
    await user.click(screen.getByRole("button", { name: /^Outline critique/ }))
    expect(props.onOpenItem).toHaveBeenCalledWith("e", { kind: "source", tabId: "d" })
  })

  it("continues a conversation in its own app", async () => {
    const user = userEvent.setup()
    const props = renderLibrary()
    await user.click(screen.getByRole("button", { name: "Continue in Claude" }))
    expect(props.onOpenUrl).toHaveBeenCalledWith("https://claude.ai/chat/cccccccc-3333")
  })
})
