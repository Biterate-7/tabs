"use client"

import { useCallback, useMemo, useState } from "react"
import { snapshotToAttachments } from "@/lib/agents/context/attach"
import { resolveContext } from "@/lib/agents/context/resolve"
import { refreshContext } from "@/lib/agents/context/snapshot"
import {
  diffSnapshots,
  EMPTY_SELECTION,
  selectionToRequest,
} from "@/lib/agents/command-centre/context-selection"
import type { ContextDelta, ContextSelection } from "@/lib/agents/command-centre/context-selection"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { AgentContextSnapshot } from "@/lib/agents/context/types"
import type { ContextResolutionFailure } from "@/lib/agents/context/resolve"
import type { AgentAttachedContext } from "@/lib/agents/control/context"

/**
 * The Hubble side of a session: what is selected, what was resolved, and
 * what the agent was actually told.
 *
 * ## Attached is not the same as available, and this hook keeps them apart
 *
 * `selection` is what the user has ticked. `snapshot` is what the resolver
 * made of it at one instant. Only the snapshot has been attached to a session,
 * and only the snapshot is what the agent knows. Conflating the two is the
 * specific misunderstanding scoped context exists to prevent — it would let
 * the inspector imply the agent can see a workspace the user ticked but never
 * attached — so they are separate fields with separate names all the way to
 * the UI.
 *
 * ## Refresh mints a second snapshot; it never mutates the first
 *
 * That is Phase E's rule and the reason a delta can be shown at all: both
 * snapshots still exist, so "+2 tabs, -1 collection" is a comparison rather
 * than a guess. The previous snapshot is chained through
 * `previousSnapshotId`, so what the agent knew at each point in a session
 * stays answerable after the fact.
 *
 * ## Nothing is attached automatically
 *
 * There is no effect here that re-resolves when the workspace changes, and no
 * path by which a tab created after the snapshot reaches a running agent.
 * Refresh is a function the user calls. A context that quietly grew would make
 * a session's behaviour depend on unrelated UI activity, and would send data
 * the user never attached.
 */

/**
 * A resolve carries the control-plane payload with it.
 *
 * Deliberately not "resolve, then read `attachedContext` from state": the
 * caller that resolves usually wants to attach in the same turn, and reading
 * the snapshot back out of state would give it the value from *before* this
 * resolve. Returning both together removes the window in which those two
 * disagree.
 */
export type ContextResolveOutcome =
  | { ok: true; snapshot: AgentContextSnapshot; attached: AgentAttachedContext }
  | { ok: false; reason: ContextResolutionFailure }

/** The control plane's shape of a snapshot. The three fields always travel together. */
export function toAttachedContext(snapshot: AgentContextSnapshot): AgentAttachedContext {
  return {
    snapshotId: snapshot.id,
    capturedAt: snapshot.capturedAt,
    attachments: snapshotToAttachments(snapshot),
  }
}

export type AgentContextApi = {
  selection: ContextSelection
  setSelection: (selection: ContextSelection) => void
  clearSelection: () => void
  /** The snapshot currently attached to the session, if any. */
  snapshot: AgentContextSnapshot | null
  /** What the last refresh changed. Cleared when a new selection is resolved. */
  delta: readonly ContextDelta[]
  /** Why the last resolve failed, when it did. */
  error: ContextResolutionFailure | null
  /**
   * Resolves a selection into a snapshot. Does not attach it.
   *
   * Takes the selection to resolve rather than always reading state, so a
   * caller that has *just* chosen one can resolve it in the same turn instead
   * of waiting a render for `setSelection` to land.
   */
  resolve: (selection?: ContextSelection) => ContextResolveOutcome
  /** Re-resolves the *same* selection, producing a second snapshot and a delta. */
  refresh: () => ContextResolveOutcome
  /** Forgets the attached snapshot. The session-side detach is a separate command. */
  clearSnapshot: () => void
  /** The control-plane shape of the attached snapshot, or `null` when nothing is attached. */
  attachedContext: AgentAttachedContext | null
}

