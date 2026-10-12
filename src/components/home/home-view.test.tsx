import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HomeView } from "./home-view"
import type { Workspace } from "@/lib/workspace/types"

const NOW = new Date(2026, 9, 8, 19, 0).getTime()

function subject(id: string, name: string, tabs = 0): Workspace {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    tabs: Array.from({ length: tabs }, (_, index) => ({
      id: `${id}-${index}`,
      url: `https://example.com/${id}/${index}`,
      normalizedUrl: `https://example.com/${id}/${index}`,
      domain: "example.com",
      title: `${name} reading ${index}`,
      createdAt: NOW - index * 1000,
    })),
  }
}

function renderHome(overrides: Partial<Parameters<typeof HomeView>[0]> = {}) {
  const props = {
    subjects: [] as Workspace[],
    firstRun: false,
    now: NOW,
    onOpenSubject: vi.fn(),
    onNewSubject: vi.fn(),
    onOpenResource: vi.fn(),
    aiConnected: true,
    onConnectAI: vi.fn(),
    ...overrides,
  }
  render(<HomeView {...props} />)
  return props
}

describe("Home", () => {
  it("with no subjects, is one line and one button", async () => {
    const user = userEvent.setup()
    const props = renderHome()
    expect(screen.getByRole("heading", { name: "Start with a subject" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /New subject/ }))
    expect(props.onNewSubject).toHaveBeenCalledOnce()
    expect(screen.getByRole("main").textContent?.replace(/\s+/g, " ").trim()).toBe("Start with a subject New subject")
  })

  it("welcomes someone opening Hubble for the first time", () => {
    renderHome({ firstRun: true })
    expect(screen.getByRole("heading", { name: "Welcome to Hubble" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Create your first subject/ })).toBeTruthy()
  })

  it("leads with the subjects, and opens one", async () => {
    const user = userEvent.setup()
    const props = renderHome({ subjects: [subject("h", "History HL", 3), subject("m", "Math AA HL")] })
    expect(screen.getByText("Good evening")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "What are you working on?" })).toBeTruthy()
    expect(screen.getByText("3 resources · Just now", { exact: false })).toBeTruthy()
    expect(screen.getByText("Empty")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Open Math AA HL" }))
    expect(props.onOpenSubject).toHaveBeenCalledWith("m")
  })

  it("shows recent resources and opens them", async () => {
    const user = userEvent.setup()
    const props = renderHome({ subjects: [subject("h", "History HL", 2)] })
    await user.click(screen.getByRole("button", { name: /History HL reading 0/ }))
    expect(props.onOpenResource).toHaveBeenCalledWith("h", "h-0")
  })

  it("offers Connect AI quietly, and only while none is connected", async () => {
    const user = userEvent.setup()
    const props = renderHome({ subjects: [subject("h", "History HL")], aiConnected: false })
    await user.click(screen.getByRole("button", { name: "Connect AI" }))
    expect(props.onConnectAI).toHaveBeenCalledOnce()
  })

  it("keeps the first-run screen to one button, even where organizing open tabs is offered", () => {
    renderHome({ onOrganizeOpenTabs: vi.fn() })
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })

  it("offers to organize open tabs beside New subject once there are subjects", async () => {
    const user = userEvent.setup()
    const props = renderHome({ subjects: [subject("h", "History HL", 1)], onOrganizeOpenTabs: vi.fn() })
    await user.click(screen.getByRole("button", { name: /Organize open tabs/ }))
    expect(props.onOrganizeOpenTabs).toHaveBeenCalledOnce()
  })

  it("has no dashboard numbers or agent talk", () => {
    renderHome({ subjects: [subject("h", "History HL", 3)], aiConnected: false })
    expect(document.body.textContent).not.toMatch(/agent|runtime|workspace|session|context/i)
  })
})
