/**
 * Smart Organize for open tabs, in the real <AppShell/>: Home's "Organize open
 * tabs" reads Chrome's tabs through the extension bridge, the review proposes
 * groups, and confirming adds them as sources — to the subject they clearly
 * belong to, or to a new one — in one saved commit that Undo takes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { AppShell } from "./app-shell"
import { dismissOnboarding } from "@/lib/onboarding"
import { loadWorkspaceStore, saveWorkspaceStore } from "@/lib/workspace/persistence"
import type { WorkspaceStore } from "@/lib/workspace/types"

vi.mock("@/lib/browser/history", () => ({ fetchBrowserHistory: vi.fn() }))

const sendBrowserCommand = vi.hoisted(() => vi.fn())
vi.mock("@/lib/browser/bridge", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/browser/bridge")>()), sendBrowserCommand }))

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>()
  const fn = Object.assign(vi.fn(() => "toast-id"), { error: vi.fn(), warning: vi.fn(() => "toast-id"), success: vi.fn(), info: vi.fn(), dismiss: vi.fn(), message: vi.fn() })
  return { ...actual, toast: fn }
})

const tab = (tabId: number, url: string, title: string) => ({ tabId, windowId: 1, url, title, pinned: false, active: false, index: tabId })

const SEEDED: WorkspaceStore = {
  version: 1,
  currentId: "ws-history",
  workspaces: [
    {
      id: "ws-history",
      name: "History IA",
      tabs: [
        {
          id: "h1",
          url: "https://notes.example/revolution-essay",
          normalizedUrl: "https://notes.example/revolution-essay",
          domain: "notes.example",
          title: "French Revolution essay plan",
          createdAt: 1,
          updatedAt: 1,
          resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1 },
        },
      ],
      sections: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
}

beforeEach(() => {
  window.localStorage.clear()
  dismissOnboarding()
  saveWorkspaceStore(SEEDED)
  vi.mocked(toast).mockClear()
  sendBrowserCommand.mockReset()
  sendBrowserCommand.mockImplementation(async (action: string) =>
    action === "list_browser_tabs"
      ? {
          id: "1",
          ok: true,
          result: {
            tabs: [
              tab(1, "https://a.example/projectile", "Projectile motion lab"),
              tab(2, "https://b.example/projectile-calc", "Projectile motion calculator"),
              tab(3, "https://c.example/frev", "French Revolution causes"),
              tab(4, "https://d.example/frev2", "French Revolution timeline"),
              tab(5, "https://notes.example/revolution-essay", "French Revolution essay plan"),
              tab(6, "https://e.example/misc", "Weekend plans"),
            ],
          },
        }
      : action === "list_browser_windows"
        ? { id: "2", ok: true, result: { windows: [{ windowId: 1, focused: true, incognito: false, type: "normal", tabIds: [1, 2, 3, 4, 5, 6] }] } }
        : { id: "1", ok: false, error: "not in this test" }
  )
})

afterEach(() => cleanup())

const summary = (store: WorkspaceStore | null) =>
  store?.workspaces.map((workspace) => [workspace.name, workspace.tabs.map((entry) => entry.title).sort()]) ?? []

describe("Organize open tabs", () => {
  it("cancelling the review changes nothing", async () => {
    const user = userEvent.setup()
    render(<AppShell />)
    const open = await screen.findByRole("button", { name: /Organize open tabs/ })
    // After the shell has loaded (it normalizes and re-saves the store on mount), before anything is organized.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const before = window.localStorage.getItem("tabdump:workspaces:v1")
    await user.click(open)
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Organize open tabs" })).toBeNull())
    expect(window.localStorage.getItem("tabdump:workspaces:v1")).toBe(before)
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/^Organized/), expect.anything())
  }, 30_000)

  it("files Chrome's tabs into the right subjects, leaves the rest open, saves, and undoes", async () => {
    const user = userEvent.setup()
    render(<AppShell />)
    await user.click(await screen.findByRole("button", { name: /Organize open tabs/ }))
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })

    // The page already saved is left out; the revolution group goes to History IA, where its topic already lives.
    expect(within(dialog).getByText(/Already in History IA/)).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Add to History IA" })).toBeTruthy()

    await user.click(within(dialog).getByRole("button", { name: "Organize 4 pages" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Organize open tabs" })).toBeNull())

    await waitFor(() =>
      expect(summary(loadWorkspaceStore())).toEqual([
        ["History IA", ["French Revolution causes", "French Revolution essay plan", "French Revolution timeline"]],
        ["Projectile motion", ["Projectile motion calculator", "Projectile motion lab"]],
      ])
    )
    // Nothing was closed: the shell never asked the extension to.
    expect(sendBrowserCommand.mock.calls.map(([action]) => action)).not.toContain("close_tabs")
    expect(sendBrowserCommand.mock.calls.map(([action]) => action)).not.toContain("close_tab")
    // Still where they were.
    expect(loadWorkspaceStore()!.currentId).toBe("ws-history")

    expect(toast).toHaveBeenCalledWith("Organized 4 pages into 2 subjects (1 new)", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }))
    const options = vi.mocked(toast).mock.calls.find(([title]) => title === "Organized 4 pages into 2 subjects (1 new)")![1] as unknown as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    await waitFor(() => expect(summary(loadWorkspaceStore())).toEqual([["History IA", ["French Revolution essay plan"]]]))
  }, 30_000)

  it("Undo keeps a source the person has filed in a collection since, with its subject", async () => {
    const user = userEvent.setup()
    render(<AppShell />)
    await user.click(await screen.findByRole("button", { name: /Organize open tabs/ }))
    const dialog = await screen.findByRole("dialog", { name: "Organize open tabs" })
    await within(dialog).findByRole("list", { name: "Suggested groups" })
    await user.click(within(dialog).getByRole("button", { name: "Organize 4 pages" }))
    await waitFor(() => expect(loadWorkspaceStore()!.workspaces).toHaveLength(2))

    // Meanwhile the person files the lab page in a collection of the new subject.
    const projectile = loadWorkspaceStore()!.workspaces.find((workspace) => workspace.name === "Projectile motion")!
    const lab = projectile.tabs.find((entry) => entry.title === "Projectile motion lab")!
    window.localStorage.setItem(
      "tabdump:collections:v1",
      JSON.stringify({ version: 1, collections: [{ id: "c1", workspaceId: projectile.id, name: "IA", tabIds: [lab.id], createdAt: 1, updatedAt: 1 }] })
    )

    const options = vi.mocked(toast).mock.calls.find(([title]) => title === "Organized 4 pages into 2 subjects (1 new)")![1] as unknown as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    await waitFor(() =>
      expect(summary(loadWorkspaceStore())).toEqual([
        ["History IA", ["French Revolution essay plan"]],
        ["Projectile motion", ["Projectile motion lab"]],
      ])
    )
    expect(toast).toHaveBeenCalledWith("Undid the organization", expect.objectContaining({ description: expect.stringContaining("kept Projectile motion") }))
  }, 30_000)
})
