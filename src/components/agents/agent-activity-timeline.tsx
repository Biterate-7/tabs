"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleMinus, LoaderCircle, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "@/lib/time-format"
import { AgentIcon } from "./agent-icon"
import { activityTime } from "@/lib/agents/activity/timeline"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { cn } from "@/lib/utils"
import type { AgentActivityEntry, AgentActivityStatus } from "@/lib/agents/activity/timeline"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentVisualState } from "@/lib/agents/visual/types"

/**
 * What an agent has been doing in its workspace, newest first — the quiet
 * operational history beside the conversation:
 *
 *     ◌  Reading workspace…
 *     ✓  Found 14 relevant tabs          2 min
 *        Searched Research
 *     ●  Claude Code connected           5 min
 *        Working in Research
 *
 * ## What it is not
 *
 * Not a chat (that is the event stream), not a log (tool names, ids and
 * payloads never reach it), and not the approval control: a waiting entry
 * says an approval is needed and what for, and the approval card stays the one
 * place it is answered. Every entry comes from `buildAgentActivityTimeline`,
 * which derives it from the session's real records; this component only draws.
 *
 * ## How state is carried
 *
 * By the glyph's shape, its accessible name and the words — never by colour
 * alone. Colour is spent where the existing status glyph spends it: the link
 * colour for "needs you", the destructive one for a failure. The one moving
 * thing is the ring of an entry that is in progress right now; reduced motion
 * stops it (globals.css) and the words say "in progress" either way.
 */

const STATUS_WORD: Record<AgentActivityStatus, string> = {
  active: "In progress",
  waiting: "Needs your attention",
  completed: "Done",
  failed: "Failed",
  info: "Update",
}

/** How many entries show before "Show earlier". A long session stays light. */
export const DEFAULT_VISIBLE_ACTIVITY = 40

function StatusGlyph({ entry }: { entry: AgentActivityEntry }) {
  const label = STATUS_WORD[entry.status]
  const common = "size-3.5 shrink-0"
  switch (entry.status) {
    case "active":
      return (
        <LoaderCircle role="img" aria-label={label} className={cn(common, "animate-spin text-muted-foreground [animation-duration:1.4s]")} />
      )
    case "waiting":
      return <CircleDot role="img" aria-label={label} className={cn(common, "text-link")} />
    case "failed":
      return <CircleAlert role="img" aria-label={label} className={cn(common, "text-destructive")} />
    case "completed":
      return entry.kind === "undone" ? (
        <Undo2 role="img" aria-label={label} className={cn(common, "text-muted-foreground")} />
      ) : (
        <CircleCheck role="img" aria-label={label} className={cn(common, "text-muted-foreground")} />
      )
    case "info":
      return entry.kind === "action_rejected" || entry.kind === "approval_closed" || entry.kind === "cancelled" ? (
        <CircleMinus role="img" aria-label={label} className={cn(common, "text-tertiary")} />
      ) : (
        <span role="img" aria-label={label} className="flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-1.5 rounded-full bg-tertiary" />
        </span>
      )
  }
}

function timeLabel(entry: AgentActivityEntry, now: number): string | null {
  return formatRelativeTime(activityTime(entry), now)
}

/** What a row says to a screen reader, in one sentence. */
function spokenEntry(entry: AgentActivityEntry): string {
  return [`${STATUS_WORD[entry.status]}: ${entry.title}`, entry.description].filter(Boolean).join(". ")
}

/** Everything a row draws, so an unchanged row is never re-rendered by a poll. */
function signatureOf(entry: AgentActivityEntry): string {
  return [entry.id, entry.status, entry.title, entry.description ?? "", activityTime(entry), entry.action?.kind ?? ""].join("|")
}

type RowProps = {
  entry: AgentActivityEntry
  last: boolean
  /** Minute-rounded, so the row re-renders only when its words change. */
  time: string | null
  onViewChange?: (changeId: string) => void
  onNewSession?: () => void
  /** Opens the session on the other end of a handoff. */
  onOpenSession?: (sessionId: string, provider: AgentProviderId) => void
  /** Set when the entry has more to show: opens it in the action inspector. */
  onInspect?: (entryId: string) => void
}

