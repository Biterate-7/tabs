"use client"

import { useCallback, useEffect, useRef } from "react"
import { isTerminalSession } from "@/lib/agents/command-centre/presentation"
import { buildSessionContextSnapshot, snapshotFingerprint } from "@/lib/agents/session-context/snapshot"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { Collection } from "@/lib/collections/types"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeContextActionView, RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot"

/**
 * The Command Centre's half of session workspace context (Phase J.3, J.4).
 *
 * TabDump's workspace lives here, in the app, so the webview is what hands the
 * runtime a session's workspace — and what applies a change the user approved:
 *
 *   - **At start**, `snapshotFor(workspaceId)` is sent with `create_session`.
 *     The runtime binds the session to that workspace and decides what the
 *     agent may do with it from the session's grant.
 *   - **While a session lives**, its workspace is re-sent when it changes —
 *     *its own* workspace, by the id the runtime reports, never whichever one
 *     the user is looking at now. The runtime refuses any other, and bumps the
 *     session's context version when the content differs.
 *   - **Freshness** is a comparison, not a message: `freshnessOf` fingerprints
 *     the snapshot this window would send and compares it with the one the
 *     runtime reports holding. Different means "Update available" until the
 *     next sync lands.
 *   - **When the user approves a change**, the runtime lists it on the
 *     session; this applies it with the same collection store the workspace
 *     view uses, then reports the outcome. Nothing is applied that the
 *     runtime does not list, the runtime lists only approved changes, and
 *     each is applied at most once.
 *
 * No prompt is built here and nothing is sent to an agent. There is no
 * credential anywhere in this hook: the protocol has no field for one.
 */

const SYNC_DEBOUNCE_MS = 400

export type ContextFreshness = "fresh" | "update_available"

export function useSessionContext(options: {
  client: RuntimeClient
  sessions: readonly CommandCentreSession[]
  world: AgentContextWorld
  /** The Command Centre's collection store — the live copy, not the one the world was loaded with. */
  collections: readonly Collection[]
  createCollection: (workspaceId: string, name: string, tabIds: string[]) => Collection
  renameCollection: (id: string, name: string) => void
  addTabsToCollection: (collectionId: string, tabIds: string[]) => void
}): {
  snapshotFor: (workspaceId: string) => SessionContextSnapshot | undefined
  freshnessOf: (context: RuntimeSessionContextView) => ContextFreshness
} {
  const { client, sessions, world, collections, createCollection, renameCollection, addTabsToCollection } = options

  const snapshotFor = useCallback(
    (workspaceId: string) =>
      buildSessionContextSnapshot(
        { workspaces: world.workspaces, collections, dependencies: world.dependencies },
        workspaceId
      ),
    [collections, world.dependencies, world.workspaces]
  )

  const freshnessOf = useCallback(
    (context: RuntimeSessionContextView): ContextFreshness => {
      const local = snapshotFor(context.workspaceId)
      // A workspace this window cannot see is not one it can call stale.
      if (!local) return "fresh"
      return snapshotFingerprint(local) === context.fingerprint ? "fresh" : "update_available"
    },
    [snapshotFor]
  )

  /* ---------------- Keep each live session's own workspace current. */

  const sent = useRef(new Map<string, string>())
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const { view } of sessions) {
        if (!view.context || isTerminalSession(view.status)) continue
        const snapshot = snapshotFor(view.context.workspaceId)
        if (!snapshot) continue
        const fingerprint = snapshotFingerprint(snapshot)
        // Already what the runtime holds, or already on its way.
        if (fingerprint === view.context.fingerprint || sent.current.get(view.sessionId) === fingerprint) continue
        sent.current.set(view.sessionId, fingerprint)
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
          outcome = apply(action, context.workspaceId)
        } catch {
          outcome = { ok: false }
        }
        void client.send({ name: "complete_context_action", sessionId: view.sessionId, actionId: action.actionId, outcome })
      }
    }

    /**
     * One approved change, against the live store. Only tabs of the session's
     * own workspace that still exist, and only a collection of that workspace:
     * anything that has gone since the approval fails rather than half-applies.
     */
    function apply(action: RuntimeContextActionView, workspaceId: string): { ok: true; collectionId: string } | { ok: false } {
      const known = new Set(world.workspaces.find((workspace) => workspace.id === workspaceId)?.tabs.map((tab) => tab.id))
      switch (action.kind) {
        case "create_collection": {
          const tabIds = action.tabIds.filter((tabId) => known.has(tabId))
          return tabIds.length > 0
            ? { ok: true, collectionId: createCollection(workspaceId, action.name, tabIds).id }
            : { ok: false }
        }
        case "rename_collection": {
          const collection = collections.find((entry) => entry.id === action.collectionId && entry.workspaceId === workspaceId)
          if (!collection || !action.name.trim()) return { ok: false }
          renameCollection(collection.id, action.name)
          return { ok: true, collectionId: collection.id }
        }
        case "add_tabs_to_collection": {
          const collection = collections.find((entry) => entry.id === action.collectionId && entry.workspaceId === workspaceId)
          const tabIds = action.tabIds.filter((tabId) => known.has(tabId))
          if (!collection || tabIds.length === 0) return { ok: false }
          addTabsToCollection(collection.id, tabIds)
          return { ok: true, collectionId: collection.id }
        }
      }
    }
  }, [addTabsToCollection, client, collections, createCollection, renameCollection, sessions, world.workspaces])

  return { snapshotFor, freshnessOf }
}
