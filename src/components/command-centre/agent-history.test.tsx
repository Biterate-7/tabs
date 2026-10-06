import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { createMemoryAgentHistoryStore } from "@/lib/agents/activity/history-store"
import { eventRecordKey } from "@/lib/agents/activity/history"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { FIXTURE_HISTORY_OWNER, createScriptedRuntime, scriptedEvent, scriptedSession } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { resetWorkspaceChanges } from "@/lib/agents/command-centre/workspace-activity"
import { loadCollectionState, saveCollectionState } from "@/lib/collections/persistence"
import type { AgentHistoryRecordInput, AgentHistoryStore } from "@/lib/agents/activity/history-store"
import type { Collection } from "@/lib/collections/types"
import type { RuntimeApprovalView, RuntimeSessionContextView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Agent history inside the real Command Centre: the list for the workspace on
 * screen, a past session opened into the same AgentActivity the live session
 * uses, its action in the same inspector, and the same undo rule — against a
 * scripted runtime that answers history from a real (in-memory) history store.
 */

function workspace(id: string, name: string, tabCount: number): Workspace {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    tabs: Array.from({ length: tabCount }, (_, index) => ({
      id: `${id}-tab-${index}`,
      url: `https://example.com/${id}/${index}`,
      normalizedUrl: `https://example.com/${id}/${index}`,
      domain: "example.com",
      title: `${name} ${index}`,
    })),
  }
}

