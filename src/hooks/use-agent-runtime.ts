"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRuntimeClient } from "@/lib/agents/runtime/client"
import { agentRuntimeTransport } from "@/lib/platform"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeErrorCode, RuntimeStatus } from "@/lib/agents/runtime/protocol"

/**
 * The command centre's handle on the local runtime.
 *
 * ## What this hook is, and what it deliberately is not
 *
 * It owns exactly two things: one `RuntimeClient` for the lifetime of the
 * mount, and the most recent `get_status` reply. That is the whole ambition.
 *
 * It is **not** a store of runtime state. Nothing here caches a session, a
 * project or an event, and nothing here decides whether an operation is
 * allowed — the host re-derives every one of those on its own side, and a
 * cached copy in the browser would only be a second opinion that is sometimes
 * wrong. `client.ts` says the same thing about itself and for the same reason.
 *
 * ## Why the transport is invisible above this line
 *
 * Every consumer receives `status` and a `send`-shaped function. None of them
 * can tell that events arrive by polling rather than by a stream, which is the
 * property the brief asks for: when Phase F's transport grows a subscription,
 * this file changes and the components do not.
 *
 * ## The honesty rule
 *
 * `status` starts as `null` and means "we have not been told yet" — never
 * "unavailable" and never "ready". The banner renders a third state for it.
 * A hook that defaulted to an optimistic status would show a working command
 * centre for one paint on a build that cannot run agents at all, which is
 * precisely the fake success state the brief forbids.
 */

/** How often the status is re-read. Slow: this answer changes on a restart, not on a keystroke. */
export const STATUS_POLL_INTERVAL_MS = 15_000

export type AgentRuntimeApi = {
  /**
   * The last status the host gave, or `null` before the first reply.
   *
   * `null` is a real state, not a loading placeholder — see the honesty rule
   * above.
   */
  status: RuntimeStatus | null
  /** True until the first reply of any kind arrives. */
  loading: boolean
  /** Why the last handshake failed, when it did. */
  error: RuntimeErrorCode | null
  /**
   * Whether commands can be sent at all.
   *
   * Read from `status.executable`, which the server-side gate decided. This
   * hook performs no sniffing of its own: no user agent, no hostname, no
   * `NODE_ENV`, no Tauri global.
   */
  executable: boolean
  /** The typed command channel. The only way anything reaches the control plane. */
  client: RuntimeClient
  /** Re-runs the handshake now. Used by the reconnect affordance and after a disconnect. */
  refresh: () => Promise<void>
}

export type UseAgentRuntimeOptions = {
  /** Injected in tests so no network and no timer is real. */
  client?: RuntimeClient
  pollIntervalMs?: number
  /** Off in tests that drive the handshake by hand. */
  poll?: boolean
}

export function useAgentRuntime(options: UseAgentRuntimeOptions = {}): AgentRuntimeApi {
  const { pollIntervalMs = STATUS_POLL_INTERVAL_MS, poll = true } = options

  /*
    One client for the mount.

    It holds the host's `runtimeId`, so replacing it would silently discard the
    handshake and make the next command re-negotiate. `useState` with an
    initialiser rather than `useMemo`, because React is explicitly allowed to
    discard a `useMemo` and re-run it, and a second client would address a
    session set the first one had already been told about.
  */
  const [client] = useState<RuntimeClient>(() => {
    if (options.client) return options.client
    // The desktop app's runtime is its bundled sidecar, reached through the
    // Tauri shell rather than an HTTP route (Phase J.1). Same client above it.
    const post = agentRuntimeTransport()
    return createRuntimeClient(post ? { post } : {})
  })

  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<RuntimeErrorCode | null>(null)

  /*
    Guards every `setState` that follows an await.

    A status poll that resolves after the command centre has been navigated
    away from would otherwise warn and, worse, resurrect a status for a
    surface that is gone.
  */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const result = await client.status()
    if (!mountedRef.current) return

    setLoading(false)

    if (result.ok) {
      setStatus(result.value)
      setError(null)
      return
    }

    // The status is cleared rather than kept. A stale "ready" beside a failed
    // handshake would be the UI asserting something it has just been told is
    // not true.
    setStatus(null)
    setError(result.error.code)
  }, [client])

  useEffect(() => {
    /*
      Synchronizing with an external system on mount, which is what effects are
      for: the host status is the runtime host's to report, and there is no way to
      derive it during render. Same reasoning, and same directive, as
      AuthProvider's hydrate-on-mount effect.
    */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()

    if (!poll) return
    const timer = setInterval(() => void refresh(), pollIntervalMs)
    return () => clearInterval(timer)
  }, [refresh, poll, pollIntervalMs])

  return useMemo(
    () => ({
      status,
      loading,
      error,
      executable: status?.executable === true,
      client,
      refresh,
    }),
    [status, loading, error, client, refresh]
  )
}
