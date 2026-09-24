"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { sessionOrigin } from "@/lib/agents/command-centre/presentation"
import type { SessionOrigin } from "@/lib/agents/command-centre/presentation"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentAttachedContext } from "@/lib/agents/control/context"
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type {
  RuntimeCorrelationView,
  RuntimeErrorCode,
  RuntimeSessionView,
} from "@/lib/agents/runtime/protocol"

/**
 * Every session this runtime knows about, and the two lifecycle verbs.
 *
 * ## Why the list is polled rather than accumulated locally
 *
 * A session can change without this browser having asked it to: a run ends, an
 * approval expires, the host restarts and loses the lot. A list built by
 * appending what `create_session` returned would drift from the runtime within
 * one turn and would keep showing sessions that no longer exist.
 *
 * So the runtime's answer to `list_sessions` *is* the list. Local state holds
 * only which one the user is looking at, which is genuinely a UI fact.
 *
 * ## Correlation is carried, not computed
 *
 * `list_sessions` returns correlations beside the sessions, and they are
 * joined here only by the ids the host already put in them. This hook never
 * infers that a session is controlled because a provider exists, or that an
 * observed run belongs to a control session because their timestamps are
 * close. The brief is explicit that the two planes stay separate, and the only
 * thing that joins them is the provider session identity the host recorded.
 */

/** How often the list is re-read while the command centre is open. */
export const SESSION_POLL_INTERVAL_MS = 4_000

/** A session with the correlation the host reported for it, if any. */
export type CommandCentreSession = {
  view: RuntimeSessionView
  correlation?: RuntimeCorrelationView
  origin: SessionOrigin
}

export type CreateSessionInput = {
  provider: AgentProviderId
  /** By id. There is no field for a path, here or in the protocol. */
  projectId?: string
  workspaceId?: string
  title?: string
  context?: AgentAttachedContext
  /** The workspace the session is started from, for the agent to query (Phase J.3). */
  contextSnapshot?: SessionContextSnapshot
}

export type AgentSessionsApi = {
  sessions: readonly CommandCentreSession[]
  loading: boolean
  error: RuntimeErrorCode | null
  /** Resolves to the new session's id, or `null` when the runtime refused. */
  createSession: (input: CreateSessionInput) => Promise<{ sessionId: string } | RuntimeErrorCode>
  disposeSession: (sessionId: string) => Promise<void>
  refresh: () => Promise<void>
}

export function useAgentSessions(options: {
  client: RuntimeClient
  executable: boolean
  /** Re-lists when the host generation changes, because its sessions did too. */
  runtimeId?: string
  pollIntervalMs?: number
  poll?: boolean
}): AgentSessionsApi {
  const {
    client,
    executable,
    runtimeId,
    pollIntervalMs = SESSION_POLL_INTERVAL_MS,
    poll = true,
  } = options

  const [sessions, setSessions] = useState<readonly CommandCentreSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<RuntimeErrorCode | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!executable) {
      // Not an error: a build that cannot execute has no sessions, and saying
      // so is different from failing to ask.
      setSessions([])
      setLoading(false)
      setError(null)
      return
    }

    const result = await client.send({ name: "list_sessions" })
    if (!mountedRef.current) return

    setLoading(false)

    if (!result.ok) {
      setError(result.error.code)
      setSessions([])
      return
    }

    setError(null)

    /*
      Joined by control session id, which is the only key the host guarantees
      on a correlation that came from the control side. A correlation that has
      only a `providerSessionId` belongs to an externally-started run and is
      deliberately not matched to anything here.
    */
    const byControlSession = new Map<string, RuntimeCorrelationView>()
    for (const correlation of result.value.correlations) {
      if (correlation.controlSessionId) {
        byControlSession.set(correlation.controlSessionId, correlation)
      }
    }

    setSessions(
      result.value.sessions.map((view) => {
        const correlation = byControlSession.get(view.sessionId)
        return {
          view,
          ...(correlation ? { correlation } : {}),
          origin: sessionOrigin({
            ...(correlation?.controlRunId ? { controlRunId: correlation.controlRunId } : {}),
            ...(correlation?.observationRunId
              ? { observationRunId: correlation.observationRunId }
              : {}),
          }),
        }
      })
    )
  }, [client, executable])

  useEffect(() => {
    /*
      Synchronizing with an external system on mount, which is what effects are
      for: the session list is the runtime host's to report, and there is no way to
      derive it during render. Same reasoning, and same directive, as
      AuthProvider's hydrate-on-mount effect.
    */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()

    if (!poll || !executable) return
    const timer = setInterval(() => void refresh(), pollIntervalMs)
    return () => clearInterval(timer)
  }, [refresh, poll, executable, pollIntervalMs, runtimeId])

  const createSession = useCallback(
    async (input: CreateSessionInput) => {
      const result = await client.send({
        name: "create_session",
        provider: input.provider,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.contextSnapshot ? { contextSnapshot: input.contextSnapshot } : {}),
      })

      if (!result.ok) return result.error.code

      // Listed again rather than appended: the reply is one session's view,
      // and the list may have moved for other reasons in the same window.
      await refresh()
      return { sessionId: result.value.sessionId }
    },
    [client, refresh]
  )

  const disposeSession = useCallback(
    async (sessionId: string) => {
      await client.send({ name: "dispose_session", sessionId })
      await refresh()
    },
    [client, refresh]
  )

  return useMemo(
    () => ({ sessions, loading, error, createSession, disposeSession, refresh }),
    [sessions, loading, error, createSession, disposeSession, refresh]
  )
}
