"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { readHistoryDetail, readHistoryPage } from "@/lib/agents/activity/history"
import type { AgentHistoryCursor, AgentHistoryDetail, AgentHistorySession } from "@/lib/agents/activity/history"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeCommand, RuntimeCommandName, RuntimeCommandResult, RuntimeErrorCode } from "@/lib/agents/runtime/protocol"

/**
 * Agent history for the workspace on screen: its recent sessions, a page at
 * a time, and one session's records when it is opened.
 *
 * ## Asked for, not polled
 *
 * History changes only when a session changes, and the live list already
 * polls for that. So the list is read when the workspace changes and when the
 * caller's `refreshKey` does (the Command Centre derives it from which live
 * sessions exist and how they stand), and never on a timer. A session is read
 * once when it is opened, and again only when the person asks.
 *
 * ## Unavailable is not empty
 *
 * `unavailable` means this Hubble keeps no history — no database, or the
 * desktop app's sidecar — and the UI says so. `ready` with no sessions means
 * history is kept and there is none yet. `failed` is a request that did not
 * come back, and can be retried. The three never collapse into one blank list.
 *
 * Everything that arrives is revalidated (`readHistoryPage`,
 * `readHistoryDetail`) before it is shown — the browser trusts the wire no
 * more than the runtime trusts the database.
 *
 * ## No state set in an effect
 *
 * "Idle" and "loading" are derived from what is being asked for; the only
 * state either hook sets is an answer, when it arrives — so a workspace
 * switch never renders the old workspace's history under the new name, and
 * a refresh keeps the list on screen until the new one is in.
 */

export type AgentHistoryListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  /**
   * The runtime cannot be reached right now — set by the host, never by this
   * hook. Not "unavailable": this Hubble may well keep history; it just
   * cannot be asked until the runtime is back.
   */
  | { kind: "disconnected" }
  | { kind: "failed" }
  | { kind: "ready"; workspaceId: string; sessions: readonly AgentHistorySession[]; hasMore: boolean; loadingMore: boolean }

export type AgentHistorySessionState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  /** Not this workspace's, not this account's, or gone. */
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; detail: AgentHistoryDetail }

/** Codes that mean "this Hubble cannot show history at all", as opposed to "that request failed". */
const UNAVAILABLE: ReadonlySet<RuntimeErrorCode> = new Set(["history_unavailable", "runtime_unavailable"])

/**
 * One command, re-handshaking once if the runtime it was addressed to is gone.
 *
 * History is exactly what a person opens after the runtime restarted — and a
 * page that was open across that restart still holds the old runtime's id, so
 * its first read is refused as `runtime_disconnected`. Learning the new
 * runtime's id and asking again is the honest recovery: history lives in the
 * database, not in the runtime that went away. Once, so a runtime that is
 * really unreachable still fails.
 */
async function sendAfterHandshake<N extends RuntimeCommandName>(
  client: RuntimeClient,
  command: Extract<RuntimeCommand, { name: N }>
): Promise<RuntimeCommandResult<N>> {
  const result = await client.send(command)
  if (result.ok || result.error.code !== "runtime_disconnected") return result
  const status = await client.status()
  return status.ok ? client.send(command) : result
}

const IDLE = { kind: "idle" } as const
const LOADING = { kind: "loading" } as const

