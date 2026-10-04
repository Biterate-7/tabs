"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { ActionInspector } from "./action-inspector"
import { AgentActivityTimeline } from "./agent-activity-timeline"
import { isInspectable } from "@/lib/agents/activity/inspector"
import type { AgentActivityTimelineProps } from "./agent-activity-timeline"
import type { ActionInspection } from "@/lib/agents/activity/inspector"

/**
 * The agent's activity, with each action one click deep:
 *
 *     Activity ──(click an action)──▶ Action Inspector ──(‹ Activity)──▶ Activity
 *
 * The one component every surface that shows an agent's activity renders —
 * the Command Centre's context panel, its header popover, and the landing
 * page's live demonstration — so what a visitor sees there is what a user
 * sees in Hubble. Each host brings only its data: the timeline entries, an
 * `inspect` that resolves an entry into an inspection from the same records,
 * and what View and Undo do in its workspace.
 *
 * ## Live
 *
 * The open action is held by the entry it was opened from, whose id is
 * derived from its source and never changes, and the inspection is resolved
 * again on every render. So "Waiting for approval" becomes "Approved", then
 * "Running", then "Completed" in place as the session's records arrive — the
 * host's existing polling is the only transport.
 */
export function AgentActivity({
  inspect,
  onUndo,
  onViewChange,
  autoFocus = true,
  ...timeline
}: AgentActivityTimelineProps & {
  /** Resolves an entry into the action it stands for, or `null` when there is nothing more to show. */
  inspect: (entryId: string) => ActionInspection | null
  /** Reverses an applied change exactly; `false` when it could not be, and nothing moved. */
  onUndo?: (changeId: string) => boolean
  /** Moves focus into the inspector when it opens and back to the row when it closes. */
  autoFocus?: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const returnTo = useRef<string | null>(null)

  const open = useCallback((entryId: string) => {
    returnTo.current = null
    setOpenId(entryId)
  }, [])
  const back = useCallback(() => {
    setOpenId((current) => {
      returnTo.current = current
      return null
    })
  }, [])

  // Back on the list: focus returns to the row the person opened.
  useLayoutEffect(() => {
    if (openId !== null || !returnTo.current || !autoFocus) return
    const id = returnTo.current.replace(/["\\]/g, "\\$&")
    const row = container.current?.querySelector<HTMLElement>(`[data-activity-inspect="${id}"]`)
    returnTo.current = null
    row?.focus({ preventScroll: true })
  }, [openId, autoFocus])

  const inspection = openId ? inspect(openId) : null

  return (
    <div ref={container} className="min-w-0">
      {inspection ? (
        <ActionInspector
          inspection={inspection}
          now={timeline.now}
          onBack={back}
          {...(onViewChange ? { onView: onViewChange } : {})}
          {...(onUndo ? { onUndo } : {})}
          {...(timeline.onOpenSession ? { onOpenSession: timeline.onOpenSession } : {})}
          autoFocus={autoFocus}
        />
      ) : (
        <AgentActivityTimeline
          {...timeline}
          {...(onViewChange ? { onViewChange } : {})}
          onInspect={open}
          isInspectable={isInspectable}
        />
      )}
    </div>
  )
}