const TimelineRow = memo(
  function TimelineRow({ entry, last, time, onViewChange, onNewSession, onOpenSession, onInspect }: RowProps) {
    const at = activityTime(entry)
    const waiting = entry.status === "waiting"
    const action = entry.action
    return (
      <li
        data-activity-status={entry.status}
        data-activity-kind={entry.kind}
        aria-busy={entry.status === "active" || undefined}
        className="relative flex gap-2.5 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0"
      >
        {/*
          The rail: a glyph, and one unbroken line down to the next glyph —
          from just under this one to the bottom of the row, where the next
          row's glyph sits the same few pixels below its own top.
        */}
        <span className="relative flex w-3.5 shrink-0 justify-center pt-[3px]">
          <StatusGlyph entry={entry} />
          {!last && <span aria-hidden className="absolute top-5 bottom-0 left-1/2 w-px -translate-x-1/2 bg-strong" />}
        </span>

        <div
          className={cn(
            "min-w-0 flex-1",
            last ? "pb-0" : "pb-3",
            waiting && "-mx-1.5 mb-1 rounded-md bg-link/8 px-1.5 py-1"
          )}
        >
          {onInspect ? (
            /*
              The words themselves are the control — one tab stop per entry
              that has more to show, the same rectangle and focus ring as the
              session list. Actions under it stay separate buttons.
            */
            <button
              type="button"
              data-activity-inspect={entry.id}
              onClick={() => onInspect(entry.id)}
              className="group/inspect -mx-1.5 block w-[calc(100%+0.75rem)] rounded-xs px-1.5 text-left outline-none transition-colors duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <EntryWords entry={entry} at={at} time={time} waiting={waiting} inspectable />
            </button>
          ) : (
            <EntryWords entry={entry} at={at} time={time} waiting={waiting} />
          )}
          {waiting && entry.kind === "approval_required" && (
            <p className="text-meta text-muted-foreground">Answer it in the conversation to continue.</p>
          )}
          {action?.kind === "view_change" && onViewChange && (
            <Button type="button" size="xs" variant="ghost" className="-ml-2 mt-0.5" onClick={() => onViewChange(action.changeId)}>
              View
            </Button>
          )}
          {action?.kind === "new_session" && onNewSession && (
            <Button type="button" size="xs" variant="ghost" className="-ml-2 mt-0.5" onClick={onNewSession}>
              {/* A connection that never completed is retried; anything that ended starts afresh. */}
              {entry.kind === "connection_failed" ? "Try again" : "Start a new session"}
            </Button>
          )}
          {action?.kind === "open_session" && onOpenSession && (
            <Button type="button" size="xs" variant="ghost" className="-ml-2 mt-0.5" onClick={() => onOpenSession(action.sessionId, action.provider)}>
              Open {agentDisplayName(action.provider)} session
            </Button>
          )}
        </div>
      </li>
    )
  },
  (previous, next) =>
    previous.last === next.last &&
    previous.time === next.time &&
    previous.onViewChange === next.onViewChange &&
    previous.onNewSession === next.onNewSession &&
    previous.onOpenSession === next.onOpenSession &&
    previous.onInspect === next.onInspect &&
    signatureOf(previous.entry) === signatureOf(next.entry)
)