export function useAgentContext(options: {
  world: AgentContextWorld
  /**
   * Whether this environment may resolve local-only data — today, whether a
   * project's filesystem root may appear in a snapshot.
   *
   * This is the **server's** answer relayed, not a guess: it comes from
   * `RuntimeStatus.executable`, which the runtime gate decided on the host.
   * Passing `false` when the host has not said otherwise is the conservative
   * default the resolver documents, and is what a hosted deployment gets.
   */
  localRuntimeAllowed: boolean
  now?: () => number
  createSnapshotId?: () => string
}): AgentContextApi {
  const { world, localRuntimeAllowed } = options

  const [selection, setSelection] = useState<ContextSelection>(EMPTY_SELECTION)
  const [snapshot, setSnapshot] = useState<AgentContextSnapshot | null>(null)
  const [delta, setDelta] = useState<readonly ContextDelta[]>([])
  const [error, setError] = useState<ContextResolutionFailure | null>(null)

  /*
    The scope is the account's whole set, and the selection narrows within it.

    See `selectionToRequest` on why: scope is an authorization boundary
    checked against the account that loaded the data, not a restatement of what
    was ticked. Narrowing it to the ticked workspaces would drop a collection
    or tab named directly from a workspace the user did not also tick.
  */
  const scope = useMemo(
    () => ({
      ownerId: world.ownerId,
      workspaceIds: world.workspaces.map((workspace) => workspace.id),
      projectIds: world.projects.map((project) => project.id),
    }),
    [world]
  )

  const resolveOptions = useMemo(
    () => ({
      localRuntimeAllowed,
      ...(options.now ? { now: options.now } : {}),
      ...(options.createSnapshotId ? { createSnapshotId: options.createSnapshotId } : {}),
    }),
    [localRuntimeAllowed, options.now, options.createSnapshotId]
  )

  const resolveWith = useCallback(
    (current: ContextSelection, previous: AgentContextSnapshot | null): ContextResolveOutcome => {
      const request = selectionToRequest(current, scope)


      // A selection that is not yet a question. Not an error — the picker is
      // simply not finished — so the snapshot is cleared rather than a failure
      // being reported.
      if (!request) {
        setSnapshot(null)
        setDelta([])
        setError(null)
        return { ok: false, reason: "invalid-request" }
      }

      /*
        A refresh goes through `refreshContext`, not `resolveContext`.

        Both re-run the whole resolution — validation, the cross-account gate,
        every limit — but only `refreshContext` links the result to its
        predecessor through `previousSnapshotId`. Calling the resolver directly
        produces a snapshot that is correct and *unchained*, which silently
        turns "what did the agent know at each point in this session" into a
        question with no answer. Phase E owns that semantic; this hook must not
        reimplement it.
      */
      const resolution = previous
        ? refreshContext(previous, request, world, resolveOptions)
        : resolveContext(request, world, resolveOptions)

      if (!resolution.ok) {
        setError(resolution.reason)
        return resolution
      }

      setError(null)
      setSnapshot(resolution.snapshot)
      setDelta(previous ? diffSnapshots(previous, resolution.snapshot) : [])
      return {
        ok: true,
        snapshot: resolution.snapshot,
        attached: toAttachedContext(resolution.snapshot),
      }
    },
    [resolveOptions, scope, world]
  )

  const resolve = useCallback(
    (override?: ContextSelection) => {
      // Adopting the override is what makes "pick, then attach" one action:
      // the picker's confirm both records the choice and resolves it, with no
      // render in between where the two could disagree.
      if (override) setSelection(override)
      return resolveWith(override ?? selection, null)
    },
    [resolveWith, selection]
  )

  const refresh = useCallback(
    () => resolveWith(selection, snapshot),
    [resolveWith, selection, snapshot]
  )

  const clearSelection = useCallback(() => {
    setSelection(EMPTY_SELECTION)
    setSnapshot(null)
    setDelta([])
    setError(null)
  }, [])

  const clearSnapshot = useCallback(() => {
    setSnapshot(null)
    setDelta([])
  }, [])

  /*
    The control plane's shape of the same snapshot.

    Composed here rather than in a component so that the three fields always
    travel together: a payload carrying attachments without the id and capture
    time they came from would be refused by
    `isWellFormedAttachedContext`, and refused at the boundary rather than
    where it was built.
  */
  const attachedContext = useMemo<AgentAttachedContext | null>(
    () => (snapshot ? toAttachedContext(snapshot) : null),
    [snapshot]
  )

  return useMemo(
    () => ({
      selection,
      setSelection,
      clearSelection,
      snapshot,
      delta,
      error,
      resolve,
      refresh,
      clearSnapshot,
      attachedContext,
    }),
    [selection, clearSelection, snapshot, delta, error, resolve, refresh, clearSnapshot, attachedContext]
  )
}
