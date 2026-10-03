import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { createScriptedRuntime, scriptedSession } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { resetWorkspaceChanges } from "@/lib/agents/command-centre/workspace-activity"
import { loadCollectionState, saveCollectionState } from "@/lib/collections/persistence"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { AgentHandoff } from "@/lib/agents/command-centre/working-context"
import type { RuntimeCommand, RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Workspace ↔ agent, through the real Command Centre against a scripted
 * runtime that records context exactly as the host does (focus by id, checked
 * against the session's workspace, delivered with the next message).
 *
 *   workspace → context → agent → action → workspace
 *
 * Every assertion about an action is an assertion about the command it
 * issued, and every assertion about what the user sees is about text a person
 * reads — never an id.
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

function world() {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [workspace("w1", "Research", 3), workspace("w2", "Personal", 2)],
    collections: [
      { id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0"], createdAt: 0, updatedAt: 0 },
      { id: "c2", workspaceId: "w2", name: "Bank", tabIds: ["w2-tab-0"], createdAt: 0, updatedAt: 0 },
    ],
    dependencies: [{ id: "d1", parentTabId: "w1-tab-0", childTabId: "w1-tab-1", createdAt: 0 }],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

const FULL = ["workspace.read", "tabs.read", "collections.read", "relationships.read", "collections.write"] as const

function contextView(over: Partial<RuntimeSessionContextView> = {}): RuntimeSessionContextView {
  return {
    workspaceId: "w1",
    workspaceName: "Research",
    capabilities: FULL,
    version: 1,
    syncedAt: 1_700_000_000_000,
    fingerprint: "held-by-runtime",
    pendingActions: [],
    ...over,
  }
}

function researchSession(over: Parameters<typeof scriptedSession>[0] = {}) {
  return scriptedSession({ workspaceId: "w1", context: contextView(), ...over })
}

function renderCentre(runtime: ScriptedRuntime, props: Partial<ComponentProps<typeof CommandCentreView>> = {}) {
  return render(<CommandCentreView world={world()} onClose={vi.fn()} client={runtime.client} poll={false} {...props} />)
}

function commandsNamed<N extends RuntimeCommand["name"]>(runtime: ScriptedRuntime, name: N) {
  return runtime.commands.filter((command): command is Extract<RuntimeCommand, { name: N }> => command.name === name)
}

/** The header's context chip — the composer carries a second one. */
async function headerChip(name: string | RegExp) {
  return (await screen.findAllByRole("button", { name }))[0]!
}

/** The popover a chip or indicator opened. The side panel says the same things; this is the popover's copy. */
async function popover() {
  return within(await screen.findByRole("dialog"))
}

beforeEach(() => {
  window.localStorage.clear()
  // As in the app: the shell's world and the collection store read the same stored collections.
  saveCollectionState({ version: 1, collections: [...world().collections] })
  resetWorkspaceChanges()
  seedConnectedAgent()
})

/* ------------------------------------------------------------------ *
 * Which workspace, and what context
 * ------------------------------------------------------------------ */

describe("a session works in one workspace, and says so", () => {
  it("names the workspace in the header and on its row, and starts from the whole workspace", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [researchSession({ title: "Physics reading" })] })
    renderCentre(runtime)

    const row = await screen.findByRole("button", { name: /Physics reading/ })
    expect(row.textContent).toContain("Research")
    await user.click(row)

    expect(await screen.findByRole("button", { name: /^Working in Research/ })).toBeTruthy()
    expect(await headerChip("Context: Whole workspace")).toBeTruthy()
    expect(screen.getByLabelText("Message the agent").getAttribute("placeholder")).toBe("Ask Claude Code about Research…")
    // The whole workspace is read on request — nothing is attached for it.
    expect(commandsNamed(runtime, "attach_context")).toHaveLength(0)
  })

  it("says so when the session's workspace has been deleted, and offers no context", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ workspaceId: "w-gone" })] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    await user.click(await screen.findByRole("button", { name: "Working in a deleted workspace" }))
    expect((await popover()).getByText(/no longer exists/)).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "No Hubble context for this session" }).length).toBeGreaterThan(0)
  })

  it("tells a session with no live access apart from one whose agent cannot be given it", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ workspaceId: "w1" })] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await user.click(await screen.findByRole("button", { name: "Working in Research" }))
    const opened = await popover()
    expect(opened.getByText(/no live access to the workspace here/)).toBeTruthy()
    expect(opened.getByText("Can't change your workspace")).toBeTruthy()
  })
})

