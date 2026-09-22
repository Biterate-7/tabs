"use client"

import { memo, useEffect, useRef } from "react"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import { EVENT_PRESENTATION } from "@/lib/agents/command-centre/presentation"
import { cn } from "@/lib/utils"
import type { SequencedControlEvent } from "@/lib/agents/runtime/protocol"

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
 * stream, which would be motion asserting a fact TabDump does not have.
 */

/** A single-line row: activity and lifecycle both use it, at the same density. */
const QuietRow = memo(function QuietRow({ event }: { event: SequencedControlEvent }) {
  const presentation = EVENT_PRESENTATION[event.kind]

  return (
    <li className="flex items-baseline gap-2 py-0.5">
      <span
        aria-hidden
        className={cn("select-none text-meta leading-5", AGENT_TONE_TEXT_CLASS[presentation.tone])}
      >
        ●
      </span>
      <span className="shrink-0 text-label text-muted-foreground">{presentation.label}</span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-tertiary">{event.summary}</span>
      {/*
        The tool or file the event concerns, when it named one.

        Rendered as the row's trailing detail rather than folded into the
        summary, so a long file path truncates on its own instead of pushing
        the label off the line.
      */}
      {event.file ? (
        <span
          className="shrink-0 truncate font-mono text-meta text-tertiary"
          title={event.file.relativePath}
        >
          {event.file.relativePath}
        </span>
      ) : event.tool ? (
        <span className="shrink-0 text-label text-tertiary">{event.tool.name}</span>
      ) : null}
    </li>
  )
})

/** What the user said. Boxed, because it is an instruction rather than prose. */
const UserMessage = memo(function UserMessage({ event }: { event: SequencedControlEvent }) {
  return (
    <li className="py-2">
      <p className="rounded-md border border-subtle bg-surface px-3 py-2 text-body-sm whitespace-pre-wrap text-foreground">
        {event.summary}
      </p>
    </li>
  )
})

/** What the agent said. Unboxed prose — the thing the user is actually reading. */
const AgentMessage = memo(function AgentMessage({ event }: { event: SequencedControlEvent }) {
  return (
    <li className="py-2">
      <p className="text-body-sm whitespace-pre-wrap text-foreground">{event.summary}</p>
    </li>
  )
})

export function EventStream({
  events,
  /** Rendered under the last event — the approval block and the live indicator live there. */
  children,
  className,
}: {
  events: readonly SequencedControlEvent[]
  children?: React.ReactNode
  className?: string
}) {
  const endRef = useRef<HTMLDivElement | null>(null)
  const countRef = useRef(events.length)

  /*
    Follows the stream only when it grows.

    Keyed on the count rather than the array so that a poll which returned no
    new events does not yank the viewport away from something the user had
    scrolled back to read.
  */
  useEffect(() => {
    if (events.length === countRef.current) return
    countRef.current = events.length
    endRef.current?.scrollIntoView({ block: "end" })
  }, [events.length])

  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>
      {/*
        Named, because the surface has two lists — this and the session rail —
        and a screen-reader user landing on an unnamed one has to read into it
        to find out which.
      */}
      <ol aria-label="Session events" className="mx-auto flex w-full max-w-3xl flex-col px-6 py-4">
        {events.map((event) => {
          const presentation = EVENT_PRESENTATION[event.kind]

          if (presentation.register === "message") {
            return presentation.speaker === "user" ? (
              <UserMessage key={event.id} event={event} />
            ) : (
              <AgentMessage key={event.id} event={event} />
            )
          }

          return <QuietRow key={event.id} event={event} />
        })}
        {children}
      </ol>
      <div ref={endRef} />
    </div>
  )
}