/** A row's title, time and description — the same words whether or not they open the inspector. */
function EntryWords({
  entry,
  at,
  time,
  waiting,
  inspectable = false,
}: {
  entry: AgentActivityEntry
  at: number
  time: string | null
  waiting: boolean
  inspectable?: boolean
}) {
  return (
    <>
      <span className="flex items-baseline gap-2">
        <span
          data-activity-title
          className={cn(
            "min-w-0 flex-1 text-body-sm",
            waiting ? "text-link" : entry.status === "info" ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {entry.title}
        </span>
        {time && (
          <time dateTime={new Date(at).toISOString()} className="shrink-0 text-meta text-tertiary">
            {time}
          </time>
        )}
        {inspectable && (
          <ChevronRight
            aria-hidden
            className="size-3 shrink-0 self-center text-tertiary transition-colors duration-(--duration-fast) ease-(--ease-color) group-hover/inspect:text-muted-foreground"
          />
        )}
      </span>
      {entry.description && (
        <span className="block truncate text-meta text-tertiary" title={entry.description}>
          {entry.description}
        </span>
      )}
      {inspectable && <span className="sr-only">Show details</span>}
    </>
  )
}

export type AgentActivityTimelineProps = {
  entries: readonly AgentActivityEntry[]
  /** The agent, for its mark and its name in the header and the list's label. */
  provider: string
  agentName: string
  /** The session's state in the shared visual vocabulary, for the mark. */
  state?: AgentVisualState
  /** The session's state in words, beside the mark ("Running", "Waiting for approval"). */
  statusLabel?: string
  now: number
  /** Opens what an applied workspace change did. */
  onViewChange?: (changeId: string) => void
  /** Offered on an entry the session cannot recover from. */
  onNewSession?: () => void
  /** Opens the session on the other end of a handoff (Hubble 1.4). */
  onOpenSession?: (sessionId: string, provider: AgentProviderId) => void
  /**
   * "Continue with…": hands this session's work to another agent. Offered by
   * the host only when the session can be handed on; absent, no button.
   */
  onContinue?: () => void
  /**
   * Opens an entry in the action inspector. Offered only on entries
   * `isInspectable` accepts — informational entries stay plain text.
   */
  onInspect?: (entryId: string) => void
  isInspectable?: (entry: AgentActivityEntry) => boolean
  maxVisible?: number
  /** Hide the agent line when the surrounding surface already names the agent. */
  showHeader?: boolean
  className?: string
}

function AgentActivityTimelineImpl({
  entries,
  provider,
  agentName,
  state = "idle",
  statusLabel,
  now,
  onViewChange,
  onNewSession,
  onOpenSession,
  onContinue,
  onInspect,
  isInspectable,
  maxVisible = DEFAULT_VISIBLE_ACTIVITY,
  showHeader = true,
  className,
}: AgentActivityTimelineProps) {
  const [expanded, setExpanded] = useState(false)
  const newestFirst = useMemo(() => [...entries].reverse(), [entries])
  const visible = expanded ? newestFirst : newestFirst.slice(0, maxVisible)
  const hidden = newestFirst.length - visible.length

  /*
    Said once per change, politely: the newest entry, or the approval that
    needs an answer. Not on mount — opening the panel is not news — and not
    on a poll that changed nothing.
  */
  const newest = newestFirst[0]
  const waitingEntry = newestFirst.find((entry) => entry.status === "waiting")
  const headline = waitingEntry ?? newest
  const spoken = headline ? spokenEntry(headline) : ""
  const [announcement, setAnnouncement] = useState("")
  const previous = useRef<string | null>(null)
  useEffect(() => {
    if (previous.current === null) {
      previous.current = spoken
      return
    }
    if (spoken === previous.current) return
    previous.current = spoken
    // Speaking to an assistive technology about an external change, which is what this effect is for.
    setAnnouncement(spoken)
  }, [spoken])

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      {showHeader && (
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground">
            <AgentIcon connector={provider} state={state} size="sm" />
          </span>
          <span className="min-w-0 truncate text-label text-foreground">{agentName}</span>
          {statusLabel && <span className="ml-auto shrink-0 text-meta text-tertiary">{statusLabel}</span>}
        </div>
      )}
      {onContinue && (
        <Button type="button" size="xs" variant="outline" className="mb-2.5 self-start" onClick={onContinue} aria-haspopup="dialog" data-handoff-continue>
          Continue with…
        </Button>
      )}

      {entries.length === 0 ? (
        <p className="text-body-sm text-tertiary">Nothing yet. What {agentName} does will appear here as it happens.</p>
      ) : (
        <ol aria-label={`${agentName} activity, newest first`} className="flex flex-col">
          {visible.map((entry, index) => (
            <TimelineRow
              key={entry.id}
              entry={entry}
              last={index === visible.length - 1}
              time={timeLabel(entry, now)}
              {...(onViewChange ? { onViewChange } : {})}
              {...(onNewSession ? { onNewSession } : {})}
              {...(onOpenSession ? { onOpenSession } : {})}
              {...(onInspect && isInspectable?.(entry) ? { onInspect } : {})}
            />
          ))}
        </ol>
      )}

      {hidden > 0 && (
        <Button type="button" size="xs" variant="ghost" className="-ml-2 mt-1 self-start" onClick={() => setExpanded(true)}>
          Show {hidden} earlier
        </Button>
      )}
      {expanded && newestFirst.length > maxVisible && (
        <Button type="button" size="xs" variant="ghost" className="-ml-2 mt-1 self-start" onClick={() => setExpanded(false)}>
          Show less
        </Button>
      )}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

export const AgentActivityTimeline = memo(AgentActivityTimelineImpl)
AgentActivityTimeline.displayName = "AgentActivityTimeline"