describe("choosing context inside the session's workspace", () => {
  it("offers only that workspace, attaches the choice by the bridge, and shows it by name", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [researchSession()] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    await user.click(await headerChip("Context: Whole workspace"))
    await user.click((await popover()).getByRole("button", { name: "Choose tabs and collections…" }))
    const dialog = await screen.findByRole("dialog", { name: "Choose context" })
    expect(within(dialog).getByText(/From Research/)).toBeTruthy()
    // Another workspace's collection and tabs are simply not offered.
    expect(within(dialog).queryByText("Bank")).toBeNull()
    expect(within(dialog).queryByText(/Personal/)).toBeNull()

    await user.click(within(dialog).getByRole("checkbox", { name: /Sources/ }))
    await user.click(within(dialog).getByRole("checkbox", { name: /Research 1/ }))
    expect(within(dialog).getByText("Sources collection · 1 tab")).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: "Use these" }))

    await waitFor(() => expect(commandsNamed(runtime, "attach_context")).toHaveLength(1))
    const attached = commandsNamed(runtime, "attach_context")[0]!
    expect(attached.sessionId).toBe("session-1")
    const references = attached.context.attachments.map((attachment) => `${attachment.kind}:${attachment.id}`)
    expect(references).toEqual(expect.arrayContaining(["collection:c1", "tab:w1-tab-1"]))
    expect(references.some((reference) => reference.includes("w2"))).toBe(false)

    // What the runtime now reports, named from live Hubble state.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose context" })).toBeNull())
    const chip = await headerChip("Context: Sources collection · 1 tab, sent with your next message")
    await user.click(chip)
    const opened = await popover()
    expect(opened.getByRole("region", { name: "Collections in context" }).textContent).toContain("Sources")
    expect(opened.getByRole("region", { name: "Tabs in context" }).textContent).toContain("Research 1")
    expect(opened.getByText("Sent with your next message")).toBeTruthy()
  })

  it("removes one item, and returns to the whole workspace by detaching", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [researchSession({ focus: { tabIds: ["w1-tab-0", "w1-tab-2"], collectionIds: [], delivered: true } })],
    })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    await user.click(await headerChip("Context: 2 tabs"))
    const opened = await popover()
    expect(opened.getByRole("region", { name: "Tabs in context" }).textContent).toContain("Research 2")
    expect(opened.getByText("Claude Code has this")).toBeTruthy()
    await user.click(opened.getByRole("button", { name: "Remove Research 2 from context" }))

    await waitFor(() => expect(commandsNamed(runtime, "attach_context")).toHaveLength(1))
    expect(commandsNamed(runtime, "attach_context")[0]!.context.attachments.filter((a) => a.kind === "tab").map((a) => a.id)).toEqual([
      "w1-tab-0",
    ])

    await user.keyboard("{Escape}")
    await user.click(await headerChip(/^Context: Research 0/))
    await user.click((await popover()).getByRole("button", { name: "Use whole workspace" }))
    await waitFor(() => expect(commandsNamed(runtime, "detach_context")).toHaveLength(1))
    expect(await headerChip("Context: Whole workspace")).toBeTruthy()
  })

  it("says so when the runtime refuses context, and changes nothing", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [researchSession()] })
    runtime.failCommand("attach_context", "context_invalid")
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await user.click(await headerChip("Context: Whole workspace"))
    await user.click((await popover()).getByRole("button", { name: "Choose tabs and collections…" }))
    const dialog = await screen.findByRole("dialog", { name: "Choose context" })
    await user.click(within(dialog).getByRole("checkbox", { name: /Research 0/ }))
    await user.click(within(dialog).getByRole("button", { name: "Use these" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/isn.t in this session.s workspace/)
    expect(await headerChip("Context: Whole workspace")).toBeTruthy()
  })
})

