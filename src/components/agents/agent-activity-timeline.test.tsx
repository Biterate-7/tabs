import { describe, expect, it, vi } from "vitest"
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentActivityTimeline } from "./agent-activity-timeline"
import { useAgentActivity } from "@/hooks/use-agent-activity"
import { useAgentSession } from "@/hooks/use-agent-session"
import {
  createScriptedRuntime,
  scriptedApproval,
  scriptedEvent,
  scriptedSession,
} from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { AgentActivityEntry } from "@/lib/agents/activity/timeline"

/**
 * The timeline as a person and a screen reader meet it. The entries are the
 * builder's (tested in lib/agents/activity); these tests hold the drawing:
 * every state is said in words as well as shown, the waiting state stands
 * out, a long history stays light, and new activity arrives without a reload.
 */

const NOW = 1_700_000_600_000

function entry(over: Partial<AgentActivityEntry> & Pick<AgentActivityEntry, "id" | "title" | "status">): AgentActivityEntry {
  return { sessionId: "s1", provider: "claude-code", workspaceId: "w1", kind: "reading", at: NOW - 120_000, count: 1, ...over }
}

function draw(entries: AgentActivityEntry[], over: Partial<Parameters<typeof AgentActivityTimeline>[0]> = {}) {
  return render(<AgentActivityTimeline entries={entries} provider="claude-code" agentName="Claude Code" now={NOW} {...over} />)
}

describe("each state", () => {
  it("draws completed, active, waiting, failed and informational entries, each said in words", () => {
    draw([
      entry({ id: "a", kind: "connected", status: "info", title: "Claude Code connected", description: "Working in Research" }),
      entry({ id: "b", status: "completed", title: "Found 14 relevant tabs", description: "Searched Research" }),
      entry({ id: "c", kind: "approval_required", status: "waiting", title: "Waiting for approval", description: "Create research-summary.md" }),
      entry({ id: "d", kind: "action_failed", status: "failed", title: "Couldn't edit report.md" }),
      entry({ id: "e", kind: "reading", status: "active", title: "Reading workspace…", at: NOW }),
    ])
    const list = screen.getByRole("list", { name: "Claude Code activity, newest first" })
    const rows = within(list).getAllByRole("listitem")
    // Newest first.
    expect(rows.map((row) => row.getAttribute("data-activity-status"))).toEqual(["active", "failed", "waiting", "completed", "info"])
    // Never colour alone: every glyph has a name.
    expect(within(rows[0]!).getByRole("img", { name: "In progress" })).toBeTruthy()
    expect(rows[0]!.getAttribute("aria-busy")).toBe("true")
    expect(within(rows[1]!).getByRole("img", { name: "Failed" })).toBeTruthy()
    expect(within(rows[2]!).getByRole("img", { name: "Needs your attention" })).toBeTruthy()
    expect(within(rows[3]!).getByRole("img", { name: "Done" })).toBeTruthy()
    expect(within(rows[4]!).getByRole("img", { name: "Update" })).toBeTruthy()
  })

  it("says where an approval is answered, without offering a second way to answer it", () => {
    draw([entry({ id: "c", kind: "approval_required", status: "waiting", title: "Waiting for approval", description: "Create research-summary.md" })])
    expect(screen.getByText("Create research-summary.md")).toBeTruthy()
    expect(screen.getByText(/answer it in the conversation/i)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approve|deny|allow/i })).toBeNull()
  })

  it("offers the recovery a failed session has, and View on an applied change", async () => {
    const user = userEvent.setup()
    const onNewSession = vi.fn()
    const onViewChange = vi.fn()
    draw(
      [
        entry({ id: "x", kind: "created", status: "completed", title: "Created collection “Physics”", action: { kind: "view_change", changeId: "ctxa-1" } }),
        entry({ id: "y", kind: "disconnected", status: "failed", title: "Claude Code disconnected", action: { kind: "new_session" }, at: NOW }),
      ],
      { onNewSession, onViewChange }
    )
    await user.click(screen.getByRole("button", { name: "Start a new session" }))
    await user.click(screen.getByRole("button", { name: "View" }))
    expect(onNewSession).toHaveBeenCalledOnce()
    expect(onViewChange).toHaveBeenCalledWith("ctxa-1")
  })

  it("says when something happened, as a person reads time", () => {
    draw([
      entry({ id: "a", status: "completed", title: "Older", at: NOW - 5 * 60_000 }),
      entry({ id: "b", status: "completed", title: "Newer", at: NOW - 10_000 }),
    ])
    expect(screen.getByText("Just now")).toBeTruthy()
    expect(screen.getByText(/5 min/)).toBeTruthy()
  })

  it("names the agent, with its own mark", () => {
    draw([], { provider: "gemini", agentName: "Gemini", statusLabel: "Running" })
    expect(screen.getByText("Gemini")).toBeTruthy()
    expect(screen.getByText("Running")).toBeTruthy()
  })
})

