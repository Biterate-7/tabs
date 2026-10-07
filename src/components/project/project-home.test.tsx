import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectHome } from "./project-home"
import { ingestResources } from "@/lib/resources/ingest"
import type { ResourceActions } from "@/hooks/use-resource-processing"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

const NOW = 1_800_000_000_000

function project(urls: string[] = []): Workspace {
  let store: WorkspaceStore = {
    version: 1,
    currentId: "w",
    workspaces: [{ id: "w", name: "History IA", tabs: [], sections: [], createdAt: 1, updatedAt: 1, brief: { description: "Cuban Missile Crisis.", focus: "A strong argument.", updatedAt: 1 } }],
  }
  if (urls.length > 0) store = ingestResources(store, "w", urls.map((url) => ({ url })), "chrome", NOW)!.store
  return store.workspaces[0]!
}

const resources: ResourceActions = { retry: vi.fn(), attachPdf: vi.fn(), attachTranscript: vi.fn(async () => ({})), forget: vi.fn() }

function renderHome(workspace: Workspace, overrides: Partial<Parameters<typeof ProjectHome>[0]> = {}) {
  const onAddSources = vi.fn((inputs: { url: string }[]) => inputs.map((input) => ({ status: "added" as const, input, tabId: "x", kind: "webpage" as const })))
  const props = {
    workspace,
    now: NOW,
    onAddSources,
    resources,
    onRenameSource: vi.fn(),
    onRemoveSources: vi.fn(),
    onOpenSource: vi.fn(),
    onUseInTask: vi.fn(),
    onOpenCommandCentre: vi.fn(),
    onUpdateBrief: vi.fn(),
    agents: [],
    ...overrides,
  }
  render(<ProjectHome {...props} />)
  return props
}

/** An external drag, as the page receives it from Chrome. */
function dragFromChrome(data: Record<string, string>, files: File[] = []) {
  const transfer = { types: [...Object.keys(data), ...(files.length ? ["Files"] : [])], getData: (type: string) => data[type] ?? "", files, dropEffect: "none" }
  act(() => {
    fireEvent.dragEnter(window, { dataTransfer: transfer })
    fireEvent.dragOver(window, { dataTransfer: transfer })
  })
  return {
    drop: () => act(() => void fireEvent.drop(window, { dataTransfer: transfer })),
  }
}

afterEach(() => localStorage.clear())

