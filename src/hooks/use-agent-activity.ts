"use client"

import { useCallback, useMemo } from "react"
import { reconstructHistorySession } from "@/lib/agents/activity/history"
import { inspectActivityEntry } from "@/lib/agents/activity/inspector"
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline"
import type { AgentHistoryDetail, ReconstructedHistorySession } from "@/lib/agents/activity/history"
import type { ActionInspection } from "@/lib/agents/activity/inspector"
import type { AgentActivityEntry } from "@/lib/agents/activity/timeline"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { RuntimeApprovalView, RuntimePlanOutcomeView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import type { SessionHandoff } from "@/lib/agents/handoff/handoff"

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
  /** Plans' outcomes, when they are not the live session's own — agent history's. */
  planOutcomes?: readonly RuntimePlanOutcomeView[]
  /** Handoffs the session was part of (Hubble 1.4), for what each passed. */
  handoffs?: readonly SessionHandoff[]
}): readonly AgentActivityEntry[] {
  const { session, events, approvals, changes, agentName, workspaceName, now, knownApprovals, planOutcomes, handoffs } = options

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
        ...(planOutcomes ? { planOutcomes } : {}),
        ...(handoffs ? { handoffs } : {}),
        agentName,
        ...(workspaceName ? { workspaceName } : {}),
        now,
      })
    } catch (error) {
      console.warn("Hubble could not build the agent activity timeline.", error)
      return []
    }
  }, [session, events, approvals, changes, agentName, workspaceName, now, knownApprovals, planOutcomes, handoffs])
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
  planOutcomes?: readonly RuntimePlanOutcomeView[]
  handoffs?: readonly SessionHandoff[]
  /** Whether an applied change can be undone exactly right now. Absent: no undo is offered. */
  canUndo?: (change: AppliedWorkspaceChange) => boolean
  /** A collection's live name, for an action's context provenance (Hubble 1.5). */
  collectionName?: (collectionId: string) => string | undefined
  /** The live session on a runtime that holds its project changes (Hubble 1.6): project undo, review and checks are offered. */
  projectLive?: boolean
}): (entryId: string) => ActionInspection | null {
  const { entries, session, events, approvals, changes, agentName, workspaceName, projectName, knownApprovals, planOutcomes, handoffs, canUndo, collectionName, projectLive } = options
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
          ...(planOutcomes ? { planOutcomes } : {}),
          ...(handoffs ? { handoffs } : {}),
          agentName,
          ...(workspaceName ? { workspaceName } : {}),
          ...(projectName ? { projectName } : {}),
          ...(canUndo ? { canUndo } : {}),
          ...(collectionName ? { collectionName } : {}),
          ...(projectLive ? { projectLive } : {}),
        })
      } catch (error) {
        // Observational, like the timeline: a record it cannot read closes the inspector, never the Command Centre.
        console.warn("Hubble could not inspect that activity.", error)
        return null
      }
    },
    [entries, session, events, approvals, changes, agentName, workspaceName, projectName, knownApprovals, planOutcomes, handoffs, canUndo, collectionName, projectLive]
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
  planOutcomes?: readonly RuntimePlanOutcomeView[]
  handoffs?: readonly SessionHandoff[]
  canUndo?: (change: AppliedWorkspaceChange) => boolean
  collectionName?: (collectionId: string) => string | undefined
  projectLive?: boolean
}): {
  entries: readonly AgentActivityEntry[]
  inspect: (entryId: string) => ActionInspection | null
  waiting: boolean
} {
  const { projectName, canUndo, collectionName, projectLive, ...timeline } = options
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
    ...(options.planOutcomes ? { planOutcomes: options.planOutcomes } : {}),
    ...(options.handoffs ? { handoffs: options.handoffs } : {}),
    ...(canUndo ? { canUndo } : {}),
    ...(collectionName ? { collectionName } : {}),
    ...(projectLive ? { projectLive } : {}),
  })
  const waiting = useMemo(() => entries.some((entry) => entry.status === "waiting"), [entries])
  return { entries, inspect, waiting }
}

const NO_EVENTS: readonly SequencedControlEvent[] = []
const NO_APPROVALS: readonly RuntimeApprovalView[] = []
const NO_KNOWN_APPROVALS: ReadonlyMap<string, RuntimeApprovalView> = new Map()

/**
 * A session read back from agent history, as every surface shows it: the
 * same `useSessionActivity` the live session uses, fed the records history
 * kept (lib/agents/activity/history.ts) instead of the runtime's journal.
 * Same entries, same inspector, same undo rules — there is no second
 * timeline for the past.
 *
 * Nothing is remembered from this page: the approvals history kept are the
 * ones used, and none is waiting. The Command Centre and the landing page's
 * demonstration both call this with their own detail — the runtime's, or the
 * demo's fixture.
 */
export function useHistorySessionActivity(options: {
  detail: AgentHistoryDetail | null
  agentName: string
  workspaceName?: string
  projectName?: string
  now: number
  canUndo?: (change: AppliedWorkspaceChange) => boolean
  collectionName?: (collectionId: string) => string | undefined
}): {
  entries: readonly AgentActivityEntry[]
  inspect: (entryId: string) => ActionInspection | null
  history: ReconstructedHistorySession | null
} {
  const { detail, agentName, workspaceName, projectName, now, canUndo, collectionName } = options
  const history = useMemo(() => {
    if (!detail) return null
    try {
      return reconstructHistorySession(detail)
    } catch (error) {
      console.warn("Hubble could not read that agent history.", error)
      return null
    }
  }, [detail])
  const { entries, inspect } = useSessionActivity({
    session: history?.session ?? null,
    events: history?.events ?? NO_EVENTS,
    approvals: NO_APPROVALS,
    ...(history ? { changes: history.changes, planOutcomes: history.planOutcomes, handoffs: history.handoffs } : {}),
    knownApprovals: history?.knownApprovals ?? NO_KNOWN_APPROVALS,
    agentName,
    ...(workspaceName ? { workspaceName } : {}),
    ...(projectName ? { projectName } : {}),
    now,
    ...(canUndo ? { canUndo } : {}),
    ...(collectionName ? { collectionName } : {}),
  })
  return { entries, inspect, history }
}
