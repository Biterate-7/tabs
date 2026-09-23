import { beforeEach, describe, expect, it, vi } from "vitest"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import {
  createScriptedRuntime,
  scriptedApproval,
  scriptedEvent,
  scriptedSession,
  scriptedStatus,
} from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The command centre's behaviour, driven through the real component against a
 * scripted runtime.
 *
 * ## Why every test goes through the whole surface
 *
 * The failure mode this phase is most at risk of is a beautiful mockup: a UI
 * that renders well and is wired to nothing. Testing the view rather than its
 * parts is what catches that — a button that does not reach a command produces
 * no entry in `runtime.commands`, and every assertion below about an action is
 * an assertion about the command it actually issued.
 *
 * Polling is off in these tests. Each hook refreshes on mount and after every
 * user-initiated command, which is what the assertions depend on; an interval
 * would only add nondeterminism.
 */

const OWNER = "owner-1"

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
      title: `Tab ${index}`,
    })),
  }
}

function world(): AgentContextWorld {
  return buildContextWorld({
    ownerId: OWNER,
    workspaces: [workspace("w1", "Research", 3)],
    collections: [
      { id: "c1", workspaceId: "w1", name: "Sources", tabIds: ["w1-tab-0"], createdAt: 0, updatedAt: 0 },
    ],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

function renderCentre(
  runtime: ScriptedRuntime,
  onClose = vi.fn(),
  onOpenConnectors?: () => void
) {
  return {
    onClose,
    ...render(
      <CommandCentreView
        world={world()}
        onClose={onClose}
        client={runtime.client}
        poll={false}
        {...(onOpenConnectors ? { onOpenConnectors } : {})}
      />
    ),
  }
}

beforeEach(() => {
  window.localStorage.clear()
  // Phase J: sessions start only for a connected agent. See the fixture.
  seedConnectedAgent()
})

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

describe("runtime status is reported truthfully", () => {
  it("handshakes before doing anything else", async () => {
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    await waitFor(() => expect(runtime.commands[0]?.name).toBe("get_status"))
  })

  it("offers to start a session when the host says it can execute", async () => {
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    expect(await screen.findByRole("button", { name: /new agent session/i })).toBeTruthy()
  })

  it("says agents cannot run here rather than offering a button that would fail", async () => {
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        executable: false,
        environment: "hosted",
        detail: "Agents cannot run on a hosted TabDump deployment.",
      }),
    })
    renderCentre(runtime)

    expect(await screen.findByText(/Agents cannot run on a hosted TabDump deployment/i)).toBeTruthy()
    // The rail's row stays visible and inert rather than vanishing: a
    // disappearing feature reads as a bug, while a disabled one beside the
    // banner reads as the explanation it is.
    const create = screen.getByRole("button", { name: /new agent session/i })
    expect((create as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps the rest of TabDump reachable when the runtime cannot execute", async () => {
    const runtime = createScriptedRuntime({ status: scriptedStatus({ executable: false }) })
    renderCentre(runtime)

    // The honest desktop/hosted story: browsing still works, execution does not.
    expect(
      await screen.findByText(/still browse workspaces, tabs, collections/i)
    ).toBeTruthy()
  })

  it("does not list sessions on a runtime that cannot execute", async () => {
    const runtime = createScriptedRuntime({ status: scriptedStatus({ executable: false }) })
    renderCentre(runtime)

    await screen.findByText(/Unavailable/i)
    expect(runtime.commands.some((command) => command.name === "list_sessions")).toBe(false)
  })

  it("reports a disconnected runtime and offers to reconnect", async () => {
    const runtime = createScriptedRuntime()
    runtime.failCommand("get_status", "runtime_disconnected")
    renderCentre(runtime)

    expect(await screen.findByText(/Disconnected/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy()
  })

  it("re-handshakes when reconnect is pressed", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    runtime.failCommand("get_status", "runtime_disconnected")
    renderCentre(runtime)

    await screen.findByText(/Disconnected/i)
    runtime.clearFailure("get_status")
    await user.click(screen.getByRole("button", { name: /reconnect/i }))

    await waitFor(() =>
      expect(screen.queryByText(/Disconnected/i)).toBeNull()
    )
  })
})

/* ------------------------------------------------------------------ *
 * Empty state
 * ------------------------------------------------------------------ */

describe("the empty state", () => {
  it("explains the surface without inventing anything", async () => {
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    expect(await screen.findByRole("heading", { name: /command centre/i })).toBeTruthy()
    expect(screen.getByText(/scoped projects/i)).toBeTruthy()
    expect(screen.getByText(/no sessions yet/i)).toBeTruthy()
  })

  it("closes back to the workspace", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    const onClose = vi.fn()
    renderCentre(runtime, onClose)

    await user.click(await screen.findByRole("button", { name: /close command centre/i }))
    expect(onClose).toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

describe("creating a session", () => {
  it("names the provider and nothing resembling a path", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    await user.click(await screen.findByRole("button", { name: /start session/i }))

    await waitFor(() => {
      const created = runtime.commands.find((command) => command.name === "create_session")
      expect(created).toBeDefined()
      expect(created).toMatchObject({ provider: "claude-code" })
      // The protocol has no field for a path; this asserts the UI did not
      // invent one on the way in.
      expect(Object.keys(created!)).not.toContain("path")
      expect(Object.keys(created!)).not.toContain("cwd")
      expect(Object.keys(created!)).not.toContain("root")
    })
  })

  it("selects the new session and shows its header", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    await user.click(await screen.findByRole("button", { name: /start session/i }))

    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy()
  })

  it("shows a provider that cannot start a session, and why", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        providers: [
          {
            provider: "claude-code",
            connection: "connected",
            available: true,
            authentication: "unknown",
            capabilities: ["create_session"],
          },
          {
            provider: "openai-codex",
            connection: "connected",
            available: true,
            authentication: "unknown",
            capabilities: ["observe"],
          },
        ],
      }),
    })
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    // Present but honest about what it cannot do, rather than hidden or
    // offered and then failing.
    expect(await screen.findByText(/cannot start sessions yet/i)).toBeTruthy()
  })

  it("reports a runtime refusal instead of pretending the session exists", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    runtime.failCommand("create_session", "authentication_required")
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    await user.click(await screen.findByRole("button", { name: /start session/i }))

    expect(await screen.findByText(/Agent not signed in/i)).toBeTruthy()
  })

  it("says the agent is not connected, and offers the way to connect it", async () => {
    // The state a user is in before they have supplied their own provider
    // credentials: the runtime is fine, the adapter is registered, and the
    // *user* has authorized nothing. That is what the host reports as
    // `authentication: "required"` once an actor's adapter cannot resolve a
    // credential.
    const user = userEvent.setup()
    const onOpenConnectors = vi.fn()
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        providers: [
          {
            provider: "claude-code",
            connection: "configuration_required",
            available: true,
            authentication: "required",
            capabilities: ["create_session", "message"],
          },
        ],
      }),
    })
    renderCentre(runtime, vi.fn(), onOpenConnectors)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))

    // Accurate about what is missing. Not "signed in": TabDump never asks for
    // an account, it asks for the user's own credentials.
    expect(await screen.findByText(/isn't connected yet/i)).toBeTruthy()

    // Start is unavailable, and there is somewhere to go instead.
    const start = await screen.findByRole("button", { name: /start session/i })
    expect(start.hasAttribute("disabled")).toBe(true)

    await user.click(await screen.findByRole("button", { name: /^connect$/i }))
    expect(onOpenConnectors).toHaveBeenCalled()
  })

  it("does not offer a connect button on a surface with nowhere to send the user", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        providers: [
          {
            provider: "claude-code",
            connection: "configuration_required",
            available: true,
            authentication: "required",
            capabilities: ["create_session"],
          },
        ],
      }),
    })
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))

    // The sentence still appears — the user must know why Start is disabled —
    // but an action that goes nowhere does not.
    expect(await screen.findByText(/isn't connected yet/i)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull()
  })

  it("ends a session through the runtime", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /session-1|ready/i }))
    await user.click(await screen.findByRole("button", { name: /end session/i }))

    await waitFor(() =>
      expect(runtime.commands.some((command) => command.name === "dispose_session")).toBe(true)
    )
  })
})

