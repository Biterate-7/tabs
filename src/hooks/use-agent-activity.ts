"use client"

import { useCallback, useMemo } from "react"
import { inspectActivityEntry } from "@/lib/agents/activity/inspector"
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline"
import type { ActionInspection } from "@/lib/agents/activity/inspector"
import type { AgentActivityEntry } from "@/lib/agents/activity/timeline"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { RuntimeApprovalView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"

/**
 * One session's activity timeline, derived live from what the session hook
 * already polls — no second transport, no second store.
 *
 * ## Why it needs no state of its own
 *
 * The runtime's event journal is the record. `useAgentSession` re-reads it
 * from the start whenever a session is (re)opened, so a remount, a workspace
 * switch or the Command Centre being closed and reopened reproduces the same
 * timeline from the same events; and it polls while the agent works, so new
 * entries appear without a reload. This hook only folds that into entries.
 *
 * ## The one thing it remembers
 *
 * An approval is described from the broker's record while it is waiting, and
 * the broker stops reporting it once it is answered. What it asked is kept
 * here — in memory, for this page, bounded — so "Action approved · Create
 * research-summary.md" still says what was approved. The same lifetime as
 * the workspace-change record beside it (command-centre/workspace-activity.ts).
 *
 * ## Why it never throws
 *
 * The timeline is observational. A record it cannot read — a newer runtime's
 * event, malformed metadata — must never take the Command Centre down with
 * it, so a failed build logs once and yields an empty timeline.
 */

const MAX_REMEMBERED_APPROVALS = 200
const remembered = new Map<string, RuntimeApprovalView>()

function remember(approvals: readonly RuntimeApprovalView[]): void {
  for (const approval of approvals) {
    remembered.delete(approval.approvalId)
    remembered.set(approval.approvalId, approval)
  }
  while (remembered.size > MAX_REMEMBERED_APPROVALS) {
    const oldest = remembered.keys().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
}

/** Tests only: forget remembered approvals. */
export function resetRememberedApprovals(): void {
  remembered.clear()
}

export function useAgentActivity(options: {
  session: RuntimeSessionView | null
  events: readonly SequencedControlEvent[]
  approvals: readonly RuntimeApprovalView[]
  changes?: readonly AppliedWorkspaceChange[]
  agentName: string
  workspaceName?: string
  now: number
  /**
   * Answered approvals the host already holds. When given, they are used
   * instead of this page's memory — the landing page's demo passes its
   * own, so nothing it shows is remembered here.
   */
  knownApprovals?: ReadonlyMap<string, RuntimeApprovalView>
}): readonly AgentActivityEntry[] {
  const { session, events, approvals, changes, agentName, workspaceName, now, knownApprovals } = options

  return useMemo(() => {
    if (!session) return []
    try {
      // Idempotent: the same approvals remembered again change nothing.
      if (!knownApprovals) remember(approvals)
      return buildAgentActivityTimeline({
        session,
        events,
        approvals,
        knownApprovals: knownApprovals ?? remembered,
        ...(changes ? { changes } : {}),
        agentName,
        ...(workspaceName ? { workspaceName } : {}),
        now,
      })
    } catch (error) {
      console.warn("Hubble could not build the agent activity timeline.", error)
      return []
    }
  }, [session, events, approvals, changes, agentName, workspaceName, now, knownApprovals])
}

/**
 * What one activity entry stands for, as the action inspector shows it —
 * resolved from the same records the timeline was built from, by reference
 * (see lib/agents/activity/inspector.ts). Returns a function so the
 * inspection is worked out only for the entry that is open, and afresh on
 * every render: it is as live as the records are.
 */
export function useActivityInspector(options: {
  entries: readonly AgentActivityEntry[]
  session: RuntimeSessionView | null
  events: readonly SequencedControlEvent[]
  approvals: readonly RuntimeApprovalView[]
  changes?: readonly AppliedWorkspaceChange[]
  agentName: string
  workspaceName?: string
  projectName?: string
  knownApprovals?: ReadonlyMap<string, RuntimeApprovalView>
  /** Whether an applied change can be undone exactly right now. Absent: no undo is offered. */
  canUndo?: (change: AppliedWorkspaceChange) => boolean
}): (entryId: string) => ActionInspection | null {
  const { entries, session, events, approvals, changes, agentName, workspaceName, projectName, knownApprovals, canUndo } = options
  return useCallback(
    (entryId: string) => {
      if (!session) return null
      try {
        return inspectActivityEntry(entryId, {
          entries,
          session,
          events,
          approvals,
          knownApprovals: knownApprovals ?? remembered,
          ...(changes ? { changes } : {}),
          agentName,
          ...(workspaceName ? { workspaceName } : {}),
          ...(projectName ? { projectName } : {}),
          ...(canUndo ? { canUndo } : {}),
        })
      } catch (error) {
        // Observational, like the timeline: a record it cannot read closes the inspector, never the Command Centre.
        console.warn("Hubble could not inspect that activity.", error)
        return null
      }
    },
    [entries, session, events, approvals, changes, agentName, workspaceName, projectName, knownApprovals, canUndo]
  )
}

/**
 * A session's activity as every surface shows it: the timeline's entries,
 * what each one opens in the inspector, and whether anything waits on the
 * person. The Command Centre and the landing page's live demonstration both
 * call this with their own records — the runtime's, or the demo's fixture —
 * so the two cannot drift apart in what they derive.
 */
export function useSessionActivity(options: {
  session: RuntimeSessionView | null
  events: readonly SequencedControlEvent[]
  approvals: readonly RuntimeApprovalView[]
  changes?: readonly AppliedWorkspaceChange[]
  agentName: string
  workspaceName?: string
  projectName?: string
  now: number
  knownApprovals?: ReadonlyMap<string, RuntimeApprovalView>
  canUndo?: (change: AppliedWorkspaceChange) => boolean
}): {
  entries: readonly AgentActivityEntry[]
  inspect: (entryId: string) => ActionInspection | null
  waiting: boolean
} {
  const { projectName, canUndo, ...timeline } = options
  const entries = useAgentActivity(timeline)
  const inspect = useActivityInspector({
    entries,
    session: options.session,
    events: options.events,
    approvals: options.approvals,
    ...(options.changes ? { changes: options.changes } : {}),
    agentName: options.agentName,
    ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}),
    ...(projectName ? { projectName } : {}),
    ...(options.knownApprovals ? { knownApprovals: options.knownApprovals } : {}),
    ...(canUndo ? { canUndo } : {}),
  })
  const waiting = useMemo(() => entries.some((entry) => entry.status === "waiting"), [entries])
  return { entries, inspect, waiting }
}