describe("empty and long", () => {
  it("says nothing has happened yet, rather than drawing an empty list", () => {
    draw([])
    expect(screen.queryByRole("list")).toBeNull()
    expect(screen.getByText(/nothing yet/i)).toBeTruthy()
  })

  it("shows the most recent entries of a long history and the rest on request", async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 120 }, (_, index) => entry({ id: `e${index}`, status: "completed", title: `Step ${index}`, at: NOW - (120 - index) * 1000 }))
    draw(many)
    expect(screen.getAllByRole("listitem")).toHaveLength(40)
    expect(screen.getByText("Step 119")).toBeTruthy()
    expect(screen.queryByText("Step 0")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Show 80 earlier" }))
    expect(screen.getAllByRole("listitem")).toHaveLength(120)
    expect(screen.getByText("Step 0")).toBeTruthy()
  })
})

describe("announcements", () => {
  it("announces new activity politely, and an approval first — but not what was already there", () => {
    const first = [entry({ id: "a", status: "completed", title: "Read workspace" })]
    const view = draw(first)
    const region = screen.getByRole("status")
    expect(region.getAttribute("aria-live")).toBe("polite")
    expect(region.textContent).toBe("")

    view.rerender(
      <AgentActivityTimeline
        entries={[...first, entry({ id: "b", kind: "approval_required", status: "waiting", title: "Waiting for approval", description: "Create notes.md", at: NOW })]}
        provider="claude-code"
        agentName="Claude Code"
        now={NOW}
      />
    )
    expect(region.textContent).toBe("Needs your attention: Waiting for approval. Create notes.md")
  })
})

describe("live updates", () => {
  it("grows as the runtime journals new events — no reload, through the real session hook", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ status: "running", workspaceId: "w1" })] })
    runtime.pushEvents([scriptedEvent({ id: "start", kind: "session_started", summary: "Session started." })])

    const { result } = renderHook(() => {
      const session = useAgentSession({ client: runtime.client, sessionId: "session-1", executable: true, livePollIntervalMs: 20, idlePollIntervalMs: 20 })
      return useAgentActivity({
        session: session.session,
        events: session.events,
        approvals: session.approvals,
        agentName: "Claude Code",
        workspaceName: "Research",
        now: Date.now(),
      })
    })

    await waitFor(() => expect(result.current.map((item) => item.title)).toEqual(["Claude Code connected", "Working…"]))

    runtime.pushEvents([
      scriptedEvent({ id: "r1", kind: "context_read", summary: "x", context: { workspaceId: "w1", operation: "search_tabs", ok: true, matches: 14 } }),
    ])
    await waitFor(() => expect(result.current.map((item) => item.title)).toContain("Found 14 relevant tabs"))

    runtime.setApprovals([scriptedApproval({ approvalId: "a1", sessionId: "session-1", action: "create_files", targets: ["research-summary.md"] })])
    runtime.setSessions([scriptedSession({ status: "waiting_for_approval", workspaceId: "w1", awaitingApproval: true })])
    runtime.pushEvents([scriptedEvent({ id: "q1", kind: "approval_requested", approvalId: "a1", summary: "Write" })])
    await waitFor(() =>
      expect(result.current.at(-1)).toMatchObject({ status: "waiting", title: "Waiting for approval", description: "Create research-summary.md" })
    )

    // Answered: the broker stops listing it, the journal says so, and the request keeps its words.
    runtime.setApprovals([])
    runtime.setSessions([scriptedSession({ status: "ready", workspaceId: "w1" })])
    runtime.pushEvents([
      scriptedEvent({ id: "g1", kind: "approval_granted", approvalId: "a1", summary: "Approved" }),
      scriptedEvent({ id: "f1", kind: "file_created", summary: "x", file: { relativePath: "research-summary.md", projectId: "p1" } }),
    ])
    await waitFor(() =>
      expect(result.current.map((item) => item.title).slice(-3)).toEqual(["Asked for approval", "Action approved", "Created research-summary.md"])
    )
    expect(result.current.at(-2)!.description).toBe("Create research-summary.md")
    await act(async () => {})
  })
})
