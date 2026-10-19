import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const restoreTabs = vi.fn()
vi.mock("@/lib/sessions/restore", () => ({ restoreTabs: (...args: unknown[]) => restoreTabs(...args) }))
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>()
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
  return { ...actual, toast }
})

import { toast } from "sonner"
import { HomeView } from "@/components/home/home-view"
import { SessionsView } from "./sessions-view"
import { createSession } from "@/lib/sessions/model"
import { SESSIONS_STORAGE_KEY, __resetSessionsForTests, getSessionsSnapshot, writeSessions } from "@/lib/sessions/persistence"
import type { TabSession } from "@/lib/sessions/types"

const NOW = new Date(2026, 9, 19, 18, 0).getTime()
let n = 0
const mintId = () => `id-${++n}`

function seed(name: string, urls: string[], at: number, workspaceId?: string): TabSession {
  const result = writeSessions((state) =>
    createSession(state, { name, tabs: urls.map((url, i) => ({ url, title: `${name} tab ${i + 1}` })), ...(workspaceId ? { workspaceId } : {}) }, { now: at, mintId })
  )
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function view() {
  return render(<SessionsView projects={[{ id: "ia", name: "History IA" }]} now={NOW} />)
}

function row(name: string) {
  return within(screen.getByRole("button", { name: `See the tabs in ${name}` }).closest("li")!)
}

beforeEach(() => {
  localStorage.clear()
  __resetSessionsForTests()
  restoreTabs.mockReset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

afterEach(() => __resetSessionsForTests())

describe("SessionsView", () => {
  it("offers to save the first session when there are none", () => {
    view()
    expect(screen.getByText("No saved sessions")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /save current session/i }).length).toBeGreaterThan(0)
    expect(screen.queryByRole("list", { name: "Saved sessions" })).toBeNull()
  })

  it("lists sessions most recently used first, with tab count, time and project", () => {
    seed("Older", ["https://a.example/"], NOW - 3 * 86_400_000)
    seed("Essay", ["https://a.example/", "https://b.example/"], NOW - 2 * 3_600_000, "ia")
    view()
    const items = within(screen.getByRole("list", { name: "Saved sessions" })).getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("Essay"), expect.stringContaining("Older")])
    expect(items[0].textContent).toContain("2 tabs · Saved 2 hr ago · History IA")
  })

  it("renames a session without touching its tabs", async () => {
    const user = userEvent.setup()
    const saved = seed("Essay", ["https://a.example/", "https://b.example/"], NOW)
    view()
    await user.click(row("Essay").getByRole("button", { name: "More actions for Essay" }))
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const input = await screen.findByRole("textbox", { name: "Session name" })
    await user.clear(input)
    await user.type(input, "WW1 essay{Enter}")
    await waitFor(() => expect(getSessionsSnapshot().sessions[0].name).toBe("WW1 essay"))
    expect(getSessionsSnapshot().sessions[0].tabs).toEqual(saved.tabs)
    expect(getSessionsSnapshot().sessions[0].updatedAt).toBe(saved.updatedAt)
  })

  it("edits tabs only when saved; cancelling leaves the snapshot exactly as it was", async () => {
    const user = userEvent.setup()
    seed("Essay", ["https://a.example/", "https://b.example/", "https://c.example/"], NOW)
    const stored = localStorage.getItem(SESSIONS_STORAGE_KEY)
    view()

    await user.click(row("Essay").getByRole("button", { name: "More actions for Essay" }))
    await user.click(await screen.findByRole("menuitem", { name: "Edit tabs" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("checkbox", { name: "Essay tab 1" }))
    await user.click(within(dialog).getByRole("button", { name: "Remove 1 tab" }))
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(localStorage.getItem(SESSIONS_STORAGE_KEY)).toBe(stored)

    await user.click(row("Essay").getByRole("button", { name: "More actions for Essay" }))
    await user.click(await screen.findByRole("menuitem", { name: "Edit tabs" }))
    const again = await screen.findByRole("dialog")
    await user.click(within(again).getByRole("button", { name: "Move Essay tab 3 up" }))
    await user.click(within(again).getByRole("checkbox", { name: "Essay tab 1" }))
    await user.click(within(again).getByRole("button", { name: "Remove 1 tab" }))
    await user.click(within(again).getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(getSessionsSnapshot().sessions[0].tabs.map((tab) => tab.url)).toEqual(["https://c.example/", "https://b.example/"]))
  })

  it("asks before deleting, and cancelling keeps the session", async () => {
    const user = userEvent.setup()
    seed("Essay", ["https://a.example/"], NOW)
    view()
    await user.click(row("Essay").getByRole("button", { name: "More actions for Essay" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    const confirm = await screen.findByRole("alertdialog")
    expect(confirm.textContent).toContain("Tabs open in Chrome stay open")
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }))
    expect(getSessionsSnapshot().sessions).toHaveLength(1)

    await user.click(row("Essay").getByRole("button", { name: "More actions for Essay" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete session" }))
    await waitFor(() => expect(getSessionsSnapshot().sessions).toHaveLength(0))
  })

  it("combines two sessions, skips the duplicate link, and leaves the originals alone", async () => {
    const user = userEvent.setup()
    restoreTabs.mockResolvedValue({ kind: "opened", opened: 3, failed: [] })
    seed("Physics", ["https://phys.example/", "https://shared.example/"], NOW - 1000)
    seed("Essay", ["https://essay.example/", "https://shared.example/"], NOW)
    const before = localStorage.getItem(SESSIONS_STORAGE_KEY)
    view()

    await user.click(row("Essay").getByRole("button", { name: "Start Essay" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("checkbox", { name: "Add Physics" }))
    expect(within(dialog).getByText(/Skip duplicate links \(1\)/)).toBeTruthy()
    // The skipped copy says why it won't open.
    expect(within(dialog).getAllByText("Duplicate")).toHaveLength(1)
    await user.click(within(dialog).getByRole("button", { name: "Open 3 tabs" }))

    await waitFor(() => expect(restoreTabs).toHaveBeenCalledTimes(1))
    expect(restoreTabs.mock.calls[0][0]).toEqual([{ url: "https://essay.example/" }, { url: "https://shared.example/" }, { url: "https://phys.example/" }])
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // Only "last opened" was recorded; the saved tabs are unchanged.
    const after = getSessionsSnapshot().sessions
    const original = JSON.parse(before!).sessions as TabSession[]
    for (const session of original) {
      const now = after.find((entry) => entry.id === session.id)!
      expect(now.tabs).toEqual(session.tabs)
      expect(now.lastRestoredAt).toBeGreaterThan(0)
    }
  })

  it("keeps intentional duplicates when the switch is turned off, and can save the combination", async () => {
    const user = userEvent.setup()
    seed("Physics", ["https://shared.example/"], NOW - 1000)
    seed("Essay", ["https://shared.example/"], NOW)
    view()
    await user.click(row("Essay").getByRole("button", { name: "Start Essay" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("checkbox", { name: "Add Physics" }))
    expect(within(dialog).getByRole("button", { name: "Open 1 tab" })).toBeTruthy()
    await user.click(within(dialog).getByRole("switch", { name: "Skip duplicate links" }))
    expect(within(dialog).getByRole("button", { name: "Open 2 tabs" })).toBeTruthy()

    await user.click(within(dialog).getByRole("button", { name: "Save as new session" }))
    await user.type(within(dialog).getByRole("textbox", { name: "Name for the new session" }), "Both{Enter}")
    await waitFor(() => expect(getSessionsSnapshot().sessions.map((session) => session.name)).toContain("Both"))
    expect(getSessionsSnapshot().sessions.find((session) => session.name === "Both")!.tabs).toHaveLength(2)
    expect(restoreTabs).not.toHaveBeenCalled()
  })

  it("does not record a launch that Chrome did not carry out", async () => {
    const user = userEvent.setup()
    restoreTabs.mockResolvedValue({ kind: "no-extension" })
    seed("Essay", ["https://a.example/"], NOW)
    view()
    await user.click(row("Essay").getByRole("button", { name: "Start Essay" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Open 1 tab" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Hubble for Chrome isn't connected", expect.anything()))
    expect(getSessionsSnapshot().sessions[0].lastRestoredAt).toBeUndefined()
    expect(screen.getByRole("dialog")).toBeTruthy()
  })
})

describe("Home: pick up where you left off", () => {
  function home() {
    return render(
      <HomeView subjects={[]} firstRun={false} now={NOW} onOpenSubject={vi.fn()} onNewSubject={vi.fn()} onOpenItem={vi.fn()} onOpenSessions={vi.fn()} />
    )
  }

  it("resumes the most recent session in one click", async () => {
    const user = userEvent.setup()
    restoreTabs.mockResolvedValue({ kind: "opened", opened: 2, failed: [] })
    seed("Older", ["https://old.example/"], NOW - 86_400_000)
    seed("Essay", ["https://a.example/", "https://b.example/"], NOW - 60_000)
    home()
    const card = within(screen.getByRole("region", { name: "Pick up where you left off" }))
    expect(card.getByText("Essay")).toBeTruthy()
    expect(card.getByText("2 tabs · Saved 1 min ago")).toBeTruthy()
    await user.click(card.getByRole("button", { name: "Resume Essay" }))
    await waitFor(() => expect(restoreTabs).toHaveBeenCalledWith([{ url: "https://a.example/" }, { url: "https://b.example/" }], expect.anything()))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Opened 2 tabs in a new window", undefined))
  })

  it("asks first before opening a large session", async () => {
    const user = userEvent.setup()
    restoreTabs.mockResolvedValue({ kind: "opened", opened: 20, failed: [] })
    seed("Big", Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`), NOW)
    home()
    await user.click(screen.getByRole("button", { name: "Resume Big" }))
    const confirm = await screen.findByRole("alertdialog")
    expect(restoreTabs).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole("button", { name: "Open 20 tabs" }))
    await waitFor(() => expect(restoreTabs).toHaveBeenCalledTimes(1))
  })

  it("shows no panel without sessions, only a quiet prompt", () => {
    render(
      <HomeView
        subjects={[{ id: "ia", name: "History IA", tabs: [], createdAt: 1, updatedAt: 1 }]}
        firstRun={false}
        now={NOW}
        onOpenSubject={vi.fn()}
        onNewSubject={vi.fn()}
        onOpenItem={vi.fn()}
        onOpenSessions={vi.fn()}
      />
    )
    expect(screen.queryByRole("region", { name: "Pick up where you left off" })).toBeNull()
    expect(screen.getByRole("button", { name: "Save your open tabs as a session" })).toBeTruthy()
  })
})
