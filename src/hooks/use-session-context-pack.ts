"use client"

import { useMemo } from "react"
import { contextOfSession } from "@/lib/agents/command-centre/working-context"
import {
  contextChangeOf,
  contextDeliveryState,
  handoffThatStarted,
  latestInstruction,
  sessionContextPack,
} from "@/lib/agents/context-pack/session"
import { contextPackId } from "@/lib/agents/context-pack/pack"
import { describeWorkspaceBrief } from "@/lib/workspace/brief"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { WorkingContext } from "@/lib/agents/command-centre/working-context"
import type { ContextPack, ContextPackFile } from "@/lib/agents/context-pack/pack"
import type { ContextDeliveryState } from "@/lib/agents/context-pack/present"
import type { SessionHandoff } from "@/lib/agents/handoff/handoff"
import type { ProjectDescriptor } from "@/lib/agents/project/describe"
import type { RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import type { WorkspaceBriefView } from "@/lib/workspace/brief"

/**
 * Packs this page built, by id — so when a session holds an older one, Hubble
 * can say whether only the project changed under it (Hubble 1.6). Bounded;
 * a pack built on another page is simply "changed".
 */
const builtPacks = new Map<string, ContextPack>()
const MAX_REMEMBERED_PACKS = 64

function remember(pack: ContextPack): void {
  const id = contextPackId(pack)
  builtPacks.delete(id)
  builtPacks.set(id, pack)
  while (builtPacks.size > MAX_REMEMBERED_PACKS) builtPacks.delete(builtPacks.keys().next().value!)
}

/** A project file a session's own work changed, as Hubble measured it (Hubble 1.6). */
export type MeasuredProjectFile = { path: string; change: "created" | "updated"; hash?: string }

/**
 * The project files a session's own work changed, as Hubble measured them —
 * newest measurement per file, undone changes left out.
 */
export function measuredProjectFiles(events: readonly SequencedControlEvent[], sessionId: string | undefined): MeasuredProjectFile[] {
  if (!sessionId) return []
  const files = new Map<string, MeasuredProjectFile>()
  const undone = new Set(
    events.filter((event) => event.sessionId === sessionId && event.projectUndo && event.projectUndo.outcome !== "refused").map((event) => event.projectUndo!.changeId)
  )
  for (const event of events) {
    const info = event.sessionId === sessionId ? event.projectChange : undefined
    if (!info || undone.has(info.changeId)) continue
    for (const file of info.files) {
      if (file.change === "unchanged" || file.change === "deleted") continue
      const created = file.change === "created" || files.get(file.path)?.change === "created"
      files.set(file.path, { path: file.path, change: created ? "created" : "updated", ...(file.hash ? { hash: file.hash } : {}) })
    }
  }
  return [...files.values()]
}

/**
 * The files to tell an agent about (Hubble 1.6): those its own work changed
 * that have changed again outside the session since — a person's edit, a
 * branch switch. Files it changed and that are still as it left them it
 * already knows; naming them again would mark its context changed after
 * every write.
 */
export function filesChangedOutside(measured: readonly MeasuredProjectFile[], project: ProjectDescriptor | undefined): ContextPackFile[] {
  if (!project) return []
  const now = new Map(project.files.map((file) => [file.path, file]))
  const out: ContextPackFile[] = []
  for (const file of measured) {
    const current = now.get(file.path)
    if (!current || !file.hash) continue
    const drifted = current.state === "missing" || (current.state === "present" && current.hash !== undefined && current.hash !== file.hash)
    if (drifted) out.push({ path: file.path, change: file.change, outside: true })
  }
  return out
}

/**
 * The on-screen session's Context Pack, where it stands, and its workspace's
 * brief (Hubble 1.5) — one derivation for the Command Centre and the landing
 * page's demo, fed their own records. With no session, the pack a new session
 * in `workspaceId` would start with. With a project (Hubble 1.6), the pack
 * says which project and what the agent may do there, and `change` says when
 * only the project moved under a delivered pack.
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
  /** The workspace's project, described for this session's agent (Hubble 1.6). */
  project?: ProjectDescriptor
}): {
  pack: ContextPack | null
  state: ContextDeliveryState | undefined
  change: "project" | undefined
  brief: WorkspaceBriefView | undefined
} {
  const { world, session, workspaceId, events, handoffs, changes, draft, project } = options
  const handoffFrom = session ? handoffThatStarted(session.sessionId, handoffs) : undefined
  const projectFiles = useMemo(() => filesChangedOutside(measuredProjectFiles(events, session?.sessionId), project), [events, session?.sessionId, project])

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
      // Only a session that works in this project is told it.
      ...(project && (!session || session.projectId === project.id) ? { project, projectFiles } : {}),
    })
    if (!built.ok) return null
    remember(built.pack)
    return built.pack
  }, [world, workspaceId, session, events, handoffFrom, changes, draft, project, projectFiles])

  const brief = useMemo(() => {
    const workspace = workspaceId ? world.workspaces.find((entry) => entry.id === workspaceId) : undefined
    if (!workspace) return undefined
    return describeWorkspaceBrief({
      workspace,
      collections: world.collections,
      recentChanges: changes.filter((change) => change.workspaceId === workspace.id && change.ok && !change.undone).length,
    })
  }, [world, workspaceId, changes])

  const state = session && pack ? contextDeliveryState(session, pack) : undefined
  const change =
    state === "changed" && pack && session?.contextSnapshotId ? contextChangeOf(builtPacks.get(session.contextSnapshotId), pack) : undefined
  return { pack, state, change, brief }
}