describe("context never crosses sessions", () => {
  it("keeps one session's context out of another session's messages", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [
        researchSession({ sessionId: "s-a", title: "Alpha", focus: { tabIds: ["w1-tab-0"], collectionIds: [], delivered: false } }),
        scriptedSession({
          sessionId: "s-b",
          title: "Beta",
          workspaceId: "w2",
          context: contextView({ workspaceId: "w2", workspaceName: "Personal" }),
        }),
      ],
    })
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /Alpha/ }))
    expect(await headerChip(/^Context: Research 0/)).toBeTruthy()

    await user.click(screen.getByRole("button", { name: /Beta/ }))
    expect(await screen.findByRole("button", { name: /^Working in Personal/ })).toBeTruthy()
    expect(await headerChip("Context: Whole workspace")).toBeTruthy()

    await user.type(screen.getByLabelText("Message the agent"), "What's here?{Enter}")
    await waitFor(() => expect(commandsNamed(runtime, "send_message")).toHaveLength(1))
    const sent = commandsNamed(runtime, "send_message")[0]!
    expect(sent.sessionId).toBe("s-b")
    expect(sent).not.toHaveProperty("context")
    expect(commandsNamed(runtime, "attach_context")).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * From the workspace into the Command Centre
 * ------------------------------------------------------------------ */

describe("requests from the workspace", () => {
  const selection: AgentHandoff = {
    id: "h-1",
    context: { workspaceId: "w1", tabIds: ["w1-tab-0", "w1-tab-2"], collectionIds: [] },
    mode: "ask",
    intent: "summarize",
  }

  it("go to the live session working in that workspace, with its words ready to send", async () => {
    const consumed = vi.fn()
    const runtime = createScriptedRuntime({ sessions: [researchSession()] })
    renderCentre(runtime, { handoff: selection, onHandoffConsumed: consumed, activeWorkspaceId: "w1" })

    await waitFor(() => expect(commandsNamed(runtime, "attach_context")).toHaveLength(1))
    const attached = commandsNamed(runtime, "attach_context")[0]!
    expect(attached.context.attachments.filter((a) => a.kind === "tab").map((a) => a.id).sort()).toEqual(["w1-tab-0", "w1-tab-2"])
    expect(consumed).toHaveBeenCalledWith("h-1")

    expect(await screen.findByRole("button", { name: /^Working in Research/ })).toBeTruthy()
    expect(await headerChip("Context: 2 tabs, sent with your next message")).toBeTruthy()
    // A suggestion to edit or send — never sent on the user's behalf.
    await waitFor(() => expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).value).toBe("Summarize these tabs."))
    expect(commandsNamed(runtime, "send_message")).toHaveLength(0)
  })

  it("never go to a session working in another workspace — they become the next session's context", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ workspaceId: "w2", context: contextView({ workspaceId: "w2", workspaceName: "Personal" }) })],
    })
    renderCentre(runtime, { handoff: selection, activeWorkspaceId: "w1" })

    expect(await screen.findByRole("heading", { name: "Work with your Research workspace" })).toBeTruthy()
    expect(await screen.findByRole("button", { name: "Context: 2 tabs" })).toBeTruthy()
    expect(commandsNamed(runtime, "attach_context")).toHaveLength(0)

    await user.click(within(screen.getByRole("region", { name: "Agents for this workspace" })).getByRole("button", { name: "Start" }))
    const dialog = await screen.findByRole("dialog", { name: "New agent session" })
    expect(within(dialog).getByText("2 tabs")).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: /start session/i }))

    await waitFor(() => expect(commandsNamed(runtime, "create_session")).toHaveLength(1))
    const created = commandsNamed(runtime, "create_session")[0]!
    expect(created.workspaceId).toBe("w1")
    expect(created.context?.attachments.filter((a) => a.kind === "tab").map((a) => a.id).sort()).toEqual(["w1-tab-0", "w1-tab-2"])
    expect(await screen.findByRole("button", { name: /^Working in Research/ })).toBeTruthy()
  })

  it("add to what the session already has when asked to add", async () => {
    const runtime = createScriptedRuntime({
      sessions: [researchSession({ focus: { tabIds: ["w1-tab-0"], collectionIds: [], delivered: true } })],
    })
    renderCentre(runtime, {
      handoff: { id: "h-add", context: { workspaceId: "w1", tabIds: [], collectionIds: ["c1"] }, mode: "add", intent: "ask" },
    })
    await waitFor(() => expect(commandsNamed(runtime, "attach_context")).toHaveLength(1))
    const references = commandsNamed(runtime, "attach_context")[0]!.context.attachments.map((a) => `${a.kind}:${a.id}`)
    expect(references).toEqual(expect.arrayContaining(["tab:w1-tab-0", "collection:c1"]))
  })

  it("let the user start typing at once: the first message waits for the new session, then goes", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime, { activeWorkspaceId: "w1" })

    await user.type(await screen.findByLabelText("Ask an agent"), "Compare these sources{Enter}")
    const dialog = await screen.findByRole("dialog", { name: "New agent session" })
    expect(within(dialog).getByText("Compare these sources")).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: /start session/i }))

    await waitFor(() => expect(commandsNamed(runtime, "send_message")).toHaveLength(1))
    expect(commandsNamed(runtime, "send_message")[0]).toMatchObject({ sessionId: "session-1", text: "Compare these sources" })
    expect(commandsNamed(runtime, "create_session")[0]!.workspaceId).toBe("w1")
  })
})