/* ------------------------------------------------------------------ *
 * Project scope
 * ------------------------------------------------------------------ */

describe("projects", () => {
  it("authorizes a folder and syncs it to the runtime by id", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    await user.click(await screen.findByRole("button", { name: /authorize a folder/i }))

    await user.type(screen.getByLabelText(/^name$/i), "TabDump")
    await user.type(screen.getByLabelText(/^folder$/i), "/Users/me/code/tabdump")
    await user.click(screen.getByRole("button", { name: /^authorize$/i }))

    await waitFor(() => {
      const authorize = runtime.commands.find((command) => command.name === "authorize_projects")
      expect(authorize).toBeDefined()
    })
  })

  it("refuses a filesystem root with the validator's own sentence", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    await user.click(await screen.findByRole("button", { name: /authorize a folder/i }))

    await user.type(screen.getByLabelText(/^name$/i), "Everything")
    await user.type(screen.getByLabelText(/^folder$/i), "/")
    await user.click(screen.getByRole("button", { name: /^authorize$/i }))

    // The project is never created, so nothing can later name its id.
    expect(await screen.findByText(/whole drive is too broad/i)).toBeTruthy()
  })

  it("does not widen scope by authorizing every provider", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    await user.click(await screen.findByRole("button", { name: /authorize a folder/i }))
    await user.type(screen.getByLabelText(/^name$/i), "TabDump")
    await user.type(screen.getByLabelText(/^folder$/i), "/Users/me/code/tabdump")
    await user.click(screen.getByRole("button", { name: /^authorize$/i }))

    await waitFor(() => {
      const authorize = runtime.commands.find(
        (command): command is Extract<typeof command, { name: "authorize_projects" }> =>
          command.name === "authorize_projects" && command.projects.length > 0
      )
      expect(authorize).toBeDefined()
      expect(authorize!.projects[0]!.providers).toEqual(["claude-code"])
    })
  })
})

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

