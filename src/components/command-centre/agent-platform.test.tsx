import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import {
  createScriptedRuntime,
  scriptedEvent,
  scriptedSession,
  scriptedStatus,
} from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import { AGENT_ROSTER_KEY, loadAgentRoster } from "@/lib/agents/platform/roster"
import { scopedKey } from "@/lib/storage/namespace"
import type { ScriptedRuntime } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import type { RuntimeProviderStatus } from "@/lib/agents/runtime/protocol"

/**
 * The agent connector platform (Phase J), through the real command centre.
 *
 * Every action is asserted by the command it issued, so a button wired to
 * nothing fails here. The runtime is the scripted one; nothing is spawned.
 */

function geminiStatus(over: Partial<RuntimeProviderStatus> = {}): RuntimeProviderStatus {
  return {
    provider: "gemini",
    connection: "disconnected",
    available: true,
    authentication: "unknown",
    capabilities: ["create_session", "message", "cancel_run", "stream_events", "approvals"],
    ...over,
  }
}

function runtimeWithGemini(): ScriptedRuntime {
  const runtime = createScriptedRuntime({
    status: scriptedStatus({
      providers: [
        {
          provider: "claude-code",
          connection: "connected",
          available: true,
          authentication: "unknown",
          capabilities: ["create_session", "message"],
        },
        geminiStatus(),
      ],
    }),
  })
  runtime.setDetections([
    { provider: "claude-code", installed: true, transport: "sdk", launchable: false, signIn: "unknown" },
    { provider: "gemini", installed: true, transport: "acp", launchable: true, signIn: "unknown" },
    { provider: "openai-codex", installed: true, transport: "acp", launchable: false, signIn: "signed_in" },
    { provider: "grok", installed: false, transport: "acp", launchable: false, signIn: "unknown" },
  ])
  runtime.setConnection({
    ...geminiStatus({ connection: "connected" }),
    authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
  })
  return runtime
}

function world() {
  return buildContextWorld({
    ownerId: "owner-1",
    workspaces: [
      { id: "w1", name: "Research", createdAt: 0, updatedAt: 0, tabs: [] },
      { id: "w2", name: "Launch plan", createdAt: 0, updatedAt: 0, tabs: [] },
    ],
    collections: [],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  })
}

