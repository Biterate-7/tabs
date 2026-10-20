import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HomeView } from "./home-view"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

const NOW = new Date(2026, 9, 8, 19, 0).getTime()

function source(id: string, title: string, at: number, provider?: "chatgpt" | "claude"): Tab {
  const url = provider === "chatgpt" ? `https://chatgpt.com/c/${id}-0000-aaaa` : `https://example.com/${id}`
  return {
    id,
    url,
    normalizedUrl: url,
    domain: provider === "chatgpt" ? "chatgpt.com" : "example.com",
    title,
    createdAt: at,
    resource: {
      kind: provider ? "conversation" : "webpage",
      origin: "extension",
      status: "ready",
      addedAt: at,
      updatedAt: at,
      content: { chars: 10, extractedAt: at },
      ...(provider ? { meta: { provider } } : {}),
    },
  }
}

function project(id: string, name: string, tabs: Tab[] = []): Workspace {
  return { id, name, createdAt: 0, updatedAt: 0, tabs }
}

function renderHome(overrides: Partial<Parameters<typeof HomeView>[0]> = {}) {
  const props = {
    subjects: [] as Workspace[],
    firstRun: false,
    now: NOW,
    onOpenSubject: vi.fn(),
    onNewSubject: vi.fn(),
    onOpenItem: vi.fn(),
    ...overrides,
  }
  render(<HomeView {...props} />)
  return props
}

describe("Home", () => {
  it("with no projects, says what Hubble is for in one sentence and offers one button", async () => {
    const user = userEvent.setup()
    const props = renderHome()
    expect(screen.getByRole("heading", { name: "No projects yet" })).toBeTruthy()
    expect(screen.getByText(/reuse them in any AI chat/)).toBeTruthy()
    expect(screen.getAllByRole("button")).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: /New project/ }))
    expect(props.onNewSubject).toHaveBeenCalledOnce()
  })

  it("welcomes someone opening Hubble for the first time, and needs no AI setup", () => {
    renderHome({ firstRun: true, onOrganizeOpenTabs: vi.fn() })
    expect(screen.getByRole("heading", { name: "Welcome to Hubble" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /New project/ })).toBeTruthy()
    expect(screen.getByText(/No sign-in needed/)).toBeTruthy()
  })

  it("leads with the projects and what each holds, and opens one", async () => {
    const user = userEvent.setup()
    const props = renderHome({
      subjects: [project("h", "History HL", [source("a", "Causes of WW1", NOW, "chatgpt"), source("b", "Britannica", NOW - 1000)]), project("m", "Math AA HL")],
    })
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy()
    expect(screen.getByText(/1 AI conversation · 1 source/)).toBeTruthy()
    expect(screen.getByText("Empty")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Open Math AA HL" }))
    expect(props.onOpenSubject).toHaveBeenCalledWith("m")
  })

  it("lists what was saved recently across projects, with its AI app, and opens it", async () => {
    const user = userEvent.setup()
    const props = renderHome({ subjects: [project("h", "History HL", [source("a", "Causes of WW1", NOW, "chatgpt")])] })
    const recent = within(screen.getByRole("region", { name: "Recently saved" }))
    const row = recent.getByRole("button", { name: /Causes of WW1/ })
    expect(row.textContent).toContain("ChatGPT")
    await user.click(row)
    expect(props.onOpenItem).toHaveBeenCalledWith("h", { kind: "source", tabId: "a" })
  })

  it("offers search and organizing open tabs once there are projects", async () => {
    const user = userEvent.setup()
    const props = renderHome({ subjects: [project("h", "History HL")], onOrganizeOpenTabs: vi.fn(), onOpenSearch: vi.fn() })
    await user.click(screen.getByRole("button", { name: /Search/ }))
    await user.click(screen.getByRole("button", { name: /Organize open tabs/ }))
    expect(props.onOpenSearch).toHaveBeenCalledOnce()
    expect(props.onOrganizeOpenTabs).toHaveBeenCalledOnce()
  })

  it("says nothing about agents, runtimes or sessions", () => {
    renderHome({ subjects: [project("h", "History HL", [source("a", "Causes of WW1", NOW, "chatgpt")])] })
    expect(document.body.textContent).not.toMatch(/agent|runtime|session|command centre/i)
  })
})

describe("Home: continue working", () => {
  it("anchors on the project something last happened in, and opens its latest item directly", async () => {
    const user = userEvent.setup()
    const props = renderHome({
      subjects: [project("old", "Old project", [source("o", "Older reading", NOW - 5 * 86_400_000)]), project("h", "History HL", [source("a", "Causes of WW1", NOW - 60_000, "chatgpt"), source("b", "Britannica", NOW - 3_600_000)])],
    })
    const card = within(screen.getByRole("region", { name: "Continue" }))
    expect(card.getByText("History HL")).toBeTruthy()
    await user.click(card.getByRole("button", { name: "Open Causes of WW1" }))
    expect(props.onOpenItem).toHaveBeenCalledWith("h", { kind: "source", tabId: "a" })
    await user.click(card.getByRole("button", { name: /^Britannica/ }))
    expect(props.onOpenItem).toHaveBeenLastCalledWith("h", { kind: "source", tabId: "b" })
  })

  it("greets by the hour, and offers the project to the Graph and to Use in AI", async () => {
    const user = userEvent.setup()
    const onShowInGraph = vi.fn()
    const onUseInAi = vi.fn()
    renderHome({ subjects: [project("h", "History HL", [source("a", "Causes of WW1", NOW, "chatgpt")])], onShowInGraph, onUseInAi })
    expect(screen.getByRole("heading", { level: 1, name: "Good evening" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Show in graph/ }))
    expect(onShowInGraph).toHaveBeenCalledWith("p:h")
    await user.click(screen.getByRole("button", { name: /Use in AI/ }))
    expect(onUseInAi).toHaveBeenCalledWith("h")
  })

  it("says what arrived since the last visit, from the visit log", () => {
    window.localStorage.setItem("tabdump:loop-log:v1", JSON.stringify({ version: 1, records: [{ kind: "workspace_revisited", at: NOW - 30 * 3_600_000 }], seen: [] }))
    renderHome({ subjects: [project("h", "History HL", [source("a", "Causes of WW1", NOW - 3_600_000, "chatgpt"), source("b", "Britannica", NOW - 40 * 3_600_000)])] })
    const since = within(screen.getByRole("region", { name: "Since you were last here" }))
    expect(since.getByText("Causes of WW1")).toBeTruthy()
    expect(since.queryByText("Britannica")).toBeNull()
    window.localStorage.clear()
  })
})
