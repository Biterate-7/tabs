"use client"

import { memo, useEffect, useMemo, useRef } from "react"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import { Button } from "@/components/ui/button"
import {
  CONTEXT_TOOL_STAGE_LABEL,
  EVENT_PRESENTATION,
  planOutcomeLabel,
  toolDisplayName,
  toolStage,
} from "@/lib/agents/command-centre/presentation"
import { buildTranscript } from "@/lib/agents/platform/chat"
import { describeStep } from "@/lib/agents/command-centre/workspace-activity"
import { cn } from "@/lib/utils"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { TranscriptItem } from "@/lib/agents/platform/chat"
import type { RuntimePlanOutcomeView, SequencedControlEvent } from "@/lib/agents/runtime/protocol"
import type { AgentVisualTone } from "@/lib/agents/visual/types"

/**
 * The session's normalized event stream.
 *
 * ## Why this is not a chat component
 *
 * A control session produces nineteen kinds of event and only two of them are
 * messages. The rest — a tool starting, a file being modified, a run being
 * cancelled — are what the agent *did*, and flattening them into chat bubbles
 * would either hide them or make the transcript unreadable. So the stream
 * renders three registers at three densities (see `EVENT_PRESENTATION`): the
 * conversation is the spine, activity is a dim single line, and lifecycle
 * facts are quieter still.
 *
 * ## What it never does
 *
 * It does not parse a provider payload. Every field it reads —
 * `kind`, `summary`, `tool`, `file` — is on the normalized `AgentControlEvent`
 * that the control plane produced, and the component has no branch on which
 * provider produced it. Claude's SDK shapes stop at the adapter.
 *
 * It also does not fake streaming. An event appears when the runtime has
 * reported it; there is no per-character animation pretending to be a token
 * stream, which would be motion asserting a fact Hubble does not have.
 *
 * Since Phase J the messages carry their whole text, and a provider that
 * streams sends real pieces (`message_delta`) that are shown joined as they
 * arrive. The grouping lives in `buildTranscript`, not here.
 */

/** A single-line row: activity and lifecycle both use it, at the same density. */
const QuietRow = memo(function QuietRow({
  event,
  outcome,
}: {
  event: SequencedControlEvent
  /** What became of the plan this row approved (J.5), said on the row where the user approved it. */
  outcome?: { text: string; tone: AgentVisualTone }
}) {
  const presentation = EVENT_PRESENTATION[event.kind]

  /*
    Some events have nothing to add to their own label.

    `session_started` normalizes to the summary "Session started." under the
    label "Session started", so the row rendered the same words twice with a
    full stop between them. Rather than special-casing that one kind, the row
    drops a summary that only restates the label — which is the general shape
    of the problem, and leaves every event whose summary carries real detail
    ("Reviewing 12 attached tabs") untouched.
  */
  const restatesLabel =
    event.summary.replace(/[.\s]+$/, "").toLowerCase() === presentation.label.toLowerCase()

  /*
    A tool event whose summary is only the tool name says it in words once.
    The raw name of a Hubble context tool is a protocol identifier
    ("mcp__tabdump_<id>__list_tabs"), never something to show a person, and
    repeating any tool name as the trailing detail says the same thing twice.
  */
  const namesOnlyTheTool = event.tool !== undefined && event.summary.trim() === event.tool.name
  const summary = namesOnlyTheTool && event.tool ? toolDisplayName(event.tool.name) : event.summary

  return (
    <li className="flex items-baseline gap-1.5 py-1">
      {presentation.tone === "bad" && (
        <span aria-hidden className="select-none text-meta text-destructive">
          ●
        </span>
      )}
      <span className="shrink-0 text-body-sm text-muted-foreground">{presentation.label}</span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-tertiary">
        {restatesLabel ? "" : summary}
        {outcome && (
          <span className={cn("ml-1.5", AGENT_TONE_TEXT_CLASS[outcome.tone])}>
            · {outcome.text}
          </span>
        )}
      </span>
      {/*
        The tool or file the event concerns, when it named one.

        Rendered as the row's trailing detail rather than folded into the
        summary, so a long file path truncates on its own instead of pushing
        the label off the line.
      */}
      {event.file ? (
        <span
          className="min-w-0 max-w-[45%] shrink truncate text-body-sm text-tertiary"
          title={event.file.relativePath}
        >
          {event.file.relativePath}
        </span>
      ) : event.tool ? (
        <span className="flex min-w-0 max-w-[50%] shrink items-baseline gap-1.5 max-sm:hidden">
          <ToolStage name={event.tool.name} />
          {!namesOnlyTheTool && (
            <span className="truncate text-body-sm text-tertiary">{toolDisplayName(event.tool.name)}</span>
          )}
        </span>
      ) : null}
    </li>
  )
})

