import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { AppShell } from "./app-shell"
import { Toaster } from "@/components/ui/sonner"
import { dismissOnboarding } from "@/lib/onboarding"
import { saveWorkspaceStore } from "@/lib/workspace/persistence"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * The shell's half of workspace → agent: every "Ask agent" lands in the
 * Command Centre working in the workspace the user asked from, and "Add to
 * agent context" collects without leaving — and is dropped, not carried, when
 * the user moves to another workspace.
 *
 * The runtime is unreachable here (no server in jsdom), which is itself a
 * state the Command Centre must handle: it still says which workspace it
 * would work in.
 */

function store(): WorkspaceStore {
  const tab = (id: string, title: string) => ({
    id,
    url: `https://example.com/${id}`,
    normalizedUrl: `https://example.com/${id}`,
    domain: "example.com",
    category: "other" as const,
    title,
  })
  return {
    version: 1,
    currentId: "w-research",
    workspaces: [
      { id: "w-research", name: "Research", createdAt: 0, updatedAt: 0, tabs: [tab("a", "Relativity paper"), tab("b", "CERN article")] },
      { id: "w-dev", name: "Development", createdAt: 0, updatedAt: 0, tabs: [tab("c", "Next.js docs"), tab("d", "Vercel")] },
    ],
  }
}

beforeEach(() => {
  window.localStorage.clear()
  dismissOnboarding()
  saveWorkspaceStore(store())
  toast.dismiss()
  // No runtime: every request to it fails, as it would with no server.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("offline")
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByPlaceholderText("Search tabs...")
  await user.keyboard("{Control>}k{/Control}")
  return screen.findByPlaceholderText("Search tabs, workspaces, agents and commands…")
}

describe("asking an agent from the workspace", () => {
  it("opens the Command Centre working in the workspace the user asked from", async () => {
    const user = userEvent.setup()
    render(<AppShell />)

    const input = await openPalette(user)
    await user.type(input, "Ask agent about Research{Enter}")

    expect(await screen.findByRole("heading", { name: "Work on Research" })).toBeTruthy()
    expect(screen.getAllByText("Research").length).toBeGreaterThan(0)
  })

  async function addBothToAgentContext(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByPlaceholderText("Search tabs..."), "example")
    await user.click(screen.getByRole("button", { name: "Select" }))
    for (const checkbox of screen.getAllByLabelText("Select example.com")) await user.click(checkbox)
    await user.click(screen.getByRole("button", { name: "Ask agent" }))
    await user.click(await screen.findByRole("menuitem", { name: "Add to agent context" }))
  }

  it("collects context without leaving the workspace, and brings it to the Command Centre", async () => {
    const user = userEvent.setup()
    render(
      <>
        <AppShell />
        <Toaster />
      </>
    )
    await addBothToAgentContext(user)

    expect(await screen.findByText("Added to agent context")).toBeTruthy()
    expect(screen.getByText(/2 tabs · waiting in the Command Centre/)).toBeTruthy()
    // Still in the workspace.
    expect(screen.getByPlaceholderText("Search tabs...")).toBeTruthy()

    const input = await openPalette(user)
    await user.type(input, "Open Command Centre{Enter}")
    const panel = await screen.findByRole("complementary", { name: "Session context" })
    await waitFor(() => expect(within(panel).getByRole("region", { name: "Tabs in context" }).textContent).toContain("Relativity paper"))
    expect(within(panel).getByRole("region", { name: "Tabs in context" }).textContent).toContain("CERN article")
    expect(within(panel).getByText("Research")).toBeTruthy()
  })

  it("drops collected context when the user moves to another workspace — it never follows them", async () => {
    const user = userEvent.setup()
    render(
      <>
        <AppShell />
        <Toaster />
      </>
    )
    await addBothToAgentContext(user)
    await screen.findByText("Added to agent context")

    const switcher = await openPalette(user)
    await user.type(switcher, "Switch to Development{Enter}")
    const input = await openPalette(user)
    await user.type(input, "Open Command Centre{Enter}")

    expect(await screen.findByRole("heading", { name: "Work on Development" })).toBeTruthy()
    const panel = screen.getByRole("complementary", { name: "Session context" })
    expect(within(panel).queryByRole("region", { name: "Tabs in context" })).toBeNull()
    expect(panel.textContent).not.toContain("Relativity paper")
  })
})
