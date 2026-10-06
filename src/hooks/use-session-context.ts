"use client"

import { useCallback, useEffect, useRef } from "react"
import { isTerminalSession } from "@/lib/agents/command-centre/presentation"
import { buildSessionContextSnapshot, snapshotFingerprint } from "@/lib/agents/session-context/snapshot"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"
import type { CollectionBatchOperation, CollectionBatchResult } from "@/lib/collections/batch"
import type { Collection } from "@/lib/collections/types"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { RuntimeContextActionView, RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot"
import type { AppliedWorkspaceChange, WorkspaceChangeStep } from "@/lib/agents/command-centre/workspace-activity"

/**
 * The Command Centre's half of session workspace context (Phase J.3, J.4).
 *
 * Hubble's workspace lives here, in the app, so the webview is what hands the
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
 *     each is applied at most once. An approved **plan** (J.5) is applied
 *     whole through the store's batch, synced, and then reported with its
 *     hash, so the runtime can check the result against what was approved.
 *
 * No prompt is built here and nothing is sent to an agent. There is no
 * credential anywhere in this hook: the protocol has no field for one.
 */

const SYNC_DEBOUNCE_MS = 400

/**
 * What an applied batch did, step by step, in names and counts — read off the
 * operations and the collections before and after, never off the agent's
 * description of what it meant to do.
 */
function stepsOf(
  operations: readonly CollectionBatchOperation[],
  result: Extract<CollectionBatchResult, { ok: true }>,
  before: readonly Collection[]
): WorkspaceChangeStep[] {
  let created = 0
  const nameIn = (list: readonly Collection[], id: string) => list.find((collection) => collection.id === id)?.name
  return operations.map((operation): WorkspaceChangeStep => {
    switch (operation.kind) {
      case "create_collection": {
        const collectionId = result.created[created++]
        return { kind: "created", ...(collectionId ? { collectionId } : {}), name: operation.name.trim(), tabCount: operation.tabIds.length }
      }
      case "rename_collection": {
        const previousName = nameIn(before, operation.collectionId)
        return { kind: "renamed", collectionId: operation.collectionId, name: operation.name.trim(), ...(previousName ? { previousName } : {}) }
      }
      case "add_tabs_to_collection":
        return {
          kind: "added",
          collectionId: operation.collectionId,
          name: nameIn(result.collections, operation.collectionId) ?? "a collection",
          tabCount: operation.tabIds.length,
        }
    }
  })
}

export type ContextFreshness = "fresh" | "update_available"

export function useSessionContext(options: {
  client: RuntimeClient
  sessions: readonly CommandCentreSession[]
  world: AgentContextWorld
  /** The Command Centre's collection store — the live copy, not the one the world was loaded with. */
  collections: readonly Collection[]
  /** The store's all-or-nothing batch (J.5): how every approved change is applied. */
  applyCollectionBatch: (workspaceId: string, operations: readonly CollectionBatchOperation[]) => CollectionBatchResult
  /** Told once per application, in words — what the activity rows and the notification show. */
  onApplied?: (change: AppliedWorkspaceChange) => void
}): {
  snapshotFor: (workspaceId: string) => SessionContextSnapshot | undefined
  freshnessOf: (context: RuntimeSessionContextView) => ContextFreshness
} {
  const { client, sessions, world, collections, applyCollectionBatch, onApplied } = options

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
    /*
      Every application — a single change (J.3–J.4) or a whole plan (J.5) —
      goes through the store's batch, which folds it through the same reducers
      a person's edit uses and commits the resulting array in one write. That
      is what makes each one exact: the array before and the array after are
      both in hand, so what changed can be said in words, and undone exactly.

      Because each commit replaces the whole array computed from this render,
      at most one change is committed per pass; the store's own update runs
      the next pass. A change that fails commits nothing, so the pass goes on.
    */
    for (const { view } of sessions) {
      const context = view.context
      if (!context) continue
      for (const action of context.pendingActions) {
        if (applied.current.has(action.actionId)) continue
        applied.current.add(action.actionId)

        const workspaceId = context.workspaceId
        const before = collections.filter((collection) => collection.workspaceId === workspaceId)
        const operations = operationsFor(action, workspaceId)
        let result: CollectionBatchResult
        try {
          result = operations ? applyCollectionBatch(workspaceId, operations) : { ok: false, failedAt: 0, reason: "unknown_kind" }
        } catch {
          result = { ok: false, failedAt: 0, reason: "unknown_kind" }
        }

        if (action.kind === "apply_plan") reportPlan(view.sessionId, workspaceId, action, result)
        else {
          const collectionId = result.ok ? (result.created[0] ?? ("collectionId" in action ? action.collectionId : undefined)) : undefined
          void client.send({
            name: "complete_context_action",
            sessionId: view.sessionId,
            actionId: action.actionId,
            outcome: result.ok && collectionId ? { ok: true, collectionId } : { ok: false },
          })
        }

        onApplied?.({
          id: action.actionId,
          sessionId: view.sessionId,
          provider: view.provider,
          workspaceId,
          at: Date.now(),
          ok: result.ok,
          ...(action.kind === "apply_plan" ? { planId: action.planId } : {}),
          ...(action.approvalId ? { approvalId: action.approvalId } : {}),
          steps: result.ok ? stepsOf(operations ?? [], result, before) : [],
          ...(result.ok
            ? { before, after: result.collections.filter((collection) => collection.workspaceId === workspaceId) }
            : {}),
        })
        // Committed: the rest waits for the pass the store's update starts.
        if (result.ok) return
      }
    }

    /**
     * What an approved action does, as batch operations — only tabs of the
     * session's own workspace that still exist. A single change whose tabs
     * have all gone since the approval applies nothing rather than half.
     */
    function operationsFor(action: RuntimeContextActionView, workspaceId: string): CollectionBatchOperation[] | undefined {
      const known = new Set(world.workspaces.find((workspace) => workspace.id === workspaceId)?.tabs.map((tab) => tab.id))
      switch (action.kind) {
        case "create_collection":
          return [{ kind: "create_collection", name: action.name, tabIds: action.tabIds.filter((tabId) => known.has(tabId)) }]
        case "rename_collection":
          return [{ kind: "rename_collection", collectionId: action.collectionId, name: action.name }]
        case "add_tabs_to_collection":
          return [{ kind: "add_tabs_to_collection", collectionId: action.collectionId, tabIds: action.tabIds.filter((tabId) => known.has(tabId)) }]
        case "apply_plan":
          // Whole, exactly as approved: a plan that no longer fits fails, it is not trimmed.
          return [...action.operations]
      }
    }

    /**
     * An approved plan (J.5) was applied all at once, or not at all. The
     * workspace as it now stands is synced first, because that is what the
     * runtime checks the plan against when told it was applied; then the
     * plan's own hash and the ids it created are reported.
     */
    function reportPlan(
      sessionId: string,
      workspaceId: string,
      action: Extract<RuntimeContextActionView, { kind: "apply_plan" }>,
      result: CollectionBatchResult
    ): void {
      if (!result.ok) {
        void client.send({
          name: "complete_context_action",
          sessionId,
          actionId: action.actionId,
          outcome: { ok: false, failedAt: result.failedAt },
        })
        return
      }

      const created = result.created
      const snapshot = buildSessionContextSnapshot(
        { workspaces: world.workspaces, collections: result.collections, dependencies: world.dependencies },
        workspaceId
      )
      void (async () => {
        if (snapshot) {
          sent.current.set(sessionId, snapshotFingerprint(snapshot))
          await client.send({ name: "sync_session_context", sessionId, snapshot }).catch(() => undefined)
        }
        await client.send({
          name: "complete_context_action",
          sessionId,
          actionId: action.actionId,
          outcome: { ok: true, planHash: action.planHash, created },
        })
      })()
    }
  }, [applyCollectionBatch, client, collections, onApplied, sessions, world.dependencies, world.workspaces])

  return { snapshotFor, freshnessOf }
}