function renderCentre(runtime: ScriptedRuntime, activeWorkspaceId?: string) {
  return render(
    <CommandCentreView
      world={world()}
      onClose={vi.fn()}
      client={runtime.client}
      poll={false}
      onOpenConnectors={vi.fn()}
      {...(activeWorkspaceId ? { activeWorkspaceId } : {})}
    />
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("the roster", () => {
  it("says there are no agents and how to connect one, rather than inventing any", async () => {
    renderCentre(runtimeWithGemini())
    const roster = await screen.findByRole("region", { name: /connected agents/i })
    expect(within(roster).getByText(/No agents connected/i)).toBeTruthy()
    expect(within(roster).getByRole("button", { name: /connect agent/i })).toBeTruthy()
  })

  it("shows a connected agent with its live state and the workspace it is working in", async () => {
    seedConnectedAgent("claude-code")
    const runtime = runtimeWithGemini()
    runtime.setSessions([scriptedSession({ status: "waiting_for_approval", workspaceId: "w2" })])
    renderCentre(runtime)

    const roster = await screen.findByRole("region", { name: /connected agents/i })
    expect(
      await within(roster).findByRole("button", { name: /claude-code — Waiting for your approval/i })
    ).toBeTruthy()
    expect(within(roster).getByText(/Launch plan/)).toBeTruthy()
  })
})

describe("Connect Agent", () => {
  it("walks detect → sign in → approve → connected for an ACP agent, through the agent's own sign-in", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWithGemini()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /connect agent/i }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /Gemini CLI/ }))

    // Installed, so straight to sign-in — which starts by reaching the agent.
    await user.click(await within(dialog).findByRole("button", { name: /Reach Gemini CLI/i }))
    // Reached but not yet known to be signed in: the methods stay on screen.
    expect(within(dialog).getByRole("button", { name: /continue/i })).toBeTruthy()
    await user.click(await within(dialog).findByRole("button", { name: /Sign in with Google/i }))

    // Once the agent says it is signed in, the flow moves on by itself.
    // Reading is on by default; changing files and running commands are not.
    const approve = await within(dialog).findByRole("group")
    const boxes = within(approve).getAllByRole("checkbox")
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "true", "false", "false"])
    expect(within(dialog).getByText(/Run a shell command through TabDump/)).toBeTruthy()

    await user.click(within(dialog).getByRole("button", { name: /approve and connect/i }))
    expect(await within(dialog).findByText(/Gemini CLI is connected/)).toBeTruthy()

    const issued = runtime.commands.map((command) => command.name)
    expect(issued).toContain("detect_providers")
    expect(runtime.commands).toContainEqual({ name: "connect_provider", provider: "gemini" })
    expect(runtime.commands).toContainEqual({
      name: "authenticate_provider",
      provider: "gemini",
      methodId: "oauth-personal",
    })

    const agent = loadAgentRoster().agents.find((entry) => entry.provider === "gemini")
    expect(agent?.approvedScopes).toEqual(["read_workspace", "read_project"])
    // The roster holds consent, never a credential.
    const stored = window.localStorage.getItem(scopedKey(AGENT_ROSTER_KEY))!
    expect(stored).not.toMatch(/token|key|password|oauth/i)
  })

  it("shows the install command for an agent that is not installed, and does not let it continue", async () => {
    const user = userEvent.setup()
    renderCentre(runtimeWithGemini())

    await user.click(await screen.findByRole("button", { name: /connect agent/i }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /Grok Build/ }))

    expect(await within(dialog).findByText(/not installed on this machine/i)).toBeTruthy()
    expect(within(dialog).getByText("curl -fsSL https://x.ai/cli/install.sh | bash")).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /continue/i })).toBeNull()
  })

  it("says Codex needs its ACP adapter when only Codex itself is installed", async () => {
    const user = userEvent.setup()
    renderCentre(runtimeWithGemini())

    await user.click(await screen.findByRole("button", { name: /connect agent/i }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /Codex/ }))

    expect(await within(dialog).findByText(/program TabDump drives it through is not/i)).toBeTruthy()
    expect(within(dialog).getByText("npm install -g @agentclientprotocol/codex-acp")).toBeTruthy()
  })

  it("connects a custom MCP agent without sending the runtime anything", async () => {
    const user = userEvent.setup()
    const runtime = runtimeWithGemini()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /connect agent/i }))
    const dialog = await screen.findByRole("dialog")
    const before = runtime.commands.length
    await user.click(within(dialog).getByRole("button", { name: /Custom MCP agent/ }))
    await user.click(await within(dialog).findByRole("button", { name: /approve and connect/i }))

    expect(await within(dialog).findByText(/Custom MCP agent is connected/)).toBeTruthy()
    expect(
      runtime.commands.slice(before).filter((command) => command.name.endsWith("_provider"))
    ).toEqual([])
    expect(loadAgentRoster().agents[0]).toMatchObject({ provider: "custom", approvedScopes: ["read_workspace"] })
  })

  it("disconnects: ends the agent's sessions in the runtime and forgets the approval", async () => {
    const user = userEvent.setup()
    seedConnectedAgent("gemini")
    const runtime = runtimeWithGemini()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /connect agent/i }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /Gemini CLI/ }))
    await user.click(await within(dialog).findByRole("button", { name: /^disconnect$/i }))

    await waitFor(() =>
      expect(runtime.commands).toContainEqual({ name: "disconnect_provider", provider: "gemini" })
    )
    await waitFor(() => expect(loadAgentRoster().agents).toEqual([]))
  })
})