export function useAgentHistory(options: {
  client: RuntimeClient
  /** The workspace whose history is shown. Absent: nothing is read. */
  workspaceId: string | undefined
  /** False while the runtime is not known to be reachable; nothing is read. */
  enabled: boolean
  /** Changes when history may have — a session ended, or one appeared. */
  refreshKey?: string
}): { state: AgentHistoryListState; loadMore: () => void; retry: () => void } {
  const { client, workspaceId, enabled, refreshKey } = options
  const [attempt, setAttempt] = useState(0)
  const requestKey = enabled && workspaceId ? `${workspaceId}\u0000${refreshKey ?? ""}\u0000${attempt}` : null
  const [loaded, setLoaded] = useState<{ workspaceId: string; key: string; state: AgentHistoryListState } | null>(null)
  const next = useRef<AgentHistoryCursor | undefined>(undefined)
  /** Which read is current, so an answer to an older one is dropped. */
  const generation = useRef(0)

  useEffect(() => {
    if (!requestKey || !workspaceId) return
    const mine = ++generation.current
    void sendAfterHandshake(client, { name: "list_history", workspaceId }).then((result) => {
      if (generation.current !== mine) return
      if (!result.ok) {
        setLoaded({ workspaceId, key: requestKey, state: UNAVAILABLE.has(result.error.code) ? { kind: "unavailable" } : { kind: "failed" } })
        return
      }
      const page = readHistoryPage(result.value)
      next.current = page?.next
      setLoaded({
        workspaceId,
        key: requestKey,
        state: page ? { kind: "ready", workspaceId, sessions: page.sessions, hasMore: Boolean(page.next), loadingMore: false } : { kind: "failed" },
      })
    })
  }, [client, requestKey, workspaceId])

  const state: AgentHistoryListState = !requestKey
    ? IDLE
    : loaded && loaded.workspaceId === workspaceId && (loaded.key === requestKey || loaded.state.kind === "ready")
      ? loaded.state
      : LOADING

  const loadMore = useCallback(() => {
    const before = next.current
    if (!before || !workspaceId) return
    const mine = generation.current
    const patch = (update: (current: Extract<AgentHistoryListState, { kind: "ready" }>) => AgentHistoryListState) =>
      setLoaded((current) => (current && current.state.kind === "ready" && current.workspaceId === workspaceId ? { ...current, state: update(current.state) } : current))
    patch((current) => ({ ...current, loadingMore: true }))
    void sendAfterHandshake(client, { name: "list_history", workspaceId, before }).then((result) => {
      if (generation.current !== mine) return
      const page = result.ok ? readHistoryPage(result.value) : null
      if (!page) {
        patch((current) => ({ ...current, loadingMore: false }))
        return
      }
      next.current = page.next
      patch((current) => {
        const known = new Set(current.sessions.map((session) => session.sessionId))
        return {
          ...current,
          sessions: [...current.sessions, ...page.sessions.filter((session) => !known.has(session.sessionId))],
          hasMore: Boolean(page.next),
          loadingMore: false,
        }
      })
    })
  }, [client, workspaceId])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  return { state, loadMore, retry }
}

export function useHistorySession(options: {
  client: RuntimeClient
  workspaceId: string | undefined
  sessionId: string | null
}): {
  state: AgentHistorySessionState
  retry: () => void
  /**
   * Records an undo the person just made — after the workspace was restored —
   * and shows it at once. `false` when history did not take it; the workspace
   * restore stands either way, because it already happened.
   */
  recordUndo: (changeId: string) => Promise<boolean>
} {
  const { client, workspaceId, sessionId } = options
  const [attempt, setAttempt] = useState(0)
  const requestKey = workspaceId && sessionId ? `${workspaceId}\u0000${sessionId}\u0000${attempt}` : null
  const [loaded, setLoaded] = useState<{ key: string; state: AgentHistorySessionState } | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!requestKey || !workspaceId || !sessionId) return
    const mine = ++generation.current
    void sendAfterHandshake(client, { name: "get_history", workspaceId, sessionId }).then((result) => {
      if (generation.current !== mine) return
      if (!result.ok) {
        const code = result.error.code
        setLoaded({
          key: requestKey,
          state: UNAVAILABLE.has(code) ? { kind: "unavailable" } : code === "session_not_found" ? { kind: "missing" } : { kind: "failed" },
        })
        return
      }
      const detail = readHistoryDetail(result.value)
      // A session that does not read, or that is not the one asked for in
      // this workspace, is not shown.
      const fits = detail && detail.session.sessionId === sessionId && detail.session.workspaceId === workspaceId
      setLoaded({ key: requestKey, state: fits ? { kind: "ready", detail } : { kind: "failed" } })
    })
  }, [client, requestKey, workspaceId, sessionId])

  const state: AgentHistorySessionState = !requestKey ? IDLE : loaded?.key === requestKey ? loaded.state : LOADING

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  const recordUndo = useCallback(
    async (changeId: string): Promise<boolean> => {
      if (!workspaceId || !sessionId || !requestKey) return false
      const at = Date.now()
      // The new fact, shown at once — the workspace is already restored — and
      // appended, never written over the change. Then kept.
      setLoaded((current) =>
        current?.key === requestKey && current.state.kind === "ready"
          ? {
              key: requestKey,
              state: {
                kind: "ready",
                detail: { ...current.state.detail, records: { ...current.state.detail.records, undos: [...current.state.detail.records.undos, { changeId, at }] } },
              },
            }
          : current
      )
      const result = await sendAfterHandshake(client, { name: "record_workspace_undo", workspaceId, sessionId, changeId, at })
      return result.ok
    },
    [client, workspaceId, sessionId, requestKey]
  )

  return useMemo(() => ({ state, retry, recordUndo }), [state, retry, recordUndo])
}
