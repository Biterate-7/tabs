import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import {
  createScriptedRuntime,
  scriptedApproval,
  scriptedEvent,
  scriptedSession,
} from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { AgentContextWorld } from "@/lib/agents/context/world"

/**
 * The activity timeline inside the Command Centre: where it appears, that it
 * is built from the session the runtime reports, and that it sits beside the
 * conversation rather than repeating itself into it.
 */

function world(): AgentContextWorld {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [
      {
        id: "w1",
        name: "Research",
        createdAt: 0,
        updatedAt: 0,
        tabs: [{ id: "t1", url: "https://example.com/1", normalizedUrl: "https://example.com/1", domain: "example.com", title: "Tab" }],
      },
    ],
    collections: [],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

function renderCentre(runtime: ScriptedRuntime) {
  return render(<CommandCentreView world={world()} onClose={vi.fn()} client={runtime.client} poll={false} />)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  window.localStorage.clear()
  seedConnectedAgent()
})

function researchSession(over: Parameters<typeof scriptedSession>[0] = {}) {
  return scriptedSession({ workspaceId: "w1", title: "Summarize research", ...over })
}

describe("the timeline in the Command Centre", () => {
  it("appears in the context panel, built from the session's real events", async () => {
    const runtime = createScriptedRuntime({ sessions: [researchSession()] })
    runtime.pushEvents([
      scriptedEvent({ id: "s", kind: "session_started", summary: "Session started." }),
      scriptedEvent({ id: "l", kind: "context_loaded", summary: "1 tab · 0 collections", context: { workspaceId: "w1", tabs: 1, collections: 0 } }),
      scriptedEvent({ id: "r", kind: "context_read", summary: "14 matching tabs", context: { workspaceId: "w1", operation: "search_tabs", ok: true, matches: 14 } }),
    ])
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /summarize research/i }))

    const panel = await screen.findByRole("complementary", { name: "Session context" })
    const activity = within(panel).getByRole("region", { name: "Activity" })
    const list = await within(activity).findByRole("list", { name: "Claude Code activity, newest first" })
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem").map((row) => row.querySelector("[data-activity-title]")?.textContent)).toEqual([
        "Found 14 relevant tabs",
        "Workspace context loaded",
        "Claude Code connected",
      ])
    )
    expect(within(activity).getByText("Working in Research")).toBeTruthy()
  })

  it("keeps per-call reads out of the conversation, where they would bury it", async () => {
    const runtime = createScriptedRuntime({ sessions: [researchSession()] })
    runtime.pushEvents([
      scriptedEvent({ id: "m", kind: "message_sent", summary: "Find pricing tabs", text: "Find pricing tabs" }),
      scriptedEvent({ id: "r", kind: "context_read", summary: "14 matching tabs", context: { workspaceId: "w1", operation: "search_tabs", ok: true, matches: 14 } }),
    ])
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /summarize research/i }))

    const stream = await screen.findByRole("list", { name: /session events/i })
    await within(stream).findByText("Find pricing tabs")
    expect(within(stream).queryByText(/14 matching tabs/)).toBeNull()
  })

  it("marks an approval as waiting while the approval card stays the one place to answer it", async () => {
    const runtime = createScriptedRuntime({ sessions: [researchSession({ status: "waiting_for_approval", awaitingApproval: true })] })
    runtime.setApprovals([scriptedApproval({ approvalId: "a1", action: "create_files", targets: ["research-summary.md"] })])
    runtime.pushEvents([scriptedEvent({ id: "q", kind: "approval_requested", approvalId: "a1", summary: "Write research-summary.md" })])
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /summarize research/i }))

    const activity = within(await screen.findByRole("complementary", { name: "Session context" })).getByRole("region", { name: "Activity" })
    const list = await within(activity).findByRole("list", { name: "Claude Code activity, newest first" })
    const waiting = await within(list).findByText("Waiting for approval")
    expect(waiting.closest("li")?.getAttribute("data-activity-status")).toBe("waiting")
    expect(within(activity).getByText("Create research-summary.md")).toBeTruthy()
    expect(within(activity).queryByRole("button", { name: /approve|deny|allow/i })).toBeNull()

    // The header's entry point says an approval waits, in words.
    expect(screen.getByRole("button", { name: "Activity — needs your approval" })).toBeTruthy()
  })

  it("opens from the header when the context panel is closed", async () => {
    const runtime = createScriptedRuntime({ sessions: [researchSession()] })
    runtime.pushEvents([scriptedEvent({ id: "s", kind: "session_started", summary: "Session started." })])
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /summarize research/i }))

    await user.click(screen.getByRole("button", { name: "Hide context panel" }))
    expect(screen.queryByRole("complementary", { name: "Session context" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Activity" }))
    expect(await screen.findByRole("list", { name: "Claude Code activity, newest first" })).toBeTruthy()
    expect(screen.getByText("Claude Code connected")).toBeTruthy()
  })
})