describe("ProjectHome", () => {
  it("starts an empty project with context, and offers a way in that needs no dragging", () => {
    renderHome(project())
    expect(screen.getByText("Start by adding context.")).toBeTruthy()
    expect(screen.getByText("Cuban Missile Crisis.")).toBeTruthy()
    expect(screen.getByText("Your project is ready. Connect an agent to start working.")).toBeTruthy()
    expect(screen.getByText("No work yet. Your first agent task will appear here.")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /Add source/ }).length).toBeGreaterThan(0)
  })

  it("names the project while a link is dragged over it, and adds what is dropped", () => {
    const props = renderHome(project())
    const drag = dragFromChrome({ "text/uri-list": "https://en.wikipedia.org/wiki/Cuban_Missile_Crisis", "text/plain": "https://en.wikipedia.org/wiki/Cuban_Missile_Crisis" })
    expect(screen.getByText("Drop into History IA")).toBeTruthy()
    drag.drop()
    expect(props.onAddSources).toHaveBeenCalledWith([{ url: "https://en.wikipedia.org/wiki/Cuban_Missile_Crisis" }], "chrome")
    expect(screen.queryByText("Drop into History IA")).toBeNull()
  })

  it("adds every tab of a multi-tab drop in one go", () => {
    const props = renderHome(project())
    dragFromChrome({ "text/x-moz-url": "https://a.example/1\nOne\nhttps://a.example/2.pdf\nTwo" }).drop()
    expect(props.onAddSources).toHaveBeenCalledWith(
      [
        { url: "https://a.example/1", title: "One" },
        { url: "https://a.example/2.pdf", title: "Two" },
      ],
      "chrome"
    )
  })

  it("says so when a drop holds nothing it can add", () => {
    const props = renderHome(project())
    dragFromChrome({ "text/plain": "just some words" }).drop()
    expect(props.onAddSources).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't be added/)
  })

  it("ignores a drag that started inside the app", () => {
    renderHome(project())
    act(() => void fireEvent.dragStart(window))
    dragFromChrome({ "text/uri-list": "https://a.example" })
    expect(screen.queryByText("Drop into History IA")).toBeNull()
  })

  it("attaches a dropped PDF file to the one PDF source waiting for it", () => {
    const workspace = project(["https://journal.example/paper.pdf"])
    workspace.tabs[0]!.resource = { ...workspace.tabs[0]!.resource!, status: "partial", error: { code: "pdf_needs_file", message: "PDF detected. Hubble needs the file itself to read its contents.", retryable: true } }
    renderHome(workspace)
    const file = new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" })
    dragFromChrome({}, [file]).drop()
    expect(resources.attachPdf).toHaveBeenCalledWith("w", workspace.tabs[0]!.id, file)
  })

  it("adds pasted addresses through the Add source dialog and says what happened to each", async () => {
    const user = userEvent.setup()
    const props = renderHome(project(), {
      onAddSources: vi.fn((inputs) => [
        { status: "added" as const, input: inputs[0]!, tabId: "a", kind: "webpage" as const },
        { status: "duplicate" as const, input: inputs[1]!, tabId: "b" },
      ]),
    })
    await user.click(screen.getAllByRole("button", { name: /Add source/ })[0]!)
    await user.type(screen.getByLabelText("Addresses to add"), "https://a.example{Enter}https://b.example")
    await user.click(screen.getByRole("button", { name: "Add 2 sources" }))
    expect(props.onAddSources).toHaveBeenCalledWith([{ url: "https://a.example" }, { url: "https://b.example" }], "manual")
    const results = await screen.findByRole("list", { name: "What happened to each address" })
    expect(within(results).getByText("Already in History IA")).toBeTruthy()
  })

  it("shows each source's state in words, and filters to what needs attention", async () => {
    const user = userEvent.setup()
    const workspace = project(["https://a.example/one", "https://b.example/two.pdf", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"])
    workspace.tabs[0]!.resource = { ...workspace.tabs[0]!.resource!, status: "ready", content: { chars: 6000, extractedAt: NOW } }
    workspace.tabs[1]!.resource = { ...workspace.tabs[1]!.resource!, status: "failed", error: { code: "unreachable", message: "Hubble couldn't reach this page.", retryable: true } }
    renderHome(workspace)
    const cards = screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-source-card"))
    expect(cards.map((card) => card.querySelector("[data-source-status]")!.textContent)).toEqual([
      expect.stringContaining("Ready · 1,000 words"),
      expect.stringContaining("Couldn't read · Hubble couldn't reach this page."),
      expect.stringContaining("Waiting"),
    ])
    await user.click(screen.getByRole("button", { name: "Needs attention" }))
    expect(screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-source-card"))).toHaveLength(1)
    expect(screen.getByText("1 source can't be read yet", { exact: false })).toBeTruthy()
  })

  it("removes a source from the project, and hands Use in task to the Command Centre", async () => {
    const user = userEvent.setup()
    const workspace = project(["https://a.example/one"])
    const props = renderHome(workspace)
    await user.click(screen.getByRole("button", { name: /Use .* in a task/ }))
    expect(props.onUseInTask).toHaveBeenCalledWith(expect.objectContaining({ id: workspace.tabs[0]!.id }))
    await user.click(screen.getByRole("button", { name: /More actions for/ }))
    await user.click(await screen.findByRole("menuitem", { name: /Remove from project/ }))
    expect(props.onRemoveSources).toHaveBeenCalledWith([workspace.tabs[0]!.id])
  })
})