const SOURCES: Collection = { id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0"], createdAt: 0, updatedAt: 0 }
const BANK: Collection = { id: "c2", workspaceId: "w2", name: "Bank", tabIds: ["w2-tab-0"], createdAt: 0, updatedAt: 0 }
const READING: Collection = { id: "c9", workspaceId: "w1", name: "Reading list", tabIds: ["w1-tab-1", "w1-tab-2"], createdAt: 5, updatedAt: 5 }

function world() {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [workspace("w1", "Research", 3), workspace("w2", "Personal", 2)],
    collections: [SOURCES, BANK, READING],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

const T = Date.now() - 60 * 60 * 1000

function event(sessionId: string, sequence: number, over: Partial<SequencedControlEvent> & Pick<SequencedControlEvent, "kind">): AgentHistoryRecordInput {
  const data: SequencedControlEvent = { id: `${sessionId}-e${sequence}`, sessionId, provider: "claude-code", timestamp: T + sequence * 1_000, summary: "", sequence, ...over }
  return { sessionId, kind: "event", key: eventRecordKey(data), at: data.timestamp, data }
}

/** A finished Research session as the runtime would have recorded it, and two that must never show in Research. */
async function seededHistory(): Promise<AgentHistoryStore> {
  const store = createMemoryAgentHistoryStore()
  const approval: RuntimeApprovalView = {
    approvalId: "wa-1",
    sessionId: "past-1",
    provider: "claude-code",
    action: "change_workspace",
    scope: "write_workspace",
    workspaceId: "w1",
    targets: [],
    reason: "Group what you are reading.",
    change: { kind: "create_collection", subject: "Reading list", tabCount: 2, details: [] },
    requestedAt: T + 4_000,
    expiresAt: T + 600_000,
  }
  await store.write(FIXTURE_HISTORY_OWNER, {
    sessions: [
      { sessionId: "past-1", workspaceId: "w1", provider: "claude-code", status: "completed", title: "Organize reading", startedAt: T, lastActivityAt: T + 9_000, endedAt: T + 9_000 },
      { sessionId: "past-2", workspaceId: "w2", provider: "openai-codex", status: "completed", title: "Sort the bank tabs", startedAt: T, lastActivityAt: T + 9_000, endedAt: T + 9_000 },
    ],
    records: [
      event("past-1", 1, { kind: "session_started", summary: "Session started." }),
      event("past-1", 2, { kind: "context_loaded", context: { workspaceId: "w1", tabs: 3, collections: 1 } }),
      event("past-1", 3, { kind: "context_read", context: { workspaceId: "w1", operation: "search_tabs", ok: true, matches: 2 } }),
      event("past-1", 4, { kind: "approval_requested", summary: "Create a collection", approvalId: "wa-1" }),
      event("past-1", 5, { kind: "approval_granted", approvalId: "wa-1" }),
      event("past-1", 7, { kind: "run_completed", summary: "Finished" }),
      { sessionId: "past-1", kind: "approval", key: "wa-1", at: approval.requestedAt, data: approval },
      {
        sessionId: "past-1",
        kind: "change",
        key: "ctxa-1",
        at: T + 6_000,
        data: {
          id: "ctxa-1",
          sessionId: "past-1",
          provider: "claude-code",
          workspaceId: "w1",
          at: T + 6_000,
          ok: true,
          approvalId: "wa-1",
          steps: [{ kind: "created", collectionId: "c9", name: "Reading list", tabCount: 2 }],
          before: [SOURCES],
          after: [SOURCES, READING],
        },
      },
    ],
  })
  // Another account's session in the same workspace.
  await store.write("account:someone-else", {
    sessions: [{ sessionId: "theirs", workspaceId: "w1", provider: "gemini", status: "completed", title: "Their session", startedAt: T, lastActivityAt: T + 1, endedAt: T + 1 }],
    records: [],
  })
  return store
}

function renderCentre(runtime: ReturnType<typeof createScriptedRuntime>) {
  return render(
    <CommandCentreView world={world()} onClose={vi.fn()} client={runtime.client} poll={false} activeWorkspaceId="w1" onViewWorkspace={vi.fn()} />
  )
}

async function historySection() {
  return within(await screen.findByRole("region", { name: "Agent history" }))
}

beforeEach(() => {
  window.localStorage.clear()
  saveCollectionState({ version: 1, collections: [SOURCES, BANK, READING] })
  resetWorkspaceChanges()
  seedConnectedAgent()
})

describe("agent history in the Command Centre", () => {
  it("lists this workspace's past sessions — not another workspace's, not another account's", async () => {
    const runtime = createScriptedRuntime({ history: await seededHistory() })
    renderCentre(runtime)
    const history = await historySection()
    const row = await history.findByRole("button", { name: /Organize reading/ })
    expect(row.textContent).toContain("Completed")
    expect(row.textContent).toContain("Claude Code")
    expect(row.textContent).toContain("Research")
    expect(history.getByText("Today")).toBeTruthy()
    expect(history.queryByText(/Sort the bank tabs/)).toBeNull()
    expect(history.queryByText(/Their session/)).toBeNull()
    // Asked for the workspace on screen, and only that one.
    const asked = runtime.commands.filter((command) => command.name === "list_history")
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((command) => command.name === "list_history" && command.workspaceId === "w1")).toBe(true)
  })

  it("opens a past session into its activity, and an action into the inspector, by reference", async () => {
    const user = userEvent.setup()
    renderCentre(createScriptedRuntime({ history: await seededHistory() }))
    await user.click(await (await historySection()).findByRole("button", { name: /Organize reading/ }))

    const pane = within(await screen.findByRole("region", { name: "Past agent session" }))
    expect(pane.getByRole("heading", { name: "Organize reading" })).toBeTruthy()
    const created = await pane.findByRole("button", { name: /Created collection “Reading list”/ })
    expect(pane.getByText("Found 2 relevant tabs")).toBeTruthy()
    // No composer: a past session cannot be written to.
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull()

    await user.click(created)
    const article = await pane.findByRole("article")
    const inspector = within(article)
    expect(article.getAttribute("data-action-status")).toBe("completed")
    expect(within(inspector.getByRole("list", { name: "What happened" })).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      expect.stringContaining("Requested by Claude Code"),
      expect.stringContaining("Approved"),
      expect.stringContaining("Completed"),
    ])
    expect(inspector.getByText("Group what you are reading.")).toBeTruthy()
    expect(inspector.getByText("Created “Reading list” in Research.")).toBeTruthy()
    expect(article.textContent ?? "").not.toMatch(/ctxa|wa-1|past-1/)
  })

  it("undoes a historical change exactly when the workspace still matches, and records the undo as a new entry", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ history: await seededHistory() })
    renderCentre(runtime)
    await user.click(await (await historySection()).findByRole("button", { name: /Organize reading/ }))
    const pane = within(await screen.findByRole("region", { name: "Past agent session" }))
    await user.click(await pane.findByRole("button", { name: /Created collection “Reading list”/ }))
    const article = await pane.findByRole("article")
    const inspector = within(article)

    await user.click(inspector.getByRole("button", { name: "Undo" }))
    await user.click(within(inspector.getByRole("group", { name: "Undo this change?" })).getByRole("button", { name: "Undo change" }))

    await waitFor(() => expect(loadCollectionState().collections.map((c) => c.name).sort()).toEqual(["Bank", "Sources"]))
    await waitFor(() => expect(article.getAttribute("data-action-status")).toBe("undone"))
    expect(runtime.commands).toContainEqual(expect.objectContaining({ name: "record_workspace_undo", workspaceId: "w1", sessionId: "past-1", changeId: "ctxa-1" }))

    await user.click(inspector.getByRole("button", { name: "All activity" }))
    const titles = pane
      .getAllByRole("listitem")
      .map((row) => row.querySelector("[data-activity-title]")?.textContent)
      .filter(Boolean)
    expect(titles).toContain("Undid creation of “Reading list”")
    expect(titles).toContain("Created collection “Reading list”")
  })

  it("refuses to undo a historical change once the workspace has changed since, and says why", async () => {
    const user = userEvent.setup()
    saveCollectionState({ version: 1, collections: [SOURCES, BANK, { ...READING, name: "Reading list (mine)" }] })
    renderCentre(createScriptedRuntime({ history: await seededHistory() }))
    await user.click(await (await historySection()).findByRole("button", { name: /Organize reading/ }))
    const pane = within(await screen.findByRole("region", { name: "Past agent session" }))
    await user.click(await pane.findByRole("button", { name: /Created collection “Reading list”/ }))
    const inspector = within(await pane.findByRole("article"))
    expect(inspector.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(inspector.getByText(/the workspace has changed since/)).toBeTruthy()
    expect(loadCollectionState().collections.map((c) => c.name)).toContain("Reading list (mine)")
  })

  it("says history is unavailable when this Hubble keeps none — never an empty list", async () => {
    renderCentre(createScriptedRuntime())
    const history = await historySection()
    expect(await history.findByText("Agent history unavailable")).toBeTruthy()
    expect(history.queryByText("No agent activity yet.")).toBeNull()
  })

  it("says there is no activity yet when history is kept and empty", async () => {
    renderCentre(createScriptedRuntime({ history: createMemoryAgentHistoryStore() }))
    expect(await (await historySection()).findByText("No agent activity yet.")).toBeTruthy()
  })

  it("offers a retry when history could not be read, without touching the live surface", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ history: await seededHistory() })
    runtime.failCommand("list_history", "timeout")
    renderCentre(runtime)
    const history = await historySection()
    expect(await history.findByText("Couldn't load agent history")).toBeTruthy()
    expect(screen.getByRole("button", { name: "New agent session" })).toBeTruthy()
    runtime.clearFailure("list_history")
    await user.click(history.getByRole("button", { name: "Try again" }))
    expect(await history.findByRole("button", { name: /Organize reading/ })).toBeTruthy()
  })

  it("shows a recoverable state when a past session cannot be opened", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ history: await seededHistory() })
    renderCentre(runtime)
    const row = await (await historySection()).findByRole("button", { name: /Organize reading/ })
    runtime.failCommand("get_history", "session_not_found")
    await user.click(row)
    const pane = within(await screen.findByRole("region", { name: "Past agent session" }))
    expect(await pane.findByText(/isn.t in this workspace.s history any more/)).toBeTruthy()
    await user.click(pane.getByRole("button", { name: "Close past session" }))
    expect(screen.queryByRole("region", { name: "Past agent session" })).toBeNull()
  })

  it("does not repeat a session the runtime still holds", async () => {
    const store = await seededHistory()
    const runtime = createScriptedRuntime({ history: store, sessions: [scriptedSession({ sessionId: "past-1", workspaceId: "w1", title: "Organize reading", status: "completed" })] })
    renderCentre(runtime)
    const history = await historySection()
    expect(await history.findByText("No agent activity yet.")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /Organize reading/ })).toHaveLength(1)
  })
})

