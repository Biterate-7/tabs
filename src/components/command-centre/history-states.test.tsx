import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentHistoryList } from "./agent-history-list"
import { HistorySessionView } from "./history-session-view"
import { formatClockTime } from "@/lib/time-format"
import type { AgentHistoryListState } from "@/hooks/use-agent-history"
import type { AgentHistorySession } from "@/lib/agents/activity/history"

/*
 * Agent history's states, each said once and never confused with another
 * (UX consistency pass): loading is not empty, empty is not unavailable, and
 * a runtime that is merely unreachable is not a Hubble that keeps no history.
 * A session opened before its record arrives shows no invented status or date.
 */

const NOW = new Date(2026, 9, 4, 12, 0).getTime()
const HOUR = 3_600_000

const SESSION: AgentHistorySession = {
  sessionId: "past-1",
  workspaceId: "w1",
  provider: "openai-codex",
  status: "completed",
  title: "Organise pricing",
  startedAt: NOW - 3 * HOUR,
  lastActivityAt: NOW - 2 * HOUR,
  endedAt: NOW - 2 * HOUR,
}

function list(state: AgentHistoryListState) {
  return render(<AgentHistoryList state={state} selectedSessionId={null} onSelect={vi.fn()} workspaceName="Research" now={NOW} onRetry={vi.fn()} />)
}

describe("the agent history list", () => {
  it("says it is loading — never 'No agent activity yet.' for a frame before the answer", () => {
    list({ kind: "loading" })
    expect(screen.getByText("Loading agent history…")).toBeTruthy()
    expect(screen.queryByText("No agent activity yet.")).toBeNull()
  })

  it("renders nothing at all before the runtime has answered the handshake", () => {
    const { container } = list({ kind: "idle" })
    expect(container.textContent).toBe("")
  })

  it("keeps empty, unavailable and unreachable apart", () => {
    const { rerender } = list({ kind: "ready", workspaceId: "w1", sessions: [], hasMore: false, loadingMore: false })
    expect(screen.getByText("No agent activity yet.")).toBeTruthy()

    rerender(<AgentHistoryList state={{ kind: "unavailable" }} selectedSessionId={null} onSelect={vi.fn()} now={NOW} />)
    expect(screen.getByText("Agent history unavailable")).toBeTruthy()
    expect(screen.getByText(/doesn't keep past agent sessions/)).toBeTruthy()

    rerender(<AgentHistoryList state={{ kind: "disconnected" }} selectedSessionId={null} onSelect={vi.fn()} now={NOW} />)
    expect(screen.getByText("Agent history unavailable")).toBeTruthy()
    expect(screen.getByText(/can't reach the agent runtime/)).toBeTruthy()
    // A runtime that is restarting is not a Hubble that keeps no history.
    expect(screen.queryByText(/doesn't keep past agent sessions/)).toBeNull()
    expect(screen.queryByText("No agent activity yet.")).toBeNull()
  })

  it("offers Try again when the read failed", async () => {
    const onRetry = vi.fn()
    render(<AgentHistoryList state={{ kind: "failed" }} selectedSessionId={null} onSelect={vi.fn()} now={NOW} onRetry={onRetry} />)
    expect(screen.getByText("Couldn't load agent history")).toBeTruthy()
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("lists a persisted session by its agent's canonical name, under its day, at its time", () => {
    list({ kind: "ready", workspaceId: "w1", sessions: [SESSION, { ...SESSION, sessionId: "past-2", title: undefined, lastActivityAt: NOW - 27 * HOUR - 1_800_000, endedAt: NOW - 27 * HOUR - 1_800_000 }], hasMore: false, loadingMore: false })
    const region = within(screen.getByRole("region", { name: "Agent history" }))
    expect(region.getByText("Today")).toBeTruthy()
    expect(region.getByText("Yesterday")).toBeTruthy()
    expect(region.getAllByText(/Codex/).length).toBeGreaterThan(0)
    expect(region.queryByText(/openai-codex|OpenAI \/ Codex/)).toBeNull()
    expect(region.getByText(formatClockTime(NOW - 2 * HOUR))).toBeTruthy()
  })
})

describe("a past session, opened", () => {
  it("says it has ended and can't be continued, and offers no live actions", () => {
    render(
      <HistorySessionView session={SESSION} state={{ kind: "loading" }} workspaceName="Research" now={NOW} onClose={vi.fn()}>
        <p>activity</p>
      </HistorySessionView>
    )
    expect(screen.getByText("Loading this session…")).toBeTruthy()
    expect(screen.getByText(/This session has ended, so it can't be continued/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("Completed")).toBeTruthy()
    expect(screen.getByText(/Codex · Worked in Research · Today/)).toBeTruthy()
  })

  it("shows no invented status or 1970 date for a session known only by id", () => {
    const placeholder: AgentHistorySession = { sessionId: "peer", workspaceId: "w1", provider: "gemini", status: "disconnected", startedAt: 0, lastActivityAt: 0 }
    render(<HistorySessionView session={placeholder} state={{ kind: "loading" }} workspaceName="Research" now={NOW} onClose={vi.fn()} />)
    expect(screen.queryByText("Disconnected")).toBeNull()
    expect(screen.queryByText(/1970|Jan/)).toBeNull()
    expect(screen.getByRole("heading", { name: "Gemini CLI" })).toBeTruthy()
  })

  it("closes back to the list", async () => {
    const onClose = vi.fn()
    render(<HistorySessionView session={SESSION} state={{ kind: "unavailable" }} now={NOW} onClose={onClose} />)
    expect(screen.getByText("Agent history unavailable")).toBeTruthy()
    await userEvent.setup().click(screen.getByRole("button", { name: "Close past session" }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