/**
 * Where the agent is in the loop, for a Hubble context call (J.6): Reading,
 * Analyzing, Checking a plan, or Proposing — the one stage an approval card
 * follows. Other tools get nothing: a stage is only claimed for calls Hubble
 * itself serves.
 */
function ToolStage({ name }: { name: string }) {
  const stage = toolStage(name)
  if (!stage) return null
  return (
    <span
      data-stage={stage}
      className={cn(
        "rounded-xs px-1 text-meta",
        stage === "proposing" ? "bg-link/12 text-link" : "bg-surface-hover text-muted-foreground"
      )}
    >
      {CONTEXT_TOOL_STAGE_LABEL[stage]}
    </span>
  )
}

/** What the user said. Boxed, because it is an instruction rather than prose. */
const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  return (
    <li className="py-2">
      <p className="rounded-md border border-border bg-card px-2.5 py-1.5 text-body whitespace-pre-wrap text-foreground">
        {text}
      </p>
    </li>
  )
})

/**
 * What the agent said. Unboxed prose — the thing the user is actually reading.
 *
 * Rendered as plain text, never as HTML or markdown-to-HTML: a reply is model
 * output, and model output can quote a page that was written to be injected.
 * `streaming` marks a reply whose pieces are still arriving (Phase J); the
 * cursor is a static mark, not an animation pretending to be typing.
 */
const AgentMessage = memo(function AgentMessage({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <li className="py-2" aria-busy={streaming || undefined}>
      <p className="text-body whitespace-pre-wrap text-foreground">
        {text}
        {streaming && (
          <span aria-hidden className="ml-0.5 text-tertiary">
            ▍
          </span>
        )}
      </p>
    </li>
  )
})

/**
 * What an agent changed in the workspace, where it happened in the session:
 * "Updated Research · Created collection “Physics Sources” · 4 tabs".
 *
 * Written from what the Command Centre applied — names and counts, never a
 * tool name or an id — so a person reads what changed, not how. "View" goes
 * to it; "Undo" is offered only while the workspace is still exactly as the
 * change left it (see `restoreCollections`), and is otherwise absent rather
 * than offered and refused.
 */
const WorkspaceChangeRow = memo(function WorkspaceChangeRow({
  change,
  workspaceName,
  onView,
  onUndo,
}: {
  change: AppliedWorkspaceChange
  workspaceName?: string
  onView?: () => void
  onUndo?: () => void
}) {
  const where = workspaceName ?? "the workspace"
  const summary = change.ok ? change.steps.map(describeStep).join(" · ") : `Nothing changed in ${where}`
  return (
    <li data-workspace-change className="flex items-baseline gap-1.5 py-1">
      {!change.ok && (
        <span aria-hidden className="select-none text-meta text-destructive">
          ●
        </span>
      )}
      <span className={cn("shrink-0 text-body-sm", change.ok ? "text-muted-foreground" : "text-destructive")}>
        {change.ok ? `Updated ${where}` : "Couldn't apply the approved change"}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-body-sm text-tertiary", change.undone && "line-through")}>{summary}</span>
      {change.undone ? (
        <span className="shrink-0 text-meta text-tertiary">Undone</span>
      ) : (
        change.ok && (
          <span className="flex shrink-0 items-center gap-0.5">
            {onView && (
              <Button type="button" size="xs" variant="ghost" onClick={onView}>
                View
              </Button>
            )}
            {onUndo && (
              <Button type="button" size="xs" variant="ghost" onClick={onUndo}>
                Undo
              </Button>
            )}
          </span>
        )
      )}
    </li>
  )
})

type StreamRow = { type: "transcript"; item: TranscriptItem } | { type: "change"; change: AppliedWorkspaceChange }

