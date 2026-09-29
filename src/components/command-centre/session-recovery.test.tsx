import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandCentreView } from "./command-centre-view"
import { buildContextWorld } from "@/lib/agents/command-centre/world"
import { createScriptedRuntime, scriptedStatus } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { seedConnectedAgent } from "@/lib/agents/platform/__fixtures__/roster"
import type { RuntimeCommand, RuntimeProviderStatus } from "@/lib/agents/runtime/protocol"

/**
 * Starting a session around authentication (Agent Authentication & Runtime).
 *
 *   - A sign-in that gets in the way is fixed in place, and what the person
 *     was starting — agent, workspace, title, first message — is still there
 *     when they come back.
 *   - Pressing Start more than once starts one session.
 *   - A refused start can be tried again, one session per explicit press.
 */

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

function claude(over: Partial<RuntimeProviderStatus> = {}): RuntimeProviderStatus {
  return {
    provider: "claude-code",
    connection: "connected",
    available: true,
    authentication: "unknown",
    capabilities: ["create_session", "message"],
    ...over,
  }
}

function renderCentre(runtime: ReturnType<typeof createScriptedRuntime>) {
  return render(
    <CommandCentreView world={world()} onClose={vi.fn()} client={runtime.client} poll={false} activeWorkspaceId="w2" />
  )
}

beforeEach(() => {
  window.localStorage.clear()
  seedConnectedAgent("claude-code")
})

describe("recovering from sign-in, without losing the session being started", () => {
  it("says what is missing, opens the fix in place, and hands back the workspace and title", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        providers: [claude({ connection: "configuration_required", authentication: "required" })],
      }),
    })
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    let dialog = await screen.findByRole("dialog", { name: /new agent session/i })

    // The person chooses another workspace and names the session…
    await user.click(within(dialog).getByRole("button", { name: /Launch plan/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Research" }))
    await user.type(within(dialog).getByLabelText(/title/i), "Launch review")

    // …and is told exactly what is missing, with the one action that fixes it.
    expect(within(dialog).getByText("Claude Code needs you to sign in.")).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: /start session/i }).hasAttribute("disabled")).toBe(true)
    await user.click(within(dialog).getByRole("button", { name: /^sign in$/i }))

    // The fix, in place: Connect Agent for this agent.
    const connect = await screen.findByRole("dialog", { name: /Connect Claude Code/i })
    expect(within(connect).getByText(/Claude Code runs on your own Anthropic API key here/i)).toBeTruthy()
    await user.keyboard("{Escape}")

    // Back where they were, with what they chose.
    dialog = await screen.findByRole("dialog", { name: /new agent session/i })
    expect((within(dialog).getByLabelText(/title/i) as HTMLInputElement).value).toBe("Launch review")
    expect(within(dialog).getByRole("button", { name: /Research/ })).toBeTruthy()
    // Nothing was started, and no other sign-in was chosen for them.
    expect(runtime.commands.some((command) => command.name === "create_session")).toBe(false)
    expect(runtime.commands.some((command) => command.name === "authenticate_provider")).toBe(false)
  })

  it("lets go of that session when the person closes New session themselves", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        providers: [claude({ connection: "configuration_required", authentication: "required" })],
      }),
    })
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    const dialog = await screen.findByRole("dialog", { name: /new agent session/i })
    await user.type(within(dialog).getByLabelText(/title/i), "Draft")
    await user.click(within(dialog).getByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /new agent session/i })).toBeNull())

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    const again = await screen.findByRole("dialog", { name: /new agent session/i })
    expect((within(again).getByLabelText(/title/i) as HTMLInputElement).value).toBe("")
  })
})

describe("no duplicate sessions", () => {
  it("starts one session when Start is pressed twice while the first is still starting", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ status: scriptedStatus({ providers: [claude()] }) })
    // Hold create_session open, as a slow agent launch would, counting every attempt.
    let release: () => void = () => {}
    let attempts = 0
    const send = runtime.client.send.bind(runtime.client) as (command: RuntimeCommand) => Promise<unknown>
    runtime.client.send = ((command: RuntimeCommand): Promise<unknown> => {
      if (command.name !== "create_session") return send(command)
      attempts += 1
      return new Promise<unknown>((resolve) => {
        release = () => resolve(send(command))
      })
    }) as unknown as typeof runtime.client.send
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    const dialog = await screen.findByRole("dialog", { name: /new agent session/i })
    const start = within(dialog).getByRole("button", { name: /start session/i })
    fireEvent.click(start)
    fireEvent.click(start)
    fireEvent.click(start)

    await waitFor(() => expect(attempts).toBe(1))
    expect(within(dialog).getByRole("button", { name: /starting/i }).hasAttribute("disabled")).toBe(true)
    release()
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /new agent session/i })).toBeNull())
    expect(attempts).toBe(1)
  })

  it("tries again only when asked: a refused start and one retry are two attempts, one session", async () => {
    const user = userEvent.setup()
    const runtime = createScriptedRuntime({ status: scriptedStatus({ providers: [claude()] }) })
    runtime.failCommand("create_session", "timeout")
    renderCentre(runtime)

    await user.click(await screen.findByRole("button", { name: /new agent session/i }))
    const dialog = await screen.findByRole("dialog", { name: /new agent session/i })
    await user.click(within(dialog).getByRole("button", { name: /start session/i }))
    expect(await within(dialog).findByText(/The agent did not answer/i)).toBeTruthy()

    runtime.clearFailure("create_session")
    await user.click(within(dialog).getByRole("button", { name: /start session/i }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /new agent session/i })).toBeNull())

    expect(runtime.commands.filter((command) => command.name === "create_session")).toHaveLength(2)
    const listed = await runtime.client.send({ name: "list_sessions" })
    expect(listed.ok && listed.value.sessions).toHaveLength(1)
  })
})