describe("the composer", () => {
  async function openReadySession(runtime: ScriptedRuntime) {
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    return user
  }

  it("sends a message through the runtime", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ status: "ready" })] })
    const user = await openReadySession(runtime)

    const box = await screen.findByLabelText(/message the agent/i)
    await user.type(box, "Analyze the project")
    await user.click(screen.getByRole("button", { name: /send message/i }))

    await waitFor(() => {
      const sent = runtime.commands.find((command) => command.name === "send_message")
      expect(sent).toMatchObject({ sessionId: "session-1", text: "Analyze the project" })
    })
  })

  it("sends on Enter and keeps Shift+Enter for a newline", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ status: "ready" })] })
    const user = await openReadySession(runtime)

    const box = await screen.findByLabelText(/message the agent/i)
    await user.type(box, "First{Shift>}{Enter}{/Shift}Second")
    expect((box as HTMLTextAreaElement).value).toBe("First\nSecond")

    await user.type(box, "{Enter}")
    await waitFor(() =>
      expect(runtime.commands.some((command) => command.name === "send_message")).toBe(true)
    )
  })

  it("refuses to send while the agent is running, and says why", async () => {
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "running", cancellable: true })],
    })
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /running/i }))

    const box = await screen.findByLabelText(/message the agent/i)
    expect((box as HTMLTextAreaElement).disabled).toBe(true)
    // The reason lives on the disabled control itself. It used to be repeated
    // as a second line underneath, which said the same sentence twice; that
    // line now carries the recovery step instead, and `running` has none.
    expect((box as HTMLTextAreaElement).placeholder).toMatch(/the agent is working/i)
  })

  it("refuses to send while an approval is outstanding", async () => {
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "waiting_for_approval", awaitingApproval: true })],
    })
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    const box = await screen.findByLabelText(/message the agent/i)
    expect((box as HTMLTextAreaElement).disabled).toBe(true)
  })

  it("does not send an empty message", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ status: "ready" })] })
    await openReadySession(runtime)

    const send = await screen.findByRole("button", { name: /send message/i })
    expect((send as HTMLButtonElement).disabled).toBe(true)
  })

  it("cancels a run through the runtime rather than killing anything itself", async () => {
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "running", cancellable: true })],
    })
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /running/i }))

    await user.click(await screen.findByRole("button", { name: /stop/i }))
    await waitFor(() => {
      const cancelled = runtime.commands.find((command) => command.name === "cancel_run")
      expect(cancelled).toMatchObject({ sessionId: "session-1" })
    })
  })
})