describe("history and the runtime handshake", () => {
  it("asks for history only after the runtime has answered the handshake", async () => {
    const runtime = createScriptedRuntime({ history: await seededHistory() })
    renderCentre(runtime)
    await (await historySection()).findByRole("button", { name: /Organize reading/ })
    const names = runtime.commands.map((command) => command.name)
    // A command sent before it would be refused, and that refusal would make the client forget the runtime it just met.
    expect(names.indexOf("list_history")).toBeGreaterThan(names.indexOf("get_status"))
  })

  it("recovers on its own when the page outlived a runtime restart", async () => {
    const runtime = createScriptedRuntime({ history: await seededHistory() })
    let refused = 0
    const client: typeof runtime.client = {
      ...runtime.client,
      send: (async (command: Parameters<typeof runtime.client.send>[0]) => {
        // The first read reaches a runtime that is not the one this page met.
        if (command.name === "list_history" && refused === 0) {
          refused += 1
          return { ok: false, error: { code: "runtime_disconnected", message: "" } }
        }
        return runtime.client.send(command)
      }) as typeof runtime.client.send,
    }
    render(<CommandCentreView world={world()} onClose={vi.fn()} client={client} poll={false} activeWorkspaceId="w1" onViewWorkspace={vi.fn()} />)
    const history = await historySection()
    expect(await history.findByRole("button", { name: /Organize reading/ })).toBeTruthy()
    expect(refused).toBe(1)
    expect(history.queryByText("Couldn't load agent history")).toBeNull()
  })
})

