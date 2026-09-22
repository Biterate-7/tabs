import { describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useAgentSession, MAX_RETAINED_EVENTS } from "./use-agent-session"
import {
  createScriptedRuntime,
  scriptedEvent,
  scriptedSession,
} from "@/lib/agents/command-centre/__fixtures__/runtime-client"

/**
 * The event transport, tested at the seam the components cannot reach.
 *
 * The rendered surface proves that the stream *appears*; these prove the
 * properties that keep it correct over a long run — the cursor, the bound, and
 * the difference between a session that ended and a poll that failed.
 */

function mount(sessionId: string | null, runtime = createScriptedRuntime()) {
  return {
    runtime,
    ...renderHook(() =>
      useAgentSession({
        client: runtime.client,
        sessionId,
        executable: true,
        poll: false,
      })
    ),
  }
}

describe("the cursor", () => {
  it("starts at zero and advances to the latest sequence", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    runtime.pushEvents([scriptedEvent({ id: "e1" }), scriptedEvent({ id: "e2" })])

    const { result } = mount("session-1", runtime)
    await waitFor(() => expect(result.current.events).toHaveLength(2))

    const reads = runtime.commands.filter(
      (command): command is Extract<typeof command, { name: "get_events" }> =>
        command.name === "get_events"
    )
    expect(reads[0]!.afterSequence).toBe(0)

    runtime.pushEvents([scriptedEvent({ id: "e3" })])
    await act(async () => {
      await result.current.refresh()
    })

    const later = runtime.commands.filter(
      (command): command is Extract<typeof command, { name: "get_events" }> =>
        command.name === "get_events"
    )
    expect(later[later.length - 1]!.afterSequence).toBe(2)
    expect(result.current.events).toHaveLength(3)
  })

  it("delivers no event twice across repeated reads", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    runtime.pushEvents([scriptedEvent({ id: "e1" })])

    const { result } = mount("session-1", runtime)
    await waitFor(() => expect(result.current.events).toHaveLength(1))

    await act(async () => {
      await result.current.refresh()
      await result.current.refresh()
    })

    // The specific failure this guards: an approval row replayed on every poll
    // would re-open a decision the user already answered.
    expect(result.current.events).toHaveLength(1)
  })

  it("resets when the session changes", async () => {
    const runtime = createScriptedRuntime({
      sessions: [scriptedSession({ sessionId: "session-1" }), scriptedSession({ sessionId: "session-2" })],
    })
    runtime.pushEvents([scriptedEvent({ id: "e1" })])

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useAgentSession({ client: runtime.client, sessionId, executable: true, poll: false }),
      { initialProps: { sessionId: "session-1" } }
    )

    await waitFor(() => expect(result.current.events).toHaveLength(1))

    rerender({ sessionId: "session-2" })

    await waitFor(() => {
      const reads = runtime.commands.filter(
        (command): command is Extract<typeof command, { name: "get_events" }> =>
          command.name === "get_events"
      )
      const last = reads[reads.length - 1]!
      expect(last.sessionId).toBe("session-2")
      expect(last.afterSequence).toBe(0)
    })
  })
})

describe("the retained window", () => {
  it("keeps the newest events and drops the oldest", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    runtime.pushEvents(
      Array.from({ length: MAX_RETAINED_EVENTS + 25 }, (_, index) =>
        scriptedEvent({ id: `e${index}`, summary: `Event ${index}` })
      )
    )

    const { result } = mount("session-1", runtime)

    // A long run is unbounded; the DOM is not. The journal on the runtime side
    // keeps the full record.
    await waitFor(() => expect(result.current.events).toHaveLength(MAX_RETAINED_EVENTS))
    expect(result.current.events[result.current.events.length - 1]!.summary).toBe(
      `Event ${MAX_RETAINED_EVENTS + 24}`
    )
  })
})

describe("failures are distinguished from endings", () => {
  it("clears the session when the runtime says it is gone", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const { result } = mount("session-1", runtime)
    await waitFor(() => expect(result.current.session).not.toBeNull())

    runtime.failCommand("get_session", "session_not_found")
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.session).toBeNull()
    expect(result.current.error).toBe("session_not_found")
  })

  it("keeps the session on a transient failure", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const { result } = mount("session-1", runtime)
    await waitFor(() => expect(result.current.session).not.toBeNull())

    // One dropped poll must not blank a working session.
    runtime.failCommand("get_session", "timeout")
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.session).not.toBeNull()
    expect(result.current.error).toBe("timeout")
  })

  it("returns the refusal code rather than throwing", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    const { result } = mount("session-1", runtime)
    await waitFor(() => expect(result.current.session).not.toBeNull())

    runtime.failCommand("send_message", "permission_denied")

    let outcome: Awaited<ReturnType<typeof result.current.sendMessage>> | undefined
    await act(async () => {
      outcome = await result.current.sendMessage("do something")
    })

    expect(outcome).toEqual({ ok: false, code: "permission_denied" })
  })
})

describe("a runtime that cannot execute is not polled", () => {
  it("issues no command at all", async () => {
    const runtime = createScriptedRuntime({ sessions: [scriptedSession()] })
    renderHook(() =>
      useAgentSession({
        client: runtime.client,
        sessionId: "session-1",
        executable: false,
        poll: false,
      })
    )

    await waitFor(() => expect(runtime.commands).toHaveLength(0))
  })
})

describe("no session selected", () => {
  it("holds nothing and sends nothing", async () => {
    const runtime = createScriptedRuntime()
    const { result } = mount(null, runtime)

    expect(result.current.session).toBeNull()
    expect(result.current.events).toHaveLength(0)

    let outcome: Awaited<ReturnType<typeof result.current.sendMessage>> | undefined
    await act(async () => {
      outcome = await result.current.sendMessage("hello")
    })

    expect(outcome).toEqual({ ok: false, code: "session_not_found" })
    expect(runtime.commands).toHaveLength(0)
  })
})
