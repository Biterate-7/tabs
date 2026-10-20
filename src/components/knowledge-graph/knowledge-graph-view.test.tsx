import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { KnowledgeGraphView } from "./knowledge-graph-view"
import { __resetSessionsForTests, SESSIONS_STORAGE_KEY } from "@/lib/sessions/persistence"
import type { Tab } from "@/lib/tabs/types"
import type { ProjectNote } from "@/lib/notes/notes"
import type { Workspace } from "@/lib/workspace/types"

const restoreTabs = vi.hoisted(() => vi.fn())
vi.mock("@/lib/sessions/restore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/sessions/restore")>()), restoreTabs }))

const NOW = new Date(2026, 9, 20, 15, 0).getTime()
const PAPER = "https://example.org/paper"

function source(id: string, url: string, title: string, kind: "webpage" | "conversation" = "webpage"): Tab {
  return {
    id,
    url,
    normalizedUrl: url,
    domain: new URL(url).hostname,
    title,
    resource: { kind, origin: "extension", status: "ready", addedAt: NOW - 1000, updatedAt: NOW - 1000, content: { chars: 10, extractedAt: NOW }, ...(kind === "conversation" ? { meta: { provider: "chatgpt" } } : {}) },
  }
}

const file: ProjectNote = { id: "f1", kind: "file", title: "Lecture 4.pdf", origin: "upload", createdAt: NOW, updatedAt: NOW, contentHash: "0123456789abcdef", chars: 100, file: { name: "Lecture 4.pdf", format: "pdf", size: 1000, status: "ready", pages: 3 } }

const thesis: Workspace = {
  id: "w1",
  name: "Thesis",
  tabs: [source("t1", PAPER, "The paper"), source("t2", "https://chatgpt.com/c/abcdef12-3456", "Methods chat", "conversation")],
  notes: [file],
  createdAt: NOW - 10_000,
  updatedAt: NOW,
}
const launch: Workspace = { id: "w2", name: "Launch", tabs: [source("t3", PAPER, "The paper again")], createdAt: NOW - 20_000, updatedAt: NOW }

function renderGraph(overrides: Partial<React.ComponentProps<typeof KnowledgeGraphView>> = {}) {
  const props = {
    workspaces: [thesis, launch],
    now: NOW,
    showSessions: true,
    onOpenItem: vi.fn(),
    onOpenProject: vi.fn(),
    onUseInAi: vi.fn(),
    onOpenUrl: vi.fn(),
    ...overrides,
  }
  render(<KnowledgeGraphView {...props} />)
  return props
}

/** The canvas is not drawn in jsdom; the list view is the same graph, and the accessible way in. */
async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "List" }))
  return screen.findByRole("region", { name: "Thesis" })
}

/** A list row's select button (each row also has an Open button). */
function rowButton(region: HTMLElement, text: string): HTMLElement {
  const found = within(region).getAllByRole("button").find((button) => button.hasAttribute("aria-pressed") && button.textContent?.includes(text))
  if (!found) throw new Error(`no row for ${text}`)
  return found
}