/* ------------------------------------------------------------------ *
 * Event stream
 * ------------------------------------------------------------------ */

describe("the event stream", () => {
  it("renders normalized events in their own registers", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    runtime.pushEvents([
      scriptedEvent({ id: "e1", kind: "message_sent", summary: "Analyze the project" }),
      scriptedEvent({ id: "e2", kind: "message_received", summary: "I found three files." }),
      scriptedEvent({
        id: "e3",
        kind: "file_modified",
        summary: "Updated the analysis",
        file: { relativePath: "src/analysis.py", projectId: "project-1" },
      }),
    ])

    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    expect(await screen.findByText("Analyze the project")).toBeTruthy()
    expect(screen.getByText("I found three files.")).toBeTruthy()
    expect(screen.getByText("src/analysis.py")).toBeTruthy()
  })

  it("asks only for events past the cursor", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    runtime.pushEvents([scriptedEvent({ id: "e1", summary: "First" })])

    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    await screen.findByText("First")

    // A second read starts from where the first ended, which is what makes a
    // repeated poll cheap and duplicate delivery impossible. Sending is the
    // trigger because every user-initiated command re-reads the session.
    runtime.pushEvents([scriptedEvent({ id: "e2", summary: "Second" })])
    await user.type(screen.getByLabelText(/message the agent/i), "next{Enter}")

    await waitFor(() => {
      const reads = runtime.commands.filter(
        (command): command is Extract<typeof command, { name: "get_events" }> =>
          command.name === "get_events"
      )
      expect(reads.length).toBeGreaterThan(1)
      expect(reads[reads.length - 1]!.afterSequence).toBeGreaterThan(0)
    })
  })

  it("does not carry one session's events into another", async () => {
    const runtime = createScriptedRuntime({
      sessions: [
        scriptedSession({ sessionId: "session-1", title: "First session" }),
        scriptedSession({ sessionId: "session-2", title: "Second session" }),
      ],
    })
    runtime.pushEvents([scriptedEvent({ id: "e1", summary: "Only in the first" })])

    const user = userEvent.setup()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /First session/i }))
    await screen.findByText("Only in the first")

    await user.click(screen.getByRole("button", { name: /Second session/i }))
    // The fixture serves the same journal for both, so the assertion that
    // matters is that the stream was *reset* — the cursor restarting is what
    // proves it.
    await waitFor(() => {
      const reads = runtime.commands.filter(
        (command): command is Extract<typeof command, { name: "get_events" }> =>
          command.name === "get_events"
      )
      expect(reads[reads.length - 1]!.sessionId).toBe("session-2")
      expect(reads[reads.length - 1]!.afterSequence).toBe(0)
    })
  })
})

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

