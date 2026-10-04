import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { createScriptedRuntime, scriptedEvent, scriptedSession, scriptedStatus } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { resetWorkspaceChanges } from "@/lib/agents/command-centre/workspace-activity"
import { AGENT_PERMISSION_SCOPES } from "@/lib/agents/control/permissions"
import { approveAgent, EMPTY_ROSTER, saveAgentRoster } from "@/lib/agents/platform/roster"
import { saveCollectionState } from "@/lib/collections/persistence"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { RuntimeCommand, RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { Collection } from "@/lib/collections/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * "Continue with…" inside the real Command Centre (Hubble 1.4): the agent
 * selector from the connected-agent roster, the context preview the runtime
 * computed, the person's instruction, the handoff command exactly as sent,
 * the new session opened, the relationship in the session list, the handoff
 * in the inspector — and failure and cancellation said as what they are.
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

const COLLECTIONS: Collection[] = [
  { id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0"], createdAt: 0, updatedAt: 0 },
  { id: "c2", workspaceId: "w2", name: "Bank", tabIds: ["w2-tab-0"], createdAt: 0, updatedAt: 0 },
]

function world() {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [workspace("w1", "Development", 8), workspace("w2", "Personal", 2)],
    collections: COLLECTIONS,
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

const CONTEXT: RuntimeSessionContextView = {
  workspaceId: "w1",
  workspaceName: "Development",
  capabilities: ["workspace.read", "tabs.read", "collections.read", "relationships.read"],
  version: 1,
  syncedAt: 1_700_000_000_000,
  fingerprint: "held",
  pendingActions: [],
}

const PROVIDERS = scriptedStatus().providers[0]!

function runtimeWith(status: "ready" | "running" = "ready"): ScriptedRuntime {
  const runtime = createScriptedRuntime({
    status: scriptedStatus({ providers: [PROVIDERS, { ...PROVIDERS, provider: "openai-codex" }] }),
    sessions: [scriptedSession({ sessionId: "session-1", workspaceId: "w1", title: "Research the API", status, context: CONTEXT })],
  })
  const t = Date.now() - 60_000
  runtime.pushEvents([
    scriptedEvent({ id: "s", sessionId: "session-1", kind: "session_started", summary: "Session started.", timestamp: t }),
    scriptedEvent({ id: "f", sessionId: "session-1", kind: "file_created", summary: "", file: { relativePath: "docs/plan.md", projectId: "p1" }, timestamp: t + 1_000 }),
    scriptedEvent({ id: "d", sessionId: "session-1", kind: "run_completed", summary: "Finished", timestamp: t + 2_000 }),
  ])
  return runtime
}

function renderCentre(runtime: ScriptedRuntime) {
  return render(<CommandCentreView world={world()} onClose={vi.fn()} client={runtime.client} poll={false} activeWorkspaceId="w1" onViewWorkspace={vi.fn()} />)
}

async function openSource(user: ReturnType<typeof userEvent.setup>, which: (row: HTMLElement) => boolean = () => true) {
  const list = within(await screen.findByRole("navigation", { name: "Agent sessions" }))
  const rows = await list.findAllByRole("button", { name: /Research the API/ })
  await user.click(rows.find(which)!)
  const panel = await screen.findByRole("complementary", { name: "Session context" })
  return within(within(panel).getByRole("region", { name: "Activity" }))
}

const sent = (runtime: ScriptedRuntime, name: RuntimeCommand["name"]) => runtime.commands.filter((command) => command.name === name)

beforeEach(() => {
  window.localStorage.clear()
  saveCollectionState({ version: 1, collections: [...COLLECTIONS] })
  resetWorkspaceChanges()
  // Claude Code and Codex are connected; Gemini is not.
  let roster = EMPTY_ROSTER
  for (const provider of ["claude-code", "openai-codex"] as const) {
    roster = approveAgent(roster, { provider, name: provider === "claude-code" ? "Claude Code" : "Codex", scopes: AGENT_PERMISSION_SCOPES, now: 1_700_000_000_000 })
  }
  saveAgentRoster(roster)
})

describe("Continue with… in the Command Centre", () => {
  it("is offered for a session that finished its turn, and never while it is still working", async () => {
    const user = userEvent.setup()
    renderCentre(runtimeWith("running"))
    const activity = await openSource(user)
    expect(activity.queryByRole("button", { name: "Continue with…" })).toBeNull()
  })

  it("lists the roster: a connected agent continues, one that is not connected goes through Connect", async () => {
    const user = userEvent.setup()
    renderCentre(runtimeWith())
    const activity = await openSource(user)
    await user.click(await activity.findByRole("button", { name: "Continue with…" }))
    const dialog = within(await screen.findByRole("dialog"))
    expect(dialog.getByRole("button", { name: "Continue with Codex" })).toBeTruthy()
    const gemini = dialog.getByText("Gemini CLI").closest("li")!
    expect(within(gemini).getByText("Not connected")).toBeTruthy()
    await user.click(within(gemini).getByRole("button", { name: "Connect" }))
    // The existing Connect flow, for that agent — no second connection system.
    expect(await screen.findByRole("heading", { name: "Connect Gemini CLI" })).toBeTruthy()
  })

  it("previews what the runtime would pass, sends exactly what the person chose, and opens the new session", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith()
    renderCentre(runtime)
    const activity = await openSource(user)
    await user.click(await activity.findByRole("button", { name: "Continue with…" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Continue with Codex" }))

    const dialog = within(await screen.findByRole("dialog"))
    await dialog.findByRole("heading", { name: "Continue with Codex" })
    expect(dialog.getByText("Development")).toBeTruthy()
    expect(dialog.getByText("8 tabs · 1 collection")).toBeTruthy()
    expect(dialog.getByText("Created plan.md")).toBeTruthy()
    // The preview was asked of the runtime, with the source's own workspace.
    const [prepare] = sent(runtime, "prepare_handoff")
    expect(prepare).toMatchObject({ sourceSessionId: "session-1", targetProvider: "openai-codex", contextSnapshot: { workspace: { id: "w1" } } })

    await user.click(dialog.getByRole("checkbox", { name: /Previous result/ }))
    await user.type(dialog.getByLabelText("Instruction"), "Implement the plan from the previous agent.")
    await user.click(dialog.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const [start] = sent(runtime, "start_handoff")
    expect(start).toMatchObject({
      sourceSessionId: "session-1",
      targetProvider: "openai-codex",
      include: { workspace: true, previousResult: false },
      instruction: "Implement the plan from the previous agent.",
      contextSnapshot: { workspace: { id: "w1" } },
    })
    expect(start && "fingerprint" in start && start.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(runtime.handoffs[0]).toMatchObject({ status: "ready", context: { workspace: { tabs: 8, collections: 1 } } })
    expect(runtime.handoffs[0]!.context.previousResult).toBeUndefined()

    // The new session is open, and it says where its work came from.
    const panel = within(within(await screen.findByRole("complementary", { name: "Session context" })).getByRole("region", { name: "Activity" }))
    expect(await panel.findByText("Handoff received")).toBeTruthy()
    // Both sessions in the list, linked quietly.
    const list = within(screen.getByRole("navigation", { name: "Agent sessions" }))
    const relations = list
      .getAllByRole("button")
      .map((row) => row.querySelector("[data-handoff-relation]")?.textContent)
      .filter(Boolean)
    expect(relations).toEqual(expect.arrayContaining([expect.stringContaining("→ Codex"), expect.stringContaining("← Claude Code")]))
  })

  it("inspects the handoff on the source, with nothing to undo, and opens the other session", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith()
    renderCentre(runtime)
    let activity = await openSource(user)
    await user.click(await activity.findByRole("button", { name: "Continue with…" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Continue with Codex" }))
    const dialog = within(await screen.findByRole("dialog"))
    await user.type(await dialog.findByLabelText("Instruction"), "Build it.")
    await user.click(dialog.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // The source row, named by its relation: the target has the same title.
    activity = await openSource(user, (row) => (row.textContent ?? "").includes("→ Codex"))
    await user.click(await activity.findByRole("button", { name: /Handed off to Codex/ }))
    const inspector = within(await activity.findByRole("article"))
    expect(inspector.getByText("Handoff")).toBeTruthy()
    expect(inspector.getByText("Build it.")).toBeTruthy()
    expect(inspector.getByText("8 tabs · 1 collection")).toBeTruthy()
    expect(inspector.queryByRole("button", { name: /Undo/ })).toBeNull()
    expect(inspector.getByText(/A handoff doesn't change the workspace/)).toBeTruthy()
    await user.click(inspector.getByRole("button", { name: "Open Codex session" }))
    const panel = within(within(await screen.findByRole("complementary", { name: "Session context" })).getByRole("region", { name: "Activity" }))
    expect(await panel.findByText("Handoff received")).toBeTruthy()
  })

  it("says plainly when the target could not be started, keeps the source, and offers Try again", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith()
    runtime.failHandoff("session_not_created")
    renderCentre(runtime)
    const activity = await openSource(user)
    await user.click(await activity.findByRole("button", { name: "Continue with…" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Continue with Codex" }))
    const dialog = within(await screen.findByRole("dialog"))
    await user.click(await dialog.findByRole("button", { name: "Continue" }))
    const alert = within(await dialog.findByRole("alert"))
    expect(alert.getByText("Couldn't start a Codex session")).toBeTruthy()
    expect(alert.getByText(/Nothing was changed/)).toBeTruthy()
    expect(dialog.getByRole("button", { name: "Try again" })).toBeTruthy()
    // No second session appeared.
    expect(within(screen.getByRole("navigation", { name: "Agent sessions", hidden: true })).getAllByRole("button", { name: /Research the API/, hidden: true })).toHaveLength(1)
  })

  it("never claims the context arrived when it did not", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith()
    runtime.failHandoff("context_not_delivered")
    renderCentre(runtime)
    const activity = await openSource(user)
    await user.click(await activity.findByRole("button", { name: "Continue with…" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Continue with Codex" }))
    const dialog = within(await screen.findByRole("dialog"))
    await user.click(await dialog.findByRole("button", { name: "Continue" }))
    expect(within(await dialog.findByRole("alert")).getByText("Codex didn't receive the handoff")).toBeTruthy()
  })

  it("Cancel starts nothing and sends nothing", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWith()
    renderCentre(runtime)
    const activity = await openSource(user)
    await user.click(await activity.findByRole("button", { name: "Continue with…" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Continue with Codex" }))
    const dialog = within(await screen.findByRole("dialog"))
    await dialog.findByRole("heading", { name: "Continue with Codex" })
    await user.click(dialog.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(sent(runtime, "start_handoff")).toEqual([])
    expect(runtime.handoffs).toEqual([])
  })
})
