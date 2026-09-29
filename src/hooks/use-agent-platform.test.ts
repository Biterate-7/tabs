import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useAgentPlatform } from "./use-agent-platform"
import { createScriptedRuntime, scriptedStatus } from "@/lib/agents/command-centre/__fixtures__/runtime-client"
import { approveAgent, EMPTY_ROSTER, saveAgentRoster } from "@/lib/agents/platform/roster"
import { runtimeFailure } from "@/lib/agents/runtime/protocol"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeCommand, RuntimeErrorCode, RuntimeProviderStatus, RuntimeStatus } from "@/lib/agents/runtime/protocol"

/**
 * The platform hook's part in Agent Authentication & Runtime: a failed
 * connect or sign-in becomes a terminal phase with a way forward, a status
 * that says `connecting` for too long becomes a timeout, and none of it
 * crosses from one provider to another.
 */

function provider(id: AgentProviderId, over: Partial<RuntimeProviderStatus> = {}): RuntimeProviderStatus {
  return {
    provider: id,
    connection: "disconnected",
    available: true,
    authentication: "unknown",
    capabilities: ["create_session", "message"],
    ...over,
  }
}

function setup(status: RuntimeStatus) {
  const runtime = createScriptedRuntime({ status })
  runtime.setDetections([
    { provider: "claude-code", installed: true, transport: "sdk", launchable: false },
    { provider: "gemini", installed: true, transport: "acp", launchable: true },
    { provider: "openai-codex", installed: true, transport: "acp", launchable: true },
  ])
  runtime.setConnection({
    ...provider("gemini", { connection: "connected", authentication: "required", nativeSignIn: true }),
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  })
  runtime.setConnection({
    ...provider("openai-codex", { connection: "connected", authentication: "authenticated", nativeSignIn: true, capabilities: [] }),
    authMethods: [{ id: "chat-gpt", name: "ChatGPT" }],
  })
  return runtime
}

/** A client that fails one command for one provider only — the others answer normally. */
function failingFor(client: RuntimeClient, target: AgentProviderId, name: RuntimeCommand["name"], code: RuntimeErrorCode) {
  const send = client.send.bind(client) as (command: RuntimeCommand) => Promise<unknown>
  let failing = true
  const wrapped: RuntimeClient = {
    ...client,
    send: ((command: RuntimeCommand) =>
      failing && command.name === name && "provider" in command && command.provider === target
        ? Promise.resolve(runtimeFailure(code))
        : send(command)) as RuntimeClient["send"],
  }
  return { client: wrapped, stop: () => (failing = false) }
}

const STATUS = scriptedStatus({
  providers: [provider("claude-code", { connection: "connected" }), provider("gemini"), provider("openai-codex")],
})

beforeEach(() => {
  window.localStorage.clear()
})

describe("a failed sign-in is a terminal phase, with a way forward", () => {
  it("shows sign-in failed after the agent's own sign-in fails, and Try again moves it on", async () => {
    const runtime = setup(STATUS)
    const failing = failingFor(runtime.client, "gemini", "authenticate_provider", "provider_error")
    const { result } = renderHook(() => useAgentPlatform({ client: failing.client, status: STATUS, surface: "desktop" }))

    await act(() => result.current.connect("gemini"))
    expect(result.current.phaseOf("gemini")).toBe("sign_in_required")

    await act(() => result.current.authenticate("gemini", "oauth-personal"))
    expect(result.current.phaseOf("gemini")).toBe("auth_failed")
    expect(result.current.sentenceOf("gemini")).toBe("Gemini CLI couldn't authenticate.")

    failing.stop()
    await act(() => result.current.authenticate("gemini", "oauth-personal"))
    expect(result.current.phaseOf("gemini")).toBe("awaiting_approval")
  })

  it("shows a timeout — never Connecting… — when the agent does not answer, and Retry recovers", async () => {
    const runtime = setup(STATUS)
    const failing = failingFor(runtime.client, "gemini", "connect_provider", "timeout")
    const { result } = renderHook(() => useAgentPlatform({ client: failing.client, status: STATUS, surface: "desktop" }))

    await act(() => result.current.connect("gemini"))
    expect(result.current.phaseOf("gemini")).toBe("timeout")
    expect(result.current.pending).toBeNull()

    failing.stop()
    await act(() => result.current.retry("gemini"))
    expect(result.current.phaseOf("gemini")).toBe("sign_in_required")
  })

  it("re-handshakes before retrying after the runtime itself was lost", async () => {
    const runtime = setup(STATUS)
    const failing = failingFor(runtime.client, "gemini", "connect_provider", "runtime_disconnected")
    const { result } = renderHook(() => useAgentPlatform({ client: failing.client, status: STATUS, surface: "desktop" }))

    await act(() => result.current.connect("gemini"))
    expect(result.current.phaseOf("gemini")).toBe("connection_lost")

    failing.stop()
    const before = runtime.commands.length
    await act(() => result.current.retry("gemini"))
    const issued = runtime.commands.slice(before).map((command) => command.name)
    expect(issued.indexOf("get_status")).toBeGreaterThanOrEqual(0)
    expect(issued.indexOf("get_status")).toBeLessThan(issued.indexOf("connect_provider"))
    expect(result.current.phaseOf("gemini")).toBe("sign_in_required")
  })
})