describe("approvals", () => {
  function runtimeWithApproval() {
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "waiting_for_approval", awaitingApproval: true })],
    })
    runtime.setApprovals([scriptedApproval()])
    return runtime
  }

  it("surfaces the decision the run is stopped on", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWithApproval()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    const prompt = await screen.findByRole("group", { name: /approval required/i })
    expect(within(prompt).getByText(/Modify file/i)).toBeTruthy()
    expect(within(prompt).getByText("src/analysis.py")).toBeTruthy()
  })

  it("grants through the broker, never around it", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWithApproval()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    await user.click(await screen.findByRole("button", { name: /^allow$/i }))
    await waitFor(() => {
      const responded = runtime.commands.find((command) => command.name === "respond_to_approval")
      expect(responded).toMatchObject({ approvalId: "approval-1", decision: "granted" })
    })
  })

  it("denies through the same command", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWithApproval()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    await user.click(await screen.findByRole("button", { name: /^deny$/i }))
    await waitFor(() => {
      const responded = runtime.commands.find((command) => command.name === "respond_to_approval")
      expect(responded).toMatchObject({ decision: "denied" })
    })
  })

  it("issues exactly one decision per click", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWithApproval()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    await user.click(await screen.findByRole("button", { name: /^allow$/i }))
    await waitFor(() =>
      expect(
        runtime.commands.filter((command) => command.name === "respond_to_approval")
      ).toHaveLength(1)
    )
  })

  it("resolves the prompt once the runtime stops reporting it", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWithApproval()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))
    await screen.findByRole("group", { name: /approval required/i })

    runtime.setApprovals([])
    runtime.setSessions([scriptedSession({ status: "running", cancellable: true })])
    await user.click(await screen.findByRole("button", { name: /^allow$/i }))

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /approval required/i })).toBeNull()
    )
  })

  it("refuses an expired approval rather than sending a decision that cannot land", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "waiting_for_approval", awaitingApproval: true })],
    })
    runtime.setApprovals([scriptedApproval({ expiresAt: 1 })])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    const prompt = await screen.findByRole("group", { name: /approval required/i })
    expect(within(prompt).getByText(/expired/i)).toBeTruthy()
    expect((within(prompt).getByRole("button", { name: /^allow$/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

describe("context", () => {
  async function openPicker(runtime: ScriptedRuntime) {
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))
    // Two controls open the picker — the composer's paperclip and the
    // inspector's button. Scoped to the composer so the query is unambiguous.
    const main = screen.getByRole("main")
    await user.click(within(main).getByRole("button", { name: /attach tabdump context/i }))
    return user
  }

  it("says nothing is attached before anything is", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const user = userEvent.setup()
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    expect(await screen.findByText(/nothing attached/i)).toBeTruthy()
    expect(screen.getByText(/sees only what you send it/i)).toBeTruthy()
  })

  it("previews what a selection actually resolves to", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const user = await openPicker(runtime)

    await user.click(await screen.findByRole("checkbox", { name: /research/i }))
    // Resolved by the real resolver, so the number is the number.
    const preview = screen.getByText(/will be attached/i).parentElement!
    expect(within(preview).getByText("Tabs")).toBeTruthy()
    expect(within(preview).getByText("3")).toBeTruthy()
  })

  it("attaches the resolved snapshot through the runtime", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const user = await openPicker(runtime)

    await user.click(await screen.findByRole("checkbox", { name: /research/i }))
    await user.click(screen.getByRole("button", { name: /^attach$/i }))

    await waitFor(() => {
      const attached = runtime.commands.find(
        (command): command is Extract<typeof command, { name: "attach_context" }> =>
          command.name === "attach_context"
      )
      expect(attached).toBeDefined()
      // The real payload, not an empty one: the snapshot id, its capture time
      // and the attachments it produced.
      expect(attached!.context.snapshotId).toBeTruthy()
      expect(attached!.context.capturedAt).toBeGreaterThan(0)
      expect(attached!.context.attachments.length).toBeGreaterThan(0)
    })
  })

  it("shows the attached counts in the inspector", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const user = await openPicker(runtime)

    await user.click(await screen.findByRole("checkbox", { name: /research/i }))
    await user.click(screen.getByRole("button", { name: /^attach$/i }))

    const panel = await screen.findByRole("complementary", { name: /session context/i })
    await waitFor(() => expect(within(panel).getByText("Tabs")).toBeTruthy())
  })

  it("re-attaches a second snapshot on refresh rather than mutating the first", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const user = await openPicker(runtime)

    await user.click(await screen.findByRole("checkbox", { name: /research/i }))
    await user.click(screen.getByRole("button", { name: /^attach$/i }))

    const panel = await screen.findByRole("complementary", { name: /session context/i })
    await waitFor(() => expect(within(panel).getByText("Tabs")).toBeTruthy())

    await user.click(within(panel).getByRole("button", { name: /refresh context/i }))

    await waitFor(() => {
      const attaches = runtime.commands.filter(
        (command): command is Extract<typeof command, { name: "attach_context" }> =>
          command.name === "attach_context"
      )
      expect(attaches.length).toBe(2)
      // A new id, chained from the first: refresh mints a snapshot, it does
      // not edit one.
      expect(attaches[1]!.context.snapshotId).not.toBe(attaches[0]!.context.snapshotId)
    })
  })

  it("does not attach anything when nothing was selected", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    await openPicker(runtime)

    expect((screen.getByRole("button", { name: /^attach$/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it("keeps tab notes off unless they are asked for", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    await openPicker(runtime)

    const notes = await screen.findByRole("checkbox", { name: /include my tab notes/i })
    expect(notes.getAttribute("aria-checked")).toBe("false")
  })
})

/* ------------------------------------------------------------------ *
 * Accessibility
 * ------------------------------------------------------------------ */

describe("accessibility", () => {
  it("marks the selected session as the current one", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession({ title: "Analysis" })] })
    renderCentre(runtime)

    const row = await screen.findByRole("button", { name: /Analysis/i })
    await user.click(row)
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"))
  })

  it("names every landmark", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    expect(screen.getByRole("navigation", { name: /agent sessions/i })).toBeTruthy()
    expect(screen.getByRole("complementary", { name: /session context/i })).toBeTruthy()
  })

  it("gives the approval prompt an assertive live region", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "waiting_for_approval", awaitingApproval: true })],
    })
    runtime.setApprovals([scriptedApproval()])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    const prompt = await screen.findByRole("group", { name: /approval required/i })
    expect(prompt.getAttribute("aria-live")).toBe("assertive")
  })

  it("puts focus on the safer of the two approval answers", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "waiting_for_approval", awaitingApproval: true })],
    })
    runtime.setApprovals([scriptedApproval()])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    const deny = await screen.findByRole("button", { name: /^deny$/i })
    await waitFor(() => expect(document.activeElement).toBe(deny))
  })

  it("labels every icon-only control", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    for (const button of screen.getAllByRole("button")) {
      const name = button.getAttribute("aria-label") ?? button.textContent?.trim()
      expect(name, button.outerHTML.slice(0, 120)).toBeTruthy()
    }
  })
})