describe("starting a session with a connected agent", () => {
  it("offers only connected agents, with a way to connect the rest", async () => {
    const user = userEvent.setup()
    seedConnectedAgent("claude-code")
    renderCentre(runtimeWithGemini())

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Not connected")).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: /^connect$/i })).toBeTruthy()
  })

  it("associates the session with the workspace the user came from, and records it on the agent", async () => {
    const user = userEvent.setup()
    seedConnectedAgent("claude-code")
    const runtime = runtimeWithGemini()
    renderCentre(runtime, "w2")

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    await user.click(await screen.findByRole("button", { name: /start session/i }))

    await waitFor(() =>
      expect(runtime.commands.find((command) => command.name === "create_session")).toMatchObject({
        provider: "claude-code",
        workspaceId: "w2",
      })
    )
    await waitFor(() =>
      expect(loadAgentRoster().agents[0]).toMatchObject({ workspaceId: "w2", lastSessionId: "session-1" })
    )
  })
})

describe("the agent chat", () => {
  it("renders the user's words and the agent's streamed reply whole, across lines", async () => {
    const user = userEvent.setup()
    seedConnectedAgent("gemini")
    const runtime = runtimeWithGemini()
    runtime.setSessions([scriptedSession({ provider: "gemini", status: "running" })])
    runtime.pushEvents([
      scriptedEvent({ id: "u1", kind: "message_sent", summary: "Plan the launch", text: "Plan the launch\nfor Friday" }),
      scriptedEvent({ id: "d1", kind: "message_delta", summary: "Here", text: "Here is ", messageId: "m1" }),
      scriptedEvent({ id: "d2", kind: "message_delta", summary: "a plan", text: "a plan:\n1. Draft", messageId: "m1" }),
    ])
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /Gemini CLI|gemini/i }))
    const stream = await screen.findByRole("list", { name: /session events/i })

    expect(await within(stream).findByText(/Plan the launch\s+for Friday/)).toBeTruthy()
    const reply = await within(stream).findByText(/Here is a plan:\s+1\. Draft/)
    expect(reply.closest("li")?.getAttribute("aria-busy")).toBe("true")
  })
})

describe("the desktop app (Phase J.1)", () => {
  function desktopRuntime() {
    const claude = {
      provider: "claude-code" as const,
      connection: "configuration_required" as const,
      available: true,
      authentication: "required" as const,
      capabilities: ["create_session" as const, "message" as const, "approvals" as const],
      nativeSignIn: true,
    }
    const runtime = createScriptedRuntime({ status: scriptedStatus({ providers: [claude] }) })
    runtime.setDetections([
      { provider: "claude-code", installed: true, transport: "sdk", launchable: false, signIn: "signed_in" },
    ])
    runtime.setConnection({
      ...claude,
      authMethods: [
        { id: "claudeai", name: "Sign in with Claude" },
        { id: "console", name: "Sign in with Anthropic Console" },
      ],
    })
    return runtime
  }

  it("signs Claude in with its own login — no key, no settings page — then approves writes", async () => {
    const user = userEvent.setup()
    const runtime = desktopRuntime()
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /connect agent/i }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /Claude Code/ }))

    expect(await within(dialog).findByText(/through Claude Code's login/i)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /open ai connectors/i })).toBeNull()

    await user.click(within(dialog).getByRole("button", { name: /Reach Claude Code/i }))
    await user.click(await within(dialog).findByRole("button", { name: /Sign in with Claude/i }))

    // Signed in: straight to approval. Turn on changing files, which asks each time.
    const approve = await within(dialog).findByRole("group")
    await user.click(within(approve).getByRole("checkbox", { name: /Change project files/i }))
    await user.click(within(dialog).getByRole("button", { name: /approve and connect/i }))
    expect(await within(dialog).findByText(/Claude Code is connected/)).toBeTruthy()

    expect(runtime.commands).toContainEqual({
      name: "authenticate_provider",
      provider: "claude-code",
      methodId: "claudeai",
    })
    expect(loadAgentRoster().agents[0]).toMatchObject({
      provider: "claude-code",
      approvedScopes: ["read_workspace", "read_project", "write_project"],
    })
  })
})