describe("the watchdog", () => {
  it("turns a runtime that keeps reporting `connecting` into a timeout", async () => {
    const stuck = scriptedStatus({ providers: [provider("gemini", { connection: "connecting" })] })
    const runtime = setup(stuck)
    const { result } = renderHook(() =>
      useAgentPlatform({ client: runtime.client, status: stuck, surface: "desktop", stallMs: 30 })
    )
    expect(result.current.phaseOf("gemini")).not.toBe("timeout")
    await waitFor(() => expect(result.current.phaseOf("gemini")).toBe("timeout"))
  })

  it("clears the stall as soon as the runtime moves on", async () => {
    const stuck = scriptedStatus({ providers: [provider("gemini", { connection: "connecting" })] })
    const moved = scriptedStatus({ providers: [provider("gemini", { connection: "connected", authentication: "required", nativeSignIn: true })] })
    const runtime = setup(stuck)
    const { result, rerender } = renderHook(
      ({ status }) => useAgentPlatform({ client: runtime.client, status, surface: "desktop", stallMs: 30 }),
      { initialProps: { status: stuck } }
    )
    await waitFor(() => expect(result.current.phaseOf("gemini")).toBe("timeout"))
    rerender({ status: moved })
    await waitFor(() => expect(result.current.phaseOf("gemini")).toBe("sign_in_required"))
  })
})

describe("provider isolation", () => {
  it("a Claude failure cannot affect Codex, and a Codex state cannot affect Gemini", async () => {
    const runtime = setup(STATUS)
    const failing = failingFor(runtime.client, "claude-code", "connect_provider", "timeout")
    const { result } = renderHook(() => useAgentPlatform({ client: failing.client, status: STATUS, surface: "desktop" }))

    await act(() => result.current.connect("claude-code"))
    await act(() => result.current.connect("openai-codex"))
    await act(() => result.current.connect("gemini"))

    expect(result.current.phaseOf("claude-code")).toBe("timeout")
    // Codex is signed in; its sessions are refused for its own reason only.
    expect(result.current.statusOf("openai-codex")?.authentication).toBe("authenticated")
    expect(result.current.sessionsFor("openai-codex").available).toBe(false)
    // Gemini is exactly what Gemini said.
    expect(result.current.phaseOf("gemini")).toBe("sign_in_required")
    expect(result.current.statusOf("gemini")?.authentication).toBe("required")
    expect(result.current.errors).toEqual({ "claude-code": "timeout" })
  })

  it("keeps each provider's session prerequisite to its own facts", async () => {
    const both = (["gemini", "claude-code"] as const).reduce(
      (roster, id) => approveAgent(roster, { provider: id, name: id, scopes: ["read_workspace"], now: 1 }),
      EMPTY_ROSTER
    )
    saveAgentRoster(both)
    const runtime = setup(STATUS)
    const failing = failingFor(runtime.client, "claude-code", "connect_provider", "provider_unavailable")
    const { result } = renderHook(() => useAgentPlatform({ client: failing.client, status: STATUS, surface: "desktop" }))

    await act(() => result.current.connect("claude-code"))
    await act(() => result.current.connect("gemini"))
    // Claude could not be reached: retry. Gemini said it is signed out since
    // it was approved: sign in. Each for its own reason, neither for the other's.
    expect(result.current.prerequisiteFor("claude-code")).toMatchObject({ ok: false, phase: "error", action: "retry" })
    expect(result.current.prerequisiteFor("gemini")).toMatchObject({ ok: false, phase: "auth_expired", action: "sign_in" })
  })

  it("refuses nothing on a guess: an approved agent not asked yet can still start", () => {
    saveAgentRoster(approveAgent(EMPTY_ROSTER, { provider: "gemini", name: "gemini", scopes: ["read_workspace"], now: 1 }))
    const runtime = setup(STATUS)
    // Detection has not answered, so nothing has been asked of the agent yet.
    const send = runtime.client.send.bind(runtime.client) as (command: RuntimeCommand) => Promise<unknown>
    const client: RuntimeClient = {
      ...runtime.client,
      send: ((command: RuntimeCommand) =>
        command.name === "detect_providers" ? new Promise(() => {}) : send(command)) as RuntimeClient["send"],
    }
    const { result } = renderHook(() => useAgentPlatform({ client, status: STATUS, surface: "desktop" }))
    expect(result.current.phaseOf("gemini")).toBe("unknown")
    expect(result.current.prerequisiteFor("gemini")).toEqual({ ok: true })
  })
})

describe("readiness", () => {
  it("answers the questions a person asks, and holds nothing secret", async () => {
    const runtime = setup(STATUS)
    const { result } = renderHook(() => useAgentPlatform({ client: runtime.client, status: STATUS, surface: "desktop" }))
    await act(() => result.current.connect("gemini"))
    const readiness = result.current.readinessOf("gemini")!
    expect(readiness).toMatchObject({
      phase: "sign_in_required",
      installed: true,
      reachable: true,
      authenticated: false,
      supportsSubscriptionAuth: true,
      requiresSetup: false,
      authExpired: false,
      canCreateSession: false,
    })
    expect(readiness.activeMethod).toBeUndefined()
    expect(JSON.stringify(readiness)).not.toMatch(/token|password|secret|sk-/i)
  })
})