/* ------------------------------------------------------------------ *
 * No fabrication
 * ------------------------------------------------------------------ */

describe("nothing is invented", () => {
  it("renders no session, event or activity that the runtime did not report", async () => {
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    await screen.findByRole("heading", { name: /command centre/i })

    // The specific failure this guards is a first-run screen populated with
    // sample agents and sample conversations, which teaches the user to
    // distrust every number the product shows afterwards.
    expect(screen.getByText(/no sessions yet/i)).toBeTruthy()
    expect(screen.queryByText(/claude is analyzing/i)).toBeNull()
  })

  it("reports an empty event stream as empty", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    const stream = await screen.findByRole("list", { name: /session events/i })
    expect(within(stream).queryAllByRole("listitem")).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * Phase H: what the surface says about itself
 * ------------------------------------------------------------------ */

describe("the location and runtime bar", () => {
  it("states the runtime is ready, not only that it is broken", async () => {
    // The regression: `runtimeBanner` has always had a healthy answer and the
    // bar rendered only when `executable` was false, so a working command
    // centre said nothing at all about whether agents could run.
    const runtime = createScriptedRuntime({ status: scriptedStatus({ executable: true }) })
    renderCentre(runtime)

    expect(await screen.findByText(/LOCAL · Ready/i)).toBeTruthy()
  })

  it("still explains an unavailable runtime", async () => {
    const runtime = createScriptedRuntime({ status: scriptedStatus({ executable: false }) })
    renderCentre(runtime)

    expect(await screen.findByText(/Unavailable/i)).toBeTruthy()
  })

  it("says REMOTE · Ready rather than unavailable when agents genuinely run remotely", async () => {
    // The specific thing Phase I changed, and the specific thing it must not
    // have faked. The old sentence was true for a hosted deployment when it
    // was written; it is false once a remote runtime exists, and a user whose
    // agent is running in a sandbox must not be told agents cannot run.
    const runtime = createScriptedRuntime({
      status: scriptedStatus({ environment: "remote", executable: true }),
    })
    renderCentre(runtime)

    expect(await screen.findByText(/REMOTE · Ready/i)).toBeTruthy()
    expect(screen.queryByText(/unavailable/i)).toBeNull()
  })

  it("distinguishes the two executing planes, because the blast radius differs", async () => {
    // "Agents run on this machine" and "agents run in a container we made" are
    // different promises about where the user's files are.
    const remote = createScriptedRuntime({
      status: scriptedStatus({ environment: "remote", executable: true }),
    })
    const { unmount } = renderCentre(remote)
    expect(await screen.findByText(/REMOTE · Ready/i)).toBeTruthy()
    unmount()

    const local = createScriptedRuntime({
      status: scriptedStatus({ environment: "local", executable: true }),
    })
    renderCentre(local)
    expect(await screen.findByText(/LOCAL · Ready/i)).toBeTruthy()
  })

  it("names where you are", async () => {
    const runtime = createScriptedRuntime()
    renderCentre(runtime)

    const bar = await screen.findByText("Command Centre", { selector: "span" })
    expect(bar).toBeTruthy()
  })
})

describe("the approval prompt", () => {
  it("names the permission in words rather than as a scope identifier", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "waiting_for_approval", awaitingApproval: true })],
    })
    runtime.setApprovals([scriptedApproval({ scope: "write_project" })])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    expect(await screen.findByText(/change project files/i)).toBeTruthy()
    // The identifier itself is an internal name and must not reach the one
    // screen where the user authorizes something.
    expect(screen.queryByText("write_project")).toBeNull()
  })

  it("shows an unrecognized scope verbatim rather than inventing words for it", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ status: "waiting_for_approval", awaitingApproval: true })],
    })
    runtime.setApprovals([scriptedApproval({ scope: "some_future_scope" })])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /waiting for approval/i }))

    expect(await screen.findByText("some_future_scope")).toBeTruthy()
  })
})

describe("the event stream", () => {
  it("does not print an event's label and summary when they are the same words", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    // The real normalizer emits exactly this pair, which rendered as
    // "Session started  Session started.".
    runtime.pushEvents([scriptedEvent({ kind: "session_started", summary: "Session started." })])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    const stream = await screen.findByRole("list", { name: /session events/i })
    expect(within(stream).getAllByText(/session started/i)).toHaveLength(1)
  })

  it("keeps a summary that carries detail the label does not", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    runtime.pushEvents([scriptedEvent({ kind: "thinking", summary: "Reviewing 12 attached tabs" })])
    renderCentre(runtime)
    await user.click(await screen.findByRole("button", { name: /ready/i }))

    expect(await screen.findByText(/reviewing 12 attached tabs/i)).toBeTruthy()
  })
})
