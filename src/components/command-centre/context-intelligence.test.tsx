import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { createScriptedRuntime, scriptedEvent, scriptedSession } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { resetWorkspaceChanges } from "@/lib/agents/command-centre/workspace-activity"
import { saveCollectionState } from "@/lib/collections/persistence"
import { isContextPackId } from "@/lib/agents/context-pack/pack"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { RuntimeCommand, RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Context Intelligence (Hubble 1.5) through the real Command Centre, against
 * the scripted runtime that records context as the host does:
 *
 *   workspace brief → selected context → Context Pack → agent → action
 *
 * What the person reads is asserted as text; what the agent is sent, as the
 * command the Command Centre issued.
 */

const BRIEF = { description: "Research and organize sources for the climate policy project.", focus: "Comparing carbon-pricing approaches.", updatedAt: 1 }

function workspace(id: string, name: string, tabCount: number, over: Partial<Workspace> = {}): Workspace {
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
    ...over,
  }
}

function world(brief = true) {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [workspace("w1", "Research", 3, brief ? { brief: BRIEF } : {}), workspace("w2", "Personal", 1)],
    collections: [{ id: "c1", workspaceId: "w1", name: "Pricing Research", tabIds: ["w1-tab-0", "w1-tab-1"], createdAt: 0, updatedAt: 0 }],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

const CONTEXT: RuntimeSessionContextView = {
  workspaceId: "w1",
  workspaceName: "Research",
  capabilities: ["workspace.read", "tabs.read", "collections.read", "relationships.read", "collections.write"],
  version: 1,
  syncedAt: 1_700_000_000_000,
  fingerprint: "held-by-runtime",
  pendingActions: [],
}

function renderCentre(runtime: ScriptedRuntime, props: Partial<ComponentProps<typeof CommandCentreView>> = {}, brief = true) {
  return render(<CommandCentreView world={world(brief)} onClose={vi.fn()} client={runtime.client} poll={false} activeWorkspaceId="w1" {...props} />)
}

const commandsNamed = <N extends RuntimeCommand["name"]>(runtime: ScriptedRuntime, name: N) =>
  runtime.commands.filter((command): command is Extract<RuntimeCommand, { name: N }> => command.name === name)

const panel = async () => within(await screen.findByRole("complementary", { name: "Session context" }))

beforeEach(() => {
  window.localStorage.clear()
  saveCollectionState({ version: 1, collections: [...world().collections] })
  resetWorkspaceChanges()
  seedConnectedAgent()
})

describe("the workspace brief", () => {
  it("is shown where the agent works, and edited in place — saved through the app's store", async () => {
    const user = userEvent.setup()
    const onUpdateWorkspaceBrief = vi.fn()
    renderCentre(createScriptedRuntime({ sessions: [scriptedSession({ workspaceId: "w1", context: CONTEXT })] }), { onUpdateWorkspaceBrief })
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    const side = await panel()
    expect(side.getByText(BRIEF.description)).toBeTruthy()
    expect(side.getByText(BRIEF.focus)).toBeTruthy()
    expect(side.getByText("3 tabs · 1 collection")).toBeTruthy()

    const edit = side.getByRole("button", { name: "Edit brief for Research" })
    await user.click(edit)
    const form = within(side.getByRole("form", { name: "Brief for Research" }))
    const focus = form.getByLabelText("Current focus")
    await user.clear(focus)
    await user.type(focus, "Choosing a carbon tax design")
    await user.click(form.getByRole("button", { name: "Save" }))
    expect(onUpdateWorkspaceBrief).toHaveBeenCalledWith("w1", { description: BRIEF.description, focus: "Choosing a carbon tax design" })
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit brief for Research"))
  })

  it("Escape leaves the brief as it was, and says how to write one when there is none", async () => {
    const user = userEvent.setup()
    const onUpdateWorkspaceBrief = vi.fn()
    renderCentre(createScriptedRuntime({ sessions: [scriptedSession({ workspaceId: "w1", context: CONTEXT })] }), { onUpdateWorkspaceBrief }, false)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    const side = await panel()
    expect(side.getByText("Say what this workspace is for, so agents working here know.")).toBeTruthy()
    await user.click(side.getByRole("button", { name: "Add a brief for Research" }))
    await user.type(side.getByLabelText("What it's for"), "Anything")
    await user.keyboard("{Escape}")
    expect(onUpdateWorkspaceBrief).not.toHaveBeenCalled()
    expect(side.queryByRole("form")).toBeNull()
  })
})

describe("the Context Pack reaches the agent through the existing path", () => {
  it("starts a new session with its pack: the brief goes with it, under the pack's id", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime)
    await user.click(within(await screen.findByRole("region", { name: "Agents for this workspace" })).getByRole("button", { name: /^Start with / }))
    const dialog = await screen.findByRole("dialog", { name: "New agent session" })
    await user.click(within(dialog).getByRole("button", { name: /start session/i }))

    await waitFor(() => expect(commandsNamed(runtime, "create_session")).toHaveLength(1))
    const created = commandsNamed(runtime, "create_session")[0]!
    expect(isContextPackId(created.context?.snapshotId)).toBe(true)
    expect(created.context?.attachments).toEqual([
      expect.objectContaining({ kind: "workspace", id: "w1", label: "Research", detail: expect.stringContaining("Purpose: Research and organize sources") }),
    ])
  })

  it("starts exactly as before when there is nothing to attach — no brief, the whole workspace", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime, {}, false)
    await user.click(within(await screen.findByRole("region", { name: "Agents for this workspace" })).getByRole("button", { name: /^Start with / }))
    await user.click(within(await screen.findByRole("dialog", { name: "New agent session" })).getByRole("button", { name: /start session/i }))
    await waitFor(() => expect(commandsNamed(runtime, "create_session")).toHaveLength(1))
    expect(commandsNamed(runtime, "create_session")[0]!.context).toBeUndefined()
  })

  it("says when the agent has an older pack, and sends the current one only when asked", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ workspaceId: "w1", context: CONTEXT, contextSnapshotId: "pack-0000000000000000", contextDelivered: true })],
    })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    const side = await panel()
    const receives = within(side.getByRole("region", { name: "What the agent receives" }))
    expect(receives.getByText("Changed since Claude Code received it")).toBeTruthy()
    expect(commandsNamed(runtime, "attach_context")).toHaveLength(0)

    await user.click(receives.getByRole("button", { name: "Send update" }))
    await waitFor(() => expect(commandsNamed(runtime, "attach_context")).toHaveLength(1))
    expect(isContextPackId(commandsNamed(runtime, "attach_context")[0]!.context.snapshotId)).toBe(true)
    expect(await receives.findByText("Sent with your next message")).toBeTruthy()

    // The update rides with the next message, which records what it delivered.
    await user.type(screen.getByLabelText("Message the agent"), "Compare the pricing models.{Enter}")
    await waitFor(() => expect(runtime.sentMessages).toHaveLength(1))
    expect(runtime.sentMessages[0]!.delivery).toMatchObject({ workspace: true, workspaceId: "w1" })
    expect(await receives.findByText("Claude Code has this")).toBeTruthy()
  })

  it("shows the person's latest words as the instruction, and what else the agent has", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ workspaceId: "w1", context: CONTEXT })] })
    runtime.pushEvents([scriptedEvent({ id: "m1", sessionId: "session-1", kind: "message_sent", summary: "Message sent.", text: "Compare the pricing models." })])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    const receives = within((await panel()).getByRole("region", { name: "What the agent receives" }))
    expect(await receives.findByText("“Compare the pricing models.”")).toBeTruthy()
    expect(receives.getByText("Previous result")).toBeTruthy()
    expect(receives.queryByText(/undefined|null/)).toBeNull()
  })
})

describe("context provenance", () => {
  it("an action says what the agent had been given, by name", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ workspaceId: "w1", context: CONTEXT })] })
    runtime.pushEvents([
      scriptedEvent({
        id: "m1",
        sessionId: "session-1",
        kind: "message_sent",
        summary: "Message sent.",
        delivery: { contextId: "pack-0123456789abcdef", workspaceId: "w1", tabs: 0, collections: 1, relationships: 0, workspace: true, collectionIds: ["c1"] },
      }),
      scriptedEvent({ id: "a1", sessionId: "session-1", kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: "ap-1" }),
    ])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    const activity = within((await panel()).getByRole("region", { name: "Activity" }))
    const rows = await activity.findAllByRole("button", { name: /approval|Wants to change/i })
    await user.click(rows[0]!)
    const used = await screen.findByRole("list", { name: "Context used" })
    expect(within(used).getByText("Research workspace · Workspace brief")).toBeTruthy()
    expect(within(used).getByText("Pricing Research collection")).toBeTruthy()
  })
})
