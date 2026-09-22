"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isLiveSession } from "@/lib/agents/command-centre/presentation"
import type { AgentAttachedContext } from "@/lib/agents/control/context"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type {
  RuntimeApprovalView,
  RuntimeErrorCode,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol"

/**
 * One session: its state, its approvals, its event stream, and the verbs that
 * act on it.
 *
 * ## The transport is an implementation detail of this file
 *
 * Phase F delivers events by polling `get_events` with a cursor. Nothing above
 * this hook knows that. Components receive an array that grows and a couple of
 * async functions, which is the same shape they would receive from a
 * subscription — so replacing the transport later is a change here and nowhere
 * else. That is the whole reason this is a hook rather than a `useEffect` in a
 * component.
 *
 * ## Why the cursor is the only thing that drives the stream
 *
 * `get_events` takes `afterSequence` and the host assigns `sequence` itself —
 * not the adapter, not the provider, and not a timestamp. Asking only for what
 * is past the cursor makes a repeated poll cheap *and* makes duplicate
 * delivery impossible, which matters for approvals: an approval row replayed
 * on every poll would re-open a decision the user already made.
 *
 * Both the cursor and the event list are stamped with the session they belong
 * to, so a stream is never inherited: state from another session simply is not
 * this session's state. See the stamping note below.
 *
 * ## Why the poll rate is not constant
 *
 * A session that is `running` is interesting every second; one that completed
 * an hour ago will not change again. Polling both at the same rate means
 * either a sluggish live stream or a pointless request every second for every
 * terminal session on screen. So the interval follows the state machine's own
 * answer — `isLiveSession` — and a terminal session settles to a slow
 * heartbeat that would still notice a host restart.
 */

export const LIVE_POLL_INTERVAL_MS = 1_000
export const IDLE_POLL_INTERVAL_MS = 5_000

/**
 * How many events are kept in memory.
 *
 * A long agent run is unbounded and the DOM is not. The window keeps the most
 * recent events, which is where the conversation is; the full record is the
 * runtime's journal, not this array.
 */
export const MAX_RETAINED_EVENTS = 500

export type SendOutcome = { ok: true } | { ok: false; code: RuntimeErrorCode }

/**
 * Everything the stream holds, stamped with the session it belongs to.
 *
 * ## Why one stamped object rather than five separate states
 *
 * A session's stream must never inherit another's. The obvious way to get that
 * is an effect that clears five pieces of state when `sessionId` changes — but
 * an effect runs *after* the render that has already shown the old session's
 * events under the new session's header, which is a real flash and not merely
 * a lint complaint.
 *
 * Stamping makes the reset a derivation instead: state belonging to a different
 * session simply is not this session's state, and the derived view is empty for
 * it on the very first render. Nothing has to remember to clear anything.
 */
type SessionData = {
  sessionId: string | null
  session: RuntimeSessionView | null
  events: readonly SequencedControlEvent[]
  approvals: readonly RuntimeApprovalView[]
  loading: boolean
  error: RuntimeErrorCode | null
}

/** At module scope so its identity is stable and it can be a hook dependency. */
function emptyData(id: string | null): SessionData {
  return {
    sessionId: id,
    session: null,
    events: [],
    approvals: [],
    loading: id !== null,
    error: null,
  }
}

export type AgentSessionApi = {
  /** `null` while loading, or when the session is gone. */
  session: RuntimeSessionView | null
  events: readonly SequencedControlEvent[]
  approvals: readonly RuntimeApprovalView[]
  loading: boolean
  error: RuntimeErrorCode | null
  /** Set while a user-initiated command is in flight, so controls can disable. */
  pending: boolean
  sendMessage: (text: string, context?: AgentAttachedContext) => Promise<SendOutcome>
  cancelRun: () => Promise<SendOutcome>
  respondToApproval: (approvalId: string, decision: "granted" | "denied") => Promise<SendOutcome>
  attachContext: (context: AgentAttachedContext) => Promise<SendOutcome>
  detachContext: () => Promise<SendOutcome>
  refresh: () => Promise<void>
}

export function useAgentSession(options: {
  client: RuntimeClient
  /** `null` when nothing is selected — the command centre's empty state. */
  sessionId: string | null
  executable: boolean
  poll?: boolean
  livePollIntervalMs?: number
  idlePollIntervalMs?: number
}): AgentSessionApi {
  const {
    client,
    sessionId,
    executable,
    poll = true,
    livePollIntervalMs = LIVE_POLL_INTERVAL_MS,
    idlePollIntervalMs = IDLE_POLL_INTERVAL_MS,
  } = options

  const [data, setData] = useState<SessionData>(() => emptyData(sessionId))
  const [pending, setPending] = useState(false)

  const current = data.sessionId === sessionId ? data : emptyData(sessionId)

  /*
    The cursor lives in a ref, not in state, and carries the session it counts
    for.

    A poll must read the newest cursor at the moment it runs: state captured in
    the interval's closure would be the value from the render that created the
    interval, so every poll would re-request the same window and the stream
    would repeat itself. The session stamp is what stops a cursor from one
    session being applied to another's journal.
  */
  const cursorRef = useRef<{ sessionId: string | null; sequence: number }>({
    sessionId: null,
    sequence: 0,
  })
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!sessionId || !executable) return

    /** Folds an update into whatever belongs to *this* session, or starts fresh. */
    const update = (change: (previous: SessionData) => Partial<SessionData>) =>
      setData((previous) => {
        const base = previous.sessionId === sessionId ? previous : emptyData(sessionId)
        return { ...base, ...change(base), sessionId }
      })

    const viewResult = await client.send({ name: "get_session", sessionId })
    if (!mountedRef.current) return

    if (!viewResult.ok) {
      // The view is cleared on `session_not_found` — the session really is
      // gone — but kept on a transient failure, so one dropped poll does not
      // blank a working session.
      update((previous) => ({
        loading: false,
        error: viewResult.error.code,
        session: viewResult.error.code === "session_not_found" ? null : previous.session,
      }))
      return
    }

    update(() => ({
      loading: false,
      error: null,
      session: viewResult.value.session,
      approvals: viewResult.value.approvals,
    }))

    const cursor =
      cursorRef.current.sessionId === sessionId ? cursorRef.current.sequence : 0

    const eventsResult = await client.send({
      name: "get_events",
      sessionId,
      afterSequence: cursor,
    })
    if (!mountedRef.current) return

    if (!eventsResult.ok) {
      update(() => ({ error: eventsResult.error.code }))
      return
    }

    if (eventsResult.value.events.length === 0) return

    cursorRef.current = { sessionId, sequence: eventsResult.value.latestSequence }

    update((previous) => {
      const next = [...previous.events, ...eventsResult.value.events]
      return {
        events: next.length > MAX_RETAINED_EVENTS ? next.slice(-MAX_RETAINED_EVENTS) : next,
      }
    })
  }, [client, sessionId, executable])

  /*
    The poll.

    Keyed on the session's status so the interval is re-established at the
    right rate when a run starts or ends — a live session polls every second,
    a settled one every five.
  */
  const live = current.session ? isLiveSession(current.session.status) : false

  useEffect(() => {
    if (!sessionId || !executable) return

    /*
      Synchronizing with an external system on mount, which is what effects are
      for: a session's state and its journal are the runtime host's to report,
      and there is no way to derive either during render.
    */
    void refresh()

    if (!poll) return
    const interval = live ? livePollIntervalMs : idlePollIntervalMs
    const timer = setInterval(() => void refresh(), interval)
    return () => clearInterval(timer)
  }, [refresh, sessionId, executable, poll, live, livePollIntervalMs, idlePollIntervalMs])

  /**
   * Runs one user-initiated command.
   *
   * Every verb below goes through here so that three things are guaranteed
   * identically for all of them: the control is disabled while it is in
   * flight, a refusal becomes a typed code rather than a thrown error, and the
   * session is re-read immediately afterwards rather than waiting up to a
   * poll interval to show what the command did.
   */
  const run = useCallback(
    async (command: () => Promise<{ ok: boolean; error?: { code: RuntimeErrorCode } }>) => {
      setPending(true)
      try {
        const result = await command()
        if (!result.ok) {
          const code = result.error?.code ?? "invalid_request"
          if (mountedRef.current) {
            setData((previous) => ({ ...previous, error: code }))
          }
          return { ok: false as const, code }
        }

        await refresh()
        return { ok: true as const }
      } finally {
        if (mountedRef.current) setPending(false)
      }
    },
    [refresh]
  )

  const sendMessage = useCallback(
    (text: string, context?: AgentAttachedContext) => {
      if (!sessionId) return Promise.resolve({ ok: false as const, code: "session_not_found" as const })
      return run(() =>
        client.send({
          name: "send_message",
          sessionId,
          text,
          ...(context ? { context } : {}),
        })
      )
    },
    [client, run, sessionId]
  )

  const cancelRun = useCallback(() => {
    if (!sessionId) return Promise.resolve({ ok: false as const, code: "session_not_found" as const })
    return run(() => client.send({ name: "cancel_run", sessionId }))
  }, [client, run, sessionId])

  const respondToApproval = useCallback(
    (approvalId: string, decision: "granted" | "denied") =>
      run(() => client.send({ name: "respond_to_approval", approvalId, decision })),
    [client, run]
  )

  const attachContext = useCallback(
    (context: AgentAttachedContext) => {
      if (!sessionId) return Promise.resolve({ ok: false as const, code: "session_not_found" as const })
      return run(() => client.send({ name: "attach_context", sessionId, context }))
    },
    [client, run, sessionId]
  )

  const detachContext = useCallback(() => {
    if (!sessionId) return Promise.resolve({ ok: false as const, code: "session_not_found" as const })
    return run(() => client.send({ name: "detach_context", sessionId }))
  }, [client, run, sessionId])

  return useMemo(
    () => ({
      session: current.session,
      events: current.events,
      approvals: current.approvals,
      loading: current.loading,
      error: current.error,
      pending,
      sendMessage,
      cancelRun,
      respondToApproval,
      attachContext,
      detachContext,
      refresh,
    }),
    [
      current,
      pending,
      sendMessage,
      cancelRun,
      respondToApproval,
      attachContext,
      detachContext,
      refresh,
    ]
  )
}
