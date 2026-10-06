import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentActivity } from "./agent-activity"
import type { ActionInspection } from "@/lib/agents/activity/inspector"
import type { AgentActivityEntry } from "@/lib/agents/activity/timeline"

/**
 * The shared activity surface: which entries open, how the inspector is
 * reached by keyboard and left again, and what Undo does when it works and
 * when it does not. The inspection itself is the model's (inspector.test.ts);
 * here it is given.
 */

const NOW = 1_700_000_100_000

function entry(over: Partial<AgentActivityEntry> & Pick<AgentActivityEntry, "id" | "title" | "kind" | "status">): AgentActivityEntry {
  return { sessionId: "s1", provider: "claude-code", workspaceId: "w1", at: NOW - 30_000, count: 1, ...over }
}

const ENTRIES: AgentActivityEntry[] = [
  entry({ id: "connect:s1", kind: "connected", status: "info", title: "Claude Code connected" }),
  entry({ id: "read:e2", kind: "searching", status: "completed", title: "Found 14 relevant tabs" }),
  entry({ id: "change:ctxa-1", kind: "created", status: "completed", title: "Created collection “Pricing Research”", refs: { changeId: "ctxa-1", approvalId: "wa-1" } }),
  entry({
    id: "file:x",
    kind: "created",
    status: "completed",
    title: "Created research-summary.md",
    refs: { file: { relativePath: "research-summary.md", projectId: "p1", operation: "created" } },
  }),
]

const collectionInspection: ActionInspection = {
  key: "approval:wa-1",
  title: "Created collection “Pricing Research”",
  status: "completed",
  agentName: "Claude Code",
  provider: "claude-code",
  workspaceName: "Research",
  action: "Create collection",
  chain: [
    { key: "requested", label: "Requested by Claude Code", at: NOW - 60_000, tone: "done" },
    { key: "decision", label: "Approved", at: NOW - 50_000, tone: "done" },
    { key: "result", label: "Completed", at: NOW - 30_000, tone: "done" },
  ],
  request: { summary: "Create collection “Pricing Research” · 5 tabs" },
  result: { tone: "success", text: "Created “Pricing Research” in Research." },
  changes: { planned: false, lines: [{ sign: "add", text: "Collection “Pricing Research” · 5 tabs" }] },
  view: { changeId: "ctxa-1", label: "Open collection" },
  undo: { kind: "available", changeId: "ctxa-1", effects: ["Remove the collection “Pricing Research”"], label: "Undo" },
}

const fileInspection: ActionInspection = {
  key: "file:x",
  title: "Created research-summary.md",
  status: "completed",
  agentName: "Claude Code",
  provider: "claude-code",
  chain: [{ key: "result", label: "Completed", tone: "done" }],
  file: { relativePath: "research-summary.md" },
  undo: { kind: "unavailable", reason: "Undo isn't available for this change. Hubble doesn't keep a copy of the files agents write, so it can't safely put them back." },
}

function renderActivity(props: { onUndo?: (changeId: string) => boolean; onViewChange?: (changeId: string) => void } = {}) {
  const inspect = vi.fn((id: string) => (id === "change:ctxa-1" ? collectionInspection : id === "file:x" ? fileInspection : null))
  render(
    <AgentActivity entries={ENTRIES} provider="claude-code" agentName="Claude Code" now={NOW} inspect={inspect} {...props} />
  )
  return { inspect }
}

