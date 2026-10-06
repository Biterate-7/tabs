import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { createScriptedRuntime, scriptedEvent, scriptedSession } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { resetWorkspaceChanges } from "@/lib/agents/command-centre/workspace-activity"
import { loadCollectionState, saveCollectionState } from "@/lib/collections/persistence"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The action inspector inside the real Command Centre, against a scripted
 * runtime that reports an approved workspace change the way the host does —
 * the action names its approval — and the real collection store applying it.
 *
 *   approved → applied → "Created collection …" → inspect → Undo → "Undid …"
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

const COLLECTIONS = [
  { id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0"], createdAt: 0, updatedAt: 0 },
  { id: "c2", workspaceId: "w2", name: "Bank", tabIds: ["w2-tab-0"], createdAt: 0, updatedAt: 0 },
]

function world() {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [workspace("w1", "Research", 3), workspace("w2", "Personal", 2)],
    collections: COLLECTIONS,
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

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

/** A session whose agent asked to create "Reading list", was approved, and whose change the runtime now lists to apply. */
function approvedCreate(): ScriptedRuntime {
  const runtime = createScriptedRuntime({
    sessions: [
      scriptedSession({
        workspaceId: "w1",
        title: "Organize reading",
        context: contextView({
          pendingActions: [
            { actionId: "ctxa-1", approvalId: "wa-1", kind: "create_collection", name: "Reading list", tabIds: ["w1-tab-1", "w1-tab-2"] },
          ],
        }),
      }),
    ],
  })
  const t = Date.now() - 10_000
  runtime.pushEvents([
    scriptedEvent({ id: "s", kind: "session_started", summary: "Session started.", timestamp: t }),
    scriptedEvent({ id: "q", kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: "wa-1", timestamp: t + 1_000 }),
    scriptedEvent({ id: "g", kind: "approval_granted", summary: "Approved", approvalId: "wa-1", timestamp: t + 2_000 }),
  ])
  return runtime
}

function renderCentre(runtime: ScriptedRuntime) {
  return render(<CommandCentreView world={world()} onClose={vi.fn()} client={runtime.client} poll={false} onViewWorkspace={vi.fn()} />)
}

async function activityPanel() {
  const panel = await screen.findByRole("complementary", { name: "Session context" })
  return within(within(panel).getByRole("region", { name: "Activity" }))
}

beforeEach(() => {
  window.localStorage.clear()
  saveCollectionState({ version: 1, collections: [...COLLECTIONS] })
  resetWorkspaceChanges()
  seedConnectedAgent()
})

describe("the action inspector in the Command Centre", () => {
  it("opens an applied change from the timeline and shows the approval that authorized it", async () => {
    const user = userEvent.setup()
    renderCentre(approvedCreate())
    await user.click(await screen.findByRole("button", { name: /organize reading/i }))

    const activity = await activityPanel()
    const row = await activity.findByRole("button", { name: /Created collection “Reading list”/ })
    await user.click(row)

    const article = await activity.findByRole("article")
    const inspector = within(article)
    expect(inspector.getByRole("heading", { name: "Created collection “Reading list”" })).toBeTruthy()
    expect(article.getAttribute("data-action-status")).toBe("completed")
    expect(within(inspector.getByRole("list", { name: "What happened" })).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      expect.stringContaining("Requested by Claude Code"),
      expect.stringContaining("Approved"),
      expect.stringContaining("Completed"),
    ])
    expect(inspector.getByText("Requested by Claude Code")).toBeTruthy()
    expect(inspector.getByText("Approved")).toBeTruthy()
    expect(inspector.getByText("Create collection")).toBeTruthy()
    expect(inspector.getByText("Created “Reading list” in Research.")).toBeTruthy()
    expect(inspector.getByText("Collection “Reading list” · 2 tabs")).toBeTruthy()
    expect(inspector.getByRole("button", { name: "Open collection" })).toBeTruthy()
    // No id, tool name or protocol verb reaches the person.
    expect(article.textContent ?? "").not.toMatch(/ctxa|wa-1|create_collection|change_workspace/)
  })

  it("undoes the change exactly, after a light confirmation, and records the undo as a new entry", async () => {
    const user = userEvent.setup()
    renderCentre(approvedCreate())
    await user.click(await screen.findByRole("button", { name: /organize reading/i }))
    const activity = await activityPanel()
    await waitFor(() => expect(loadCollectionState().collections.some((c) => c.name === "Reading list")).toBe(true))

    await user.click(await activity.findByRole("button", { name: /Created collection “Reading list”/ }))
    const article = await activity.findByRole("article")
    const inspector = within(article)
    await user.click(inspector.getByRole("button", { name: "Undo" }))

    const confirm = within(inspector.getByRole("group", { name: "Undo this change?" }))
    expect(confirm.getByText("Remove the collection “Reading list”")).toBeTruthy()
    await user.click(confirm.getByRole("button", { name: "Undo change" }))

    // The inverse, through the store: exactly the collections from before.
    await waitFor(() => expect(loadCollectionState().collections.map((c) => c.name).sort()).toEqual(["Bank", "Sources"]))
    expect(loadCollectionState().collections.find((c) => c.id === "c1")!.tabIds).toEqual(["w1-tab-0"])
    await waitFor(() => expect(article.getAttribute("data-action-status")).toBe("undone"))
    expect(inspector.queryByRole("button", { name: "Undo" })).toBeNull()

    // Back on the list: the original stays, and the undo is told after it.
    await user.click(inspector.getByRole("button", { name: "All activity" }))
    const titles = activity
      .getAllByRole("listitem")
      .map((row) => row.querySelector("[data-activity-title]")?.textContent)
      .filter(Boolean)
    expect(titles.slice(0, 2)).toEqual(["Undid creation of “Reading list”", "Created collection “Reading list”"])
    // Focus returns to the row it was opened from.
    expect(document.activeElement?.textContent).toMatch(/Created collection “Reading list”/)
  })

  it("does not offer Undo once the workspace has changed since", async () => {
    const user = userEvent.setup()
    renderCentre(approvedCreate())
    await user.click(await screen.findByRole("button", { name: /organize reading/i }))
    const activity = await activityPanel()
    await waitFor(() => expect(loadCollectionState().collections.some((c) => c.name === "Reading list")).toBe(true))

    // The stream's own Undo is the other way in; using it first leaves nothing for the inspector to undo.
    const stream = screen.getByRole("list", { name: /session events/i })
    await user.click(within(stream).getByRole("button", { name: "Undo" }))
    await user.click(await activity.findByRole("button", { name: /Created collection “Reading list”/ }))
    const article = await activity.findByRole("article")
    const inspector = within(article)
    expect(inspector.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(article.getAttribute("data-action-status")).toBe("undone")
  })
})