describe("live activity becomes history", () => {
  function contextView(over: Partial<RuntimeSessionContextView> = {}): RuntimeSessionContextView {
    return {
      workspaceId: "w1",
      workspaceName: "Research",
      capabilities: ["workspace.read", "tabs.read", "collections.read", "relationships.read", "collections.write"],
      version: 1,
      syncedAt: 1_700_000_000_000,
      fingerprint: "held-by-runtime",
      pendingActions: [],
      ...over,
    }
  }

  it("records the change the Command Centre applied, with its snapshot, and the undo after it", async () => {
    const user = userEvent.setup()
    saveCollectionState({ version: 1, collections: [SOURCES, BANK] })
    const store = createMemoryAgentHistoryStore()
    const runtime = createScriptedRuntime({
      history: store,
      sessions: [
        scriptedSession({
          workspaceId: "w1",
          title: "Organize reading",
          context: contextView({
            pendingActions: [{ actionId: "ctxa-live", approvalId: "wa-live", kind: "create_collection", name: "Reading list", tabIds: ["w1-tab-1", "w1-tab-2"] }],
          }),
        }),
      ],
    })
    const t = Date.now() - 10_000
    runtime.pushEvents([
      scriptedEvent({ id: "s", kind: "session_started", summary: "Session started.", timestamp: t }),
      scriptedEvent({ id: "q", kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: "wa-live", timestamp: t + 1_000 }),
      scriptedEvent({ id: "g", kind: "approval_granted", summary: "Approved", approvalId: "wa-live", timestamp: t + 2_000 }),
    ])
    render(<CommandCentreView world={world()} onClose={vi.fn()} client={runtime.client} poll={false} activeWorkspaceId="w2" onViewWorkspace={vi.fn()} />)
    await user.click(await screen.findByRole("button", { name: /organize reading/i }))
    await waitFor(() => expect(loadCollectionState().collections.some((c) => c.name === "Reading list")).toBe(true))

    await waitFor(async () => expect((await store.readSession(FIXTURE_HISTORY_OWNER, "w1", "session-1"))?.records.changes).toHaveLength(1))
    const recorded = (await store.readSession(FIXTURE_HISTORY_OWNER, "w1", "session-1"))!.records.changes[0]!
    expect(recorded).toMatchObject({ id: "ctxa-live", approvalId: "wa-live", ok: true, steps: [{ kind: "created", name: "Reading list", tabCount: 2 }] })
    expect(recorded.before?.map((c) => c.name)).toEqual(["Sources"])
    expect(recorded.after?.map((c) => c.name)).toEqual(["Sources", "Reading list"])

    // Undone live: the same fact reaches history.
    const stream = screen.getByRole("list", { name: /session events/i })
    await user.click(within(stream).getByRole("button", { name: "Undo" }))
    await waitFor(async () =>
      expect((await store.readSession(FIXTURE_HISTORY_OWNER, "w1", "session-1"))?.records.undos.map((undo) => undo.changeId)).toEqual(["ctxa-live"])
    )
    // And the change itself is unchanged.
    expect((await store.readSession(FIXTURE_HISTORY_OWNER, "w1", "session-1"))!.records.changes[0]).toEqual(recorded)
  })
})