beforeEach(() => {
  window.localStorage.clear()
  __resetSessionsForTests()
  restoreTabs.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("KnowledgeGraphView", () => {
  it("shows every kind with its real count, from the saved records", async () => {
    renderGraph()
    const show = screen.getByRole("group", { name: "Show" })
    expect(within(show).getByRole("button", { name: /Conversations\s*1/ })).toBeTruthy()
    expect(within(show).getByRole("button", { name: /Sources\s*2/ })).toBeTruthy()
    expect(within(show).getByRole("button", { name: /Files\s*1/ })).toBeTruthy()
    expect(within(show).getByRole("button", { name: /Notes\s*0/ })).toBeTruthy()
  })

  it("selects from the list and shows what Hubble knows, including the same source in another project", async () => {
    const user = userEvent.setup()
    renderGraph()
    const region = await openList(user)
    await user.click(rowButton(region, "The paper"))
    const inspector = await screen.findByRole("complementary", { name: "Web page: The paper" })
    expect(within(inspector).getByText("Same source")).toBeTruthy()
    expect(within(inspector).getByRole("button", { name: /The paper again/ })).toBeTruthy()
    // Travelling along a relationship selects the other end, and Back returns.
    await user.click(within(inspector).getByRole("button", { name: /The paper again/ }))
    expect(await screen.findByRole("complementary", { name: "Web page: The paper again" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Back to previous selection" }))
    expect(await screen.findByRole("complementary", { name: "Web page: The paper" })).toBeTruthy()
  })

  it("opens a conversation, a file and a project as the real thing", async () => {
    const user = userEvent.setup()
    const props = renderGraph()
    const region = await openList(user)
    await user.click(rowButton(region, "Methods chat"))
    await user.click(await screen.findByRole("button", { name: "Open conversation" }))
    expect(props.onOpenItem).toHaveBeenCalledWith("w1", { kind: "source", tabId: "t2" })

    await user.click(rowButton(region, "Lecture 4.pdf"))
    await user.click(await screen.findByRole("button", { name: "Open file" }))
    expect(props.onOpenItem).toHaveBeenLastCalledWith("w1", { kind: "note", noteId: "f1" })

    await user.click(within(region).getByRole("button", { name: "Open Thesis" }))
    expect(props.onOpenProject).toHaveBeenCalledWith("w1")
  })

  it("brings a project's context to Use in AI", async () => {
    const user = userEvent.setup()
    const props = renderGraph()
    const region = await openList(user)
    await user.click(rowButton(region, "Thesis"))
    await user.click(await screen.findByRole("button", { name: "Use in AI" }))
    expect(props.onUseInAi).toHaveBeenCalledWith("w1", [])
  })

  it("finds a node by search and focuses it with Enter", async () => {
    const user = userEvent.setup()
    renderGraph()
    await user.type(screen.getByRole("combobox", { name: "Find in graph" }), "methods")
    const results = await screen.findByRole("listbox", { name: "Matches" })
    expect(within(results).getByText("Methods chat")).toBeTruthy()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("complementary", { name: "AI conversation: Methods chat" })).toBeTruthy()
  })

  it("filters the real graph by kind, and says when filters hide everything", async () => {
    const user = userEvent.setup()
    renderGraph({ workspaces: [launch] })
    await user.click(screen.getByRole("button", { name: /Sources/ }))
    expect(screen.getByRole("button", { name: /Sources/ }).getAttribute("aria-pressed")).toBe("false")
    await user.click(screen.getByRole("button", { name: "List" }))
    const region = await screen.findByRole("region", { name: "Launch" })
    expect(within(region).queryByText("The paper again")).toBeNull()
  })

  it("restores a session's tabs from its inspector", async () => {
    const user = userEvent.setup()
    restoreTabs.mockResolvedValue({ kind: "opened", opened: 2, failed: [] })
    window.localStorage.setItem(
      SESSIONS_STORAGE_KEY,
      JSON.stringify({ version: 1, sessions: [{ id: "s1", name: "Writing", workspaceId: "w1", createdAt: NOW, updatedAt: NOW, revision: 1, tabs: [{ id: "a", url: PAPER, title: "Paper" }, { id: "b", url: "https://docs.example/", title: "Draft" }] }] })
    )
    __resetSessionsForTests()
    renderGraph()
    const region = await openList(user)
    await user.click(rowButton(region, "Writing"))
    const inspector = await screen.findByRole("complementary", { name: "Browser session: Writing" })
    // A session connects to its project and to the saved page it has open.
    expect(within(inspector).getByText("Open in session")).toBeTruthy()
    await user.click(within(inspector).getByRole("button", { name: "Restore 2 tabs" }))
    await waitFor(() => expect(restoreTabs).toHaveBeenCalledWith([{ url: PAPER }, { url: "https://docs.example/" }], expect.anything()))
  })

  it("leaves sessions out where they cannot exist", () => {
    renderGraph({ showSessions: false })
    expect(screen.queryByRole("button", { name: /Sessions/ })).toBeNull()
  })

  it("clears the selection with Escape", async () => {
    const user = userEvent.setup()
    renderGraph()
    const region = await openList(user)
    await user.click(rowButton(region, "Methods chat"))
    await screen.findByRole("complementary", { name: "AI conversation: Methods chat" })
    await user.click(screen.getByRole("button", { name: "Close details" }))
    expect(screen.queryByRole("complementary", { name: /Methods chat/ })).toBeNull()
  })

  it("has an empty state that invents nothing", async () => {
    const user = userEvent.setup()
    const onNewProject = vi.fn()
    renderGraph({ workspaces: [], onNewProject })
    expect(screen.getByRole("heading", { name: "Your work, connected" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /New project/ }))
    expect(onNewProject).toHaveBeenCalledOnce()
  })

  it("offers the tab map only when asked to, and respects its lock", () => {
    renderGraph({ onOpenTabMap: vi.fn(), tabMapLocked: true, tabMapLockedReason: "Organizing your tabs…" })
    expect((screen.getByRole("button", { name: /Tab map/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
