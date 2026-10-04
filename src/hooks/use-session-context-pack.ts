"use client"

import { useMemo } from "react"
import { contextOfSession } from "@/lib/agents/command-centre/working-context"
import {
  contextDeliveryState,
  handoffThatStarted,
  latestInstruction,
  sessionContextPack,
} from "@/lib/agents/context-pack/session"
import { describeWorkspaceBrief } from "@/lib/workspace/brief"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { WorkingContext } from "@/lib/agents/command-centre/working-context"
import type { ContextPack } from "@/lib/agents/context-pack/pack"
import type { ContextDeliveryState } from "@/lib/agents/context-pack/present"
import type { SessionHandoff } from "@/lib/agents/handoff/handoff"
import type { RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import type { WorkspaceBriefView } from "@/lib/workspace/brief"

/**
 * The on-screen session's Context Pack, where it stands, and its workspace's
 * brief (Hubble 1.5) — one derivation for the Command Centre and the landing
 * page's demo, fed their own records. With no session, the pack a new session
 * in `workspaceId` would start with.
 */
export function useSessionContextPack(options: {
  world: AgentContextWorld
  session: RuntimeSessionView | null
  /** The session's workspace — or, with no session, the one a new session would start in. Absent: none to describe. */
  workspaceId: string | undefined
  events: readonly SequencedControlEvent[]
  handoffs?: readonly SessionHandoff[]
  changes: readonly AppliedWorkspaceChange[]
  /** The selection a new session would start with. Ignored once there is a session. */
  draft?: WorkingContext | null
}): { pack: ContextPack | null; state: ContextDeliveryState | undefined; brief: WorkspaceBriefView | undefined } {
  const { world, session, workspaceId, events, handoffs, changes, draft } = options
  const handoffFrom = session ? handoffThatStarted(session.sessionId, handoffs) : undefined

  const pack = useMemo(() => {
    if (!workspaceId) return null
    const instruction = session ? latestInstruction(events, session.sessionId, handoffFrom) : undefined
    const built = sessionContextPack({
      world,
      workspaceId,
      selection: session ? contextOfSession(session) : (draft ?? null),
      ...(session ? { sessionId: session.sessionId } : {}),
      changes,
      ...(handoffFrom ? { handoffFrom } : {}),
      ...(instruction ? { instruction } : {}),
    })
    return built.ok ? built.pack : null
  }, [world, workspaceId, session, events, handoffFrom, changes, draft])

  const brief = useMemo(() => {
    const workspace = workspaceId ? world.workspaces.find((entry) => entry.id === workspaceId) : undefined
    if (!workspace) return undefined
    return describeWorkspaceBrief({
      workspace,
      collections: world.collections,
      recentChanges: changes.filter((change) => change.workspaceId === workspace.id && change.ok && !change.undone).length,
    })
  }, [world, workspaceId, changes])

  return { pack, state: session && pack ? contextDeliveryState(session, pack) : undefined, brief }
}