/** Changes placed among the transcript by when they happened. */
function interleave(transcript: readonly TranscriptItem[], changes: readonly AppliedWorkspaceChange[]): StreamRow[] {
  const pending = [...changes].sort((a, b) => a.at - b.at)
  const rows: StreamRow[] = []
  let next = 0
  for (const item of transcript) {
    const at = item.type === "message" ? item.timestamp : item.event.timestamp
    while (next < pending.length && pending[next]!.at < at) rows.push({ type: "change", change: pending[next++]! })
    rows.push({ type: "transcript", item })
  }
  while (next < pending.length) rows.push({ type: "change", change: pending[next++]! })
  return rows
}

export function EventStream({
  events,
  planOutcomes,
  changes,
  workspaceName,
  onViewChange,
  onUndoChange,
  canUndoChange,
  /** Rendered under the last event — the approval block and the live indicator live there. */
  children,
  className,
}: {
  events: readonly SequencedControlEvent[]
  /** How the session's approved plans ended (J.5), matched to their approvals by id. */
  planOutcomes?: readonly RuntimePlanOutcomeView[]
  /** What the Command Centre applied for this session, in words. */
  changes?: readonly AppliedWorkspaceChange[]
  workspaceName?: string
  onViewChange?: (change: AppliedWorkspaceChange) => void
  onUndoChange?: (change: AppliedWorkspaceChange) => void
  canUndoChange?: (change: AppliedWorkspaceChange) => boolean
  children?: React.ReactNode
  className?: string
}) {
  const outcomeByApproval = useMemo(() => {
    const map = new Map<string, { text: string; tone: AgentVisualTone }>()
    for (const outcome of planOutcomes ?? []) if (outcome.approvalId) map.set(outcome.approvalId, planOutcomeLabel(outcome))
    return map
  }, [planOutcomes])
  const endRef = useRef<HTMLDivElement | null>(null)
  const countRef = useRef(events.length)
  // The conversation, derived from the window of events on every render —
  // one model for every provider. See lib/agents/platform/chat.ts.
  /*
    Each read Hubble's context server answered is the activity timeline's to
    tell, grouped into "Read workspace · 18 tabs" there. One row per call here
    would bury the conversation under its own bookkeeping.
  */
  const transcript = useMemo(
    () => buildTranscript(events).filter((item) => item.type !== "event" || item.event.kind !== "context_read"),
    [events]
  )
  const rows = useMemo(() => interleave(transcript, changes ?? []), [transcript, changes])

  /*
    Follows the stream only when it grows.

    Keyed on the count rather than the array so that a poll which returned no
    new events does not yank the viewport away from something the user had
    scrolled back to read.
  */
  const growth = events.length + (changes?.length ?? 0)
  useEffect(() => {
    if (growth === countRef.current) return
    countRef.current = growth
    // "nearest", not "end": inside the stream's own scroller the two are the
    // same (the end is below the fold, so it aligns to the bottom), but "end"
    // also scrolled every ancestor — a page hosting the stream (the landing
    // page's demo) jumped on every new event.
    endRef.current?.scrollIntoView({ block: "nearest" })
  }, [growth])

  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>
      {/*
        Named, because the surface has two lists — this and the session rail —
        and a screen-reader user landing on an unnamed one has to read into it
        to find out which.
      */}
      <ol aria-label="Session events" className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-5">
        {rows.map((row) => {
          if (row.type === "change") {
            const change = row.change
            return (
              <WorkspaceChangeRow
                key={`change-${change.id}`}
                change={change}
                {...(workspaceName ? { workspaceName } : {})}
                {...(onViewChange ? { onView: () => onViewChange(change) } : {})}
                {...(onUndoChange && canUndoChange?.(change) ? { onUndo: () => onUndoChange(change) } : {})}
              />
            )
          }
          const item = row.item
          if (item.type === "message") {
            return item.role === "user" ? (
              <UserMessage key={item.id} text={item.text} />
            ) : (
              <AgentMessage key={item.id} text={item.text} streaming={item.streaming} />
            )
          }

          const outcome =
            item.event.kind === "approval_granted" && item.event.approvalId
              ? outcomeByApproval.get(item.event.approvalId)
              : undefined
          return <QuietRow key={item.id} event={item.event} {...(outcome ? { outcome } : {})} />
        })}
        {children}
      </ol>
      <div ref={endRef} />
    </div>
  )
}