describe("which entries open", () => {
  it("makes actions clickable and leaves informational entries as plain text", () => {
    renderActivity()
    const list = screen.getByRole("list", { name: "Claude Code activity, newest first" })
    expect(within(list).getByRole("button", { name: /Created collection “Pricing Research”/ })).toBeTruthy()
    expect(within(list).getByRole("button", { name: /Created research-summary.md/ })).toBeTruthy()
    expect(within(list).queryByRole("button", { name: /Found 14 relevant tabs/ })).toBeNull()
    expect(within(list).queryByRole("button", { name: /Claude Code connected/ })).toBeNull()
  })

  it("opens by keyboard, focuses the inspector's heading, and returns focus to the row on the way back", async () => {
    const user = userEvent.setup()
    renderActivity()
    const row = screen.getByRole("button", { name: /Created collection “Pricing Research”/ })
    row.focus()
    await user.keyboard("{Enter}")
    const heading = screen.getByRole("heading", { name: "Created collection “Pricing Research”" })
    expect(document.activeElement).toBe(heading)
    await user.click(screen.getByRole("button", { name: "All activity" }))
    expect(document.activeElement?.getAttribute("data-activity-inspect")).toBe("change:ctxa-1")
  })
})

describe("what the inspector offers", () => {
  it("shows only the sections the action has", async () => {
    const user = userEvent.setup()
    renderActivity()
    await user.click(screen.getByRole("button", { name: /Created research-summary.md/ }))
    const article = screen.getByRole("article")
    expect(within(article).queryByText("Original request")).toBeNull()
    expect(within(article).queryByText("Changes")).toBeNull()
    expect(within(article).getByText("research-summary.md")).toBeTruthy()
  })

  it("never shows an Undo that cannot work — it says why instead", async () => {
    const user = userEvent.setup()
    renderActivity({ onUndo: vi.fn(() => true) })
    await user.click(screen.getByRole("button", { name: /Created research-summary.md/ }))
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull()
    expect(screen.getByText(/^Undo isn't available for this change\./)).toBeTruthy()
  })

  it("goes to the change with View", async () => {
    const user = userEvent.setup()
    const onViewChange = vi.fn()
    renderActivity({ onViewChange })
    await user.click(screen.getByRole("button", { name: /Created collection “Pricing Research”/ }))
    await user.click(screen.getByRole("button", { name: "Open collection" }))
    expect(onViewChange).toHaveBeenCalledWith("ctxa-1")
  })
})

describe("undo", () => {
  it("asks once, saying exactly what it will do, and Cancel changes nothing", async () => {
    const user = userEvent.setup()
    const onUndo = vi.fn(() => true)
    renderActivity({ onUndo })
    await user.click(screen.getByRole("button", { name: /Created collection “Pricing Research”/ }))
    await user.click(screen.getByRole("button", { name: "Undo" }))
    const confirm = within(screen.getByRole("group", { name: "Undo this change?" }))
    expect(confirm.getByText("Remove the collection “Pricing Research”")).toBeTruthy()
    await user.click(confirm.getByRole("button", { name: "Cancel" }))
    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.queryByRole("group", { name: "Undo this change?" })).toBeNull()
  })

  it("says so when undo is refused — in plain words, nothing changed — and offers Try again", async () => {
    const user = userEvent.setup()
    const onUndo = vi.fn(() => false)
    renderActivity({ onUndo })
    await user.click(screen.getByRole("button", { name: /Created collection “Pricing Research”/ }))
    await user.click(screen.getByRole("button", { name: "Undo" }))
    await user.click(screen.getByRole("button", { name: "Undo change" }))
    const alert = within(screen.getByRole("alert"))
    expect(alert.getByText("Couldn't undo this change")).toBeTruthy()
    expect(alert.getByText("This change can't be undone because the workspace has changed since it was made. Nothing was changed.")).toBeTruthy()
    await user.click(alert.getByRole("button", { name: "Try again" }))
    expect(onUndo).toHaveBeenCalledTimes(2)
    expect(onUndo).toHaveBeenLastCalledWith("ctxa-1")
  })

  it("treats an undo that throws as refused, never as done", async () => {
    const user = userEvent.setup()
    renderActivity({
      onUndo: () => {
        throw new Error("store unavailable")
      },
    })
    await user.click(screen.getByRole("button", { name: /Created collection “Pricing Research”/ }))
    await user.click(screen.getByRole("button", { name: "Undo" }))
    await user.click(screen.getByRole("button", { name: "Undo change" }))
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't undo this change/)
  })
})
