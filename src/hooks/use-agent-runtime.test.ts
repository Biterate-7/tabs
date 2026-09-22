import { describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useAgentRuntime } from "./use-agent-runtime"
import {
  createScriptedRuntime,
  scriptedStatus,
} from "@/lib/agents/command-centre/__fixtures__/runtime-client"

/**
 * The handshake and the honesty rule.
 *
 * `status === null` means "not told yet" and must never be read as either
 * ready or unavailable — a hook that defaulted either way would show a wrong
 * command centre for the first paint.
 */

function mount(runtime = createScriptedRuntime()) {
  return {
    runtime,
    ...renderHook(() => useAgentRuntime({ client: runtime.client, poll: false })),
  }
}

describe("the handshake", () => {
  it("starts with nothing and admits it", () => {
    const { result } = mount()

    // Synchronously, before any reply has landed.
    expect(result.current.status).toBeNull()
    expect(result.current.executable).toBe(false)
    expect(result.current.loading).toBe(true)
  })

  it("asks the host for its status", async () => {
    const { result, runtime } = mount()

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(runtime.commands[0]?.name).toBe("get_status")
    expect(result.current.executable).toBe(true)
  })

  it("reports a refused runtime as not executable, without inventing a reason", async () => {
    const runtime = createScriptedRuntime({
      status: scriptedStatus({
        executable: false,
        environment: "hosted",
        detail: "Agents cannot run on a hosted TabDump deployment.",
      }),
    })
    const { result } = mount(runtime)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.executable).toBe(false)
    expect(result.current.status?.detail).toBe("Agents cannot run on a hosted TabDump deployment.")
  })
})

describe("failure", () => {
  it("clears the status rather than keeping a stale one", async () => {
    const runtime = createScriptedRuntime()
    const { result } = mount(runtime)
    await waitFor(() => expect(result.current.executable).toBe(true))

    runtime.failCommand("get_status", "runtime_disconnected")
    await act(async () => {
      await result.current.refresh()
    })

    // A stale "ready" beside a failed handshake would be the UI asserting
    // something it has just been told is untrue.
    expect(result.current.status).toBeNull()
    expect(result.current.executable).toBe(false)
    expect(result.current.error).toBe("runtime_disconnected")
  })

  it("recovers when the host comes back", async () => {
    const runtime = createScriptedRuntime()
    runtime.failCommand("get_status", "runtime_disconnected")
    const { result } = mount(runtime)

    await waitFor(() => expect(result.current.error).toBe("runtime_disconnected"))

    runtime.clearFailure("get_status")
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.error).toBeNull()
    expect(result.current.executable).toBe(true)
  })
})

describe("the client", () => {
  it("is stable across renders so the handshake is not discarded", async () => {
    const runtime = createScriptedRuntime()
    const { result, rerender } = renderHook(() =>
      useAgentRuntime({ client: runtime.client, poll: false })
    )

    const first = result.current.client
    rerender()
    // A replaced client would forget the host's generation and silently
    // re-negotiate on the next command.
    expect(result.current.client).toBe(first)
  })
})
