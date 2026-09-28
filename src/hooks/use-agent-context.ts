"use client"

import { useCallback, useMemo } from "react"
import { snapshotToAttachments } from "@/lib/agents/context/attach"
import { resolveContext } from "@/lib/agents/context/resolve"
import { selectionToRequest } from "@/lib/agents/command-centre/context-selection"
import { toContextSelection } from "@/lib/agents/command-centre/working-context"
import type { WorkingContext } from "@/lib/agents/command-centre/working-context"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { AgentContextSnapshot } from "@/lib/agents/context/types"
import type { ContextResolutionFailure } from "@/lib/agents/context/resolve"
import type { AgentAttachedContext } from "@/lib/agents/control/context"

/**
 * Turns a working context into what a session is actually told.
 *
 * ## One session, one workspace, one resolution
 *
 * This hook holds no selection and no snapshot. It used to — one selection
 * for the whole Command Centre — which meant context chosen for one session
 * was the context sent with the next message in *another*, and could name any
 * workspace the account owned. Now every call resolves exactly one session's
 * context, and the resolver's scope is that context's **own workspace and
 * nothing else**: an id from anywhere else is dropped by the Phase E resolver
 * as out of scope, before anything is built. (The runtime refuses it again on
 * arrival — see `focusWithin` in runtime/host.ts.)
 *
 * ## The whole workspace attaches nothing
 *
 * A session bound to its workspace reads it through its own MCP server, one
 * bounded answer at a time. Pasting the workspace into a prompt would be the
 * unbounded snapshot scoped context exists to avoid, so `resolve` answers
 * "nothing to attach" and the caller detaches instead.
 *
 * ## Resolution is still Phase E's
 *
 * Validation, redaction, every limit and every omission come from
 * `resolveContext`; the attachments from `snapshotToAttachments`. Nothing here
 * builds a snapshot or an attachment of its own.
 */

export type ContextResolveOutcome =
  /** Something to attach. */
  | { ok: true; snapshot: AgentContextSnapshot; attached: AgentAttachedContext }
  /** The whole workspace: nothing to attach — the session reads it on request. */
  | { ok: true; snapshot: null; attached: null }
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
  resolve: (context: WorkingContext, options?: { includeNotes?: boolean }) => ContextResolveOutcome
}

export function useAgentContext(options: {
  world: AgentContextWorld
  /**
   * Whether this environment may resolve local-only data. The **server's**
   * answer relayed (`RuntimeStatus.executable`), never a browser guess.
   */
  localRuntimeAllowed: boolean
  now?: () => number
  createSnapshotId?: () => string
}): AgentContextApi {
  const { world, localRuntimeAllowed } = options

  const resolveOptions = useMemo(
    () => ({
      localRuntimeAllowed,
      ...(options.now ? { now: options.now } : {}),
      ...(options.createSnapshotId ? { createSnapshotId: options.createSnapshotId } : {}),
    }),
    [localRuntimeAllowed, options.now, options.createSnapshotId]
  )

  const resolve = useCallback(
    (context: WorkingContext, extra: { includeNotes?: boolean } = {}): ContextResolveOutcome => {
      const selection = toContextSelection(context, extra)
      if (!selection) return { ok: true, snapshot: null, attached: null }

      // The scope is the context's own workspace — an authorization boundary,
      // not a restatement of what was picked. Nothing outside it can resolve.
      const request = selectionToRequest(selection, {
        ownerId: world.ownerId,
        workspaceIds: [context.workspaceId],
        projectIds: [],
      })
      if (!request) return { ok: false, reason: "invalid-request" }

      const resolution = resolveContext(request, world, resolveOptions)
      if (!resolution.ok) return resolution
      return { ok: true, snapshot: resolution.snapshot, attached: toAttachedContext(resolution.snapshot) }
    },
    [resolveOptions, world]
  )

  return useMemo(() => ({ resolve }), [resolve])
}