/* ------------------------------------------------------------------ *
 * From the agent back into the workspace
 * ------------------------------------------------------------------ */

describe("what the agent changed", () => {
  function pendingCreate(tabIds: string[]) {
    return researchSession({
      context: contextView({
        pendingActions: [{ actionId: "ctxa-1", kind: "create_collection", name: "Reading list", tabIds }],
      }),
    })
  }

  it("is said in the session, in words, with View going to the collection it made", async () => {
    const user = userEvent.setup()
    const onViewWorkspace = vi.fn()
    const runtime = createScriptedRuntime({ sessions: [pendingCreate(["w1-tab-1", "w1-tab-2"])] })
    renderCentre(runtime, { onViewWorkspace })
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    const row = (await screen.findByText("Updated Research")).closest("li")!
    expect(row.textContent).toContain("Created collection “Reading list” · 2 tabs")
    expect(row.textContent).not.toMatch(/ctxa|create_collection|mcp/i)

    await user.click(within(row).getByRole("button", { name: "View" }))
    const made = loadCollectionState().collections.find((collection) => collection.name === "Reading list")!
    expect(onViewWorkspace).toHaveBeenCalledWith("w1", made.id)
    // The panel's record of what changed says the same.
    expect(within(screen.getByRole("region", { name: "Changes" })).getByText(/Reading list/)).toBeTruthy()
  })

  it("is undone exactly — the tab goes back to where it was — and only while nothing changed since", async () => {
    saveCollectionState({
      version: 1,
      collections: [{ id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0", "w1-tab-1"], createdAt: 0, updatedAt: 0 }],
    })
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [pendingCreate(["w1-tab-1"])] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    const row = (await screen.findByText("Updated Research")).closest("li")!
    // Creating it took w1-tab-1 out of Sources.
    await waitFor(() => expect(loadCollectionState().collections.find((c) => c.id === "c1")?.tabIds).toEqual(["w1-tab-0"]))

    await user.click(within(row).getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(within(row).getByText("Undone")).toBeTruthy())
    const restored = loadCollectionState().collections
    expect(restored.map((c) => c.name)).toEqual(["Sources"])
    expect(restored[0]!.tabIds).toEqual(["w1-tab-0", "w1-tab-1"])
    expect(within(row).queryByRole("button", { name: "Undo" })).toBeNull()
  })

  it("is said plainly when it could not be applied", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [pendingCreate(["w2-tab-0"])] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    // The stream's row; the activity timeline beside it says the same thing in its own place.
    const stream = await screen.findByRole("list", { name: /session events/i })
    const row = (await within(stream).findByText("Couldn't apply the approved change")).closest("li")!
    expect(row.textContent).toContain("Nothing changed in Research")
    expect(JSON.stringify(loadCollectionState())).not.toContain("Reading list")
    await waitFor(() =>
      expect(commandsNamed(runtime, "complete_context_action")[0]).toMatchObject({ actionId: "ctxa-1", outcome: { ok: false } })
    )
  })
})
