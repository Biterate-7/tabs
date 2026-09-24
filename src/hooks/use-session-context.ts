"use client"

import { useCallback, useEffect, useRef } from "react"
import { isTerminalSession } from "@/lib/agents/command-centre/presentation"
import { buildSessionContextSnapshot } from "@/lib/agents/session-context/snapshot"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { Collection } from "@/lib/collections/types"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot"

/**
 * The Command Centre's half of session workspace context (Phase J.3).
 *
 * TabDump's workspace lives here, in the app, so the webview is what hands the
 * runtime a session's workspace — and what applies a change the user approved:
 *
 *   - **At start**, `snapshotFor(workspaceId)` is sent with `create_session`.
 *     The runtime binds the session to that workspace and decides what the
 *     agent may do with it from the session's grant.
 *   - **While a session lives**, its workspace is re-sent when it changes —
 *     *its own* workspace, by the id the runtime reports, never whichever one
 *     the user is looking at now. The runtime refuses any other.
 *   - **When the user approves a change**, the runtime lists it on the
 *     session; this applies it with the same collection store the workspace
 *     view uses, then reports the outcome. Nothing is applied that the
 *     runtime does not list, and the runtime lists only approved changes.
 *
 * No prompt is built here and nothing is sent to an agent. There is no
 * credential anywhere in this hook: the protocol has no field for one.
 */

const SYNC_DEBOUNCE_MS = 400

export function useSessionContext(options: {
  client: RuntimeClient
  sessions: readonly CommandCentreSession[]
  world: AgentContextWorld
  /** The Command Centre's collection store — the live copy, not the one the world was loaded with. */
  collections: readonly Collection[]
  createCollection: (workspaceId: string, name: string, tabIds: string[]) => Collection
}): { snapshotFor: (workspaceId: string) => SessionContextSnapshot | undefined } {
  const { client, sessions, world, collections, createCollection } = options

  const snapshotFor = useCallback(
    (workspaceId: string) =>
      buildSessionContextSnapshot(
        { workspaces: world.workspaces, collections, dependencies: world.dependencies },
        workspaceId
      ),
    [collections, world.dependencies, world.workspaces]
  )

  /* ---------------- Keep each live session's own workspace current. */

  const sent = useRef(new Map<string, string>())
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const { view } of sessions) {
        if (!view.context || isTerminalSession(view.status)) continue
        const snapshot = snapshotFor(view.context.workspaceId)
        if (!snapshot) continue
        const encoded = JSON.stringify(snapshot)
        if (sent.current.get(view.sessionId) === encoded) continue
        sent.current.set(view.sessionId, encoded)
        void client.send({ name: "sync_session_context", sessionId: view.sessionId, snapshot })
      }
    }, SYNC_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [client, sessions, snapshotFor])

  /* ---------------- Apply what the user approved, exactly once. */

  const applied = useRef(new Set<string>())
  useEffect(() => {
    for (const { view } of sessions) {
      const context = view.context
      if (!context) continue
      for (const action of context.pendingActions) {
        if (applied.current.has(action.actionId)) continue
        applied.current.add(action.actionId)

        let outcome: { ok: true; collectionId: string } | { ok: false }
        try {
          // Only tabs of the session's own workspace that still exist.
          const known = new Set(world.workspaces.find((workspace) => workspace.id === context.workspaceId)?.tabs.map((tab) => tab.id))
          const tabIds = action.tabIds.filter((tabId) => known.has(tabId))
          outcome =
            tabIds.length > 0
              ? { ok: true, collectionId: createCollection(context.workspaceId, action.name, tabIds).id }
              : { ok: false }
        } catch {
          outcome = { ok: false }
        }
        void client.send({ name: "complete_context_action", sessionId: view.sessionId, actionId: action.actionId, outcome })
      }
    }
  }, [client, createCollection, sessions, world.workspaces])

  return { snapshotFor }
}
