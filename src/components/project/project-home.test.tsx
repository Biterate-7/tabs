import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
    onConnectAI: vi.fn(),
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
  it("starts an empty subject with its name, one short line, and Add — no tutorial", () => {
    renderHome(project())
    expect(screen.getByRole("heading", { name: "History IA", level: 1 })).toBeTruthy()
    expect(screen.getByText("No resources yet.")).toBeTruthy()
    expect(screen.getByText("Cuban Missile Crisis.", { exact: false })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /^Add/ }).length).toBeGreaterThan(0)
    // With no AI connected, a quiet way to connect one — never a wall in front of the subject.
    expect(screen.getByRole("button", { name: "Connect AI" })).toBeTruthy()
    // An empty subject has no activity to show yet.
    expect(screen.queryByRole("button", { name: /Recent activity/ })).toBeNull()
    // No explanatory paragraphs.
    expect(document.body.textContent).not.toMatch(/Hubble reads each source|any agent you choose|Connect an agent/)
  })

  it("leaves out Connect AI once an AI is connected", () => {
    renderHome(project(), { agents: [{ provider: "claude-code", name: "Claude Code" }] })
    expect(screen.queryByRole("button", { name: "Connect AI" })).toBeNull()
  })

  describe("adding from Chrome", () => {
    const hints = () => [...document.querySelectorAll("[data-add-hint]")].map((node) => node.textContent)
    const FORBIDDEN = /drag (a |the |chrome )?tabs?|tab manager|manage your tabs|organi[sz]e (your )?tabs/i

    it("without Hubble for Chrome, says nothing about it — Add is the way in", () => {
      renderHome(project())
      expect(hints()).toEqual([])
      expect(screen.queryByText(/right-click a tab/i)).toBeNull()
      cleanup()
      renderHome(project(["https://a.example/1"]))
      expect(hints()).toEqual([])
    })

    it("with Hubble for Chrome, names the subject: right-click a tab → Add to <subject>", () => {
      renderHome(project(), { quickAdd: { shortcut: "Alt+Shift+H" } })
      expect(hints()).toEqual(["In Chrome: right-click a tab → Add to History IA · Alt + Shift + H"])
      expect(document.querySelector("[data-quick-add-target]")!.getAttribute("data-quick-add-target")).toBe("History IA")
      for (const text of hints()) expect(text).not.toMatch(FORBIDDEN)
    })

    it("teaches it once: in the empty state only", () => {
      renderHome(project(), { quickAdd: { shortcut: "Alt+Shift+H" } })
      expect(document.querySelectorAll("[data-add-hint]")).toHaveLength(1)
      expect(document.querySelector("[data-project-empty] [data-add-hint]")).toBeTruthy()
      cleanup()
      renderHome(project(["https://a.example/1"]), { quickAdd: { shortcut: "Alt+Shift+H" } })
      expect(document.querySelectorAll("[data-add-hint]")).toHaveLength(0)
    })

    it("does not mention a shortcut the person cleared (or Chrome refused)", () => {
      renderHome(project(), { quickAdd: { shortcut: "" } })
      expect(hints()).toEqual(["In Chrome: right-click a tab → Add to History IA"])
    })

    it("names whichever subject is on screen, and nothing else", () => {
      const props = renderHome(project(), { quickAdd: { shortcut: "Alt+Shift+H" } })
      expect(document.querySelector("[data-add-hint]")!.textContent).toContain("Add to History IA")
      cleanup()
      render(<ProjectHome {...props} workspace={{ ...project(), id: "p", name: "Physics EE" }} />)
      expect(document.querySelector("[data-add-hint]")!.textContent).toContain("Add to Physics EE")
      expect(screen.queryByText(/History IA/)).toBeNull()
    })
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
    // + Add → Link
    await user.click(screen.getAllByRole("button", { name: /^Add/ })[0]!)
    await user.click(await screen.findByRole("menuitem", { name: "Link" }))
    await user.type(screen.getByLabelText("Addresses to add"), "https://a.example{Enter}https://b.example")
    await user.click(screen.getByRole("button", { name: "Add 2 links" }))
    expect(props.onAddSources).toHaveBeenCalledWith([{ url: "https://a.example" }, { url: "https://b.example" }], "manual")
    const results = await screen.findByRole("list", { name: "What happened to each address" })
    expect(within(results).getByText("Already in History IA")).toBeTruthy()
  })

  it("says a resource's state in words only when it is not simply ready, and filters to what needs attention", async () => {
    const user = userEvent.setup()
    const workspace = project(["https://a.example/one", "https://b.example/two.pdf", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"])
    workspace.tabs[0]!.resource = { ...workspace.tabs[0]!.resource!, status: "ready", content: { chars: 6000, extractedAt: NOW } }
    workspace.tabs[1]!.resource = { ...workspace.tabs[1]!.resource!, status: "failed", error: { code: "unreachable", message: "Hubble couldn't reach this page.", retryable: true } }
    renderHome(workspace)
    const cards = screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-source-card"))
    expect(cards.map((card) => card.querySelector("[data-source-status]")?.textContent ?? null)).toEqual([
      // Ready is the normal case: nothing to say.
      null,
      expect.stringContaining("Couldn't read · Hubble couldn't reach this page."),
      expect.stringContaining("Waiting"),
    ])
    await user.click(screen.getByRole("button", { name: "Needs attention" }))
    expect(screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-source-card"))).toHaveLength(1)
  })

  it("shows a source whose site blocks reading as saved — with its icon and a working Open — not as broken", async () => {
    const user = userEvent.setup()
    let store: WorkspaceStore = { version: 1, currentId: "w", workspaces: [{ ...project(), tabs: [] }] }
    store = ingestResources(store, "w", [{ url: "https://chatgpt.com/c/abc", title: "ChatGPT", favicon: "data:image/png;base64,iVBORw0KGgo=" }], "extension", NOW)!.store
    const workspace = store.workspaces[0]!
    workspace.tabs[0]!.resource = {
      ...workspace.tabs[0]!.resource!,
      status: "partial",
      error: { code: "blocked", message: "Content unavailable — this site doesn't allow automated reading.", retryable: false },
    }
    const props = renderHome(workspace)
    const card = document.querySelector("[data-source-card]")!
    expect(card.querySelector("[data-source-status]")!.textContent).toBe("Saved · Content unavailable — this site doesn't allow automated reading.")
    expect(card.querySelector("[data-source-status]")!.className).not.toContain("destructive")
    expect(card.textContent).not.toMatch(/refused|couldn't read/i)
    // The site's icon sits where the generic kind glyph was (the letter holds the space until it loads).
    expect(card.querySelector("[data-source-icon]")!.textContent).toBe("C")
    await user.click(within(card as HTMLElement).getByRole("button", { name: "Open ChatGPT" }))
    expect(props.onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ url: "https://chatgpt.com/c/abc" }))
    // Nothing to fix, so it is not "needing attention": there is no such filter to offer.
    expect(screen.queryByRole("button", { name: "Needs attention" })).toBeNull()
    expect(screen.queryByText(/can't be read yet/)).toBeNull()
  })

  it("removes a resource from the subject, and hands Ask AI on it to the shell", async () => {
    const user = userEvent.setup()
    const workspace = project(["https://a.example/one"])
    const props = renderHome(workspace)
    await user.click(screen.getByRole("button", { name: /^Ask AI about / }))
    expect(props.onUseInTask).toHaveBeenCalledWith(expect.objectContaining({ id: workspace.tabs[0]!.id }))
    await user.click(screen.getByRole("button", { name: /More actions for/ }))
    await user.click(await screen.findByRole("menuitem", { name: /^Remove/ }))
    expect(props.onRemoveSources).toHaveBeenCalledWith([workspace.tabs[0]!.id])
  })

  it("selects resources and removes them together", async () => {
    const user = userEvent.setup()
    const workspace = project(["https://a.example/one", "https://b.example/two"])
    const props = renderHome(workspace)
    await user.click(screen.getByRole("button", { name: "Select" }))
    for (const box of screen.getAllByRole("checkbox", { name: /^Select / })) await user.click(box)
    const toolbar = screen.getByRole("toolbar", { name: "Selected resources" })
    expect(toolbar.textContent).toContain("2 selected")
    await user.click(within(toolbar).getByRole("button", { name: "Remove" }))
    expect(props.onRemoveSources).toHaveBeenCalledWith(expect.arrayContaining(workspace.tabs.map((tab) => tab.id)))
  })
})
