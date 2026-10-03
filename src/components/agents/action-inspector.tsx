"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronLeft, CircleAlert, CircleCheck, CircleDot, CircleMinus, LoaderCircle, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentIcon } from "./agent-icon"
import { AgentStatusPill } from "./agent-status-pill"
import { formatTimeAgo } from "./agent-session-presentation"
import { ACTION_STATUS_LABEL, ACTION_VISUAL_STATE } from "@/lib/agents/activity/inspector"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import type { ActionChainStep, ActionChangeLine, ActionInspection } from "@/lib/agents/activity/inspector"

/**
 * One agent action, opened from the activity timeline: what was asked, who
 * allowed it, what happened, what changed — and, where Hubble knows the exact
 * inverse, Undo.
 *
 *     ‹ Activity
 *     Created collection “Pricing Research”
 *     ● Completed   Claude Code · Research
 *
 *     ✓ Requested by Claude Code        2 min
 *     ✓ Approved                        2 min
 *     ✓ Completed                       Just now
 *
 *     Action     Create collection
 *     Result     Created “Pricing Research” in Research.
 *     Changes    + Collection “Pricing Research” · 5 tabs
 *
 *     [Open collection]  [Undo]
 *
 * ## An extension of the timeline, not a second surface
 *
 * It opens in place of the list, inside whatever holds the timeline — the
 * context panel, or the header's activity popover — so the conversation and
 * the workspace stay on screen beside it. The rail, glyphs, type and tones
 * are the timeline's own; the status pill is the session header's.
 *
 * ## Only what exists
 *
 * Every section is optional and drawn only when the inspection has it. There
 * is no "Open file" (Hubble cannot open a project's files) and no line counts
 * (no record carries them). Undo is a button only when it can work; otherwise
 * one sentence says why not.
 *
 * ## Undo, lightly confirmed
 *
 * Undo asks once, inline — "Undo this change?" with exactly what it will do —
 * never a modal over the workspace. A refused undo leaves the workspace as it
 * was and says so, with Try again.
 */

function timeLabel(at: number | undefined, now: number): string | null {
  if (at === undefined) return null
  if (now - at < 60_000) return "Just now"
  return formatTimeAgo(at, now)
}

function ChainGlyph({ step }: { step: ActionChainStep }) {
  const common = "size-3.5 shrink-0"
  if (step.key === "undone") return <Undo2 aria-hidden className={cn(common, "text-muted-foreground")} />
  switch (step.tone) {
    case "active":
      return <LoaderCircle aria-hidden className={cn(common, "animate-spin text-muted-foreground [animation-duration:1.4s]")} />
    case "waiting":
      return <CircleDot aria-hidden className={cn(common, "text-link")} />
    case "failed":
      return <CircleAlert aria-hidden className={cn(common, "text-destructive")} />
    case "neutral":
      return <CircleMinus aria-hidden className={cn(common, "text-tertiary")} />
    case "done":
      return <CircleCheck aria-hidden className={cn(common, "text-muted-foreground")} />
  }
}

const SIGN: Record<ActionChangeLine["sign"], string> = { add: "+", change: "~", remove: "−" }
const SIGN_WORD: Record<ActionChangeLine["sign"], string> = { add: "Added", change: "Changed", remove: "Removed" }

/** A labelled fact. The inspector's only repeated unit — the context panel's label/value, stacked to fit. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <dt className="text-meta text-tertiary">{label}</dt>
      <dd className="mt-0.5 text-body-sm text-foreground">{children}</dd>
    </div>
  )
}

type UndoPhase = { kind: "idle" } | { kind: "confirming" } | { kind: "failed" }

export function ActionInspector({
  inspection,
  now,
  onBack,
  onView,
  onUndo,
  autoFocus = true,
  className,
}: {
  inspection: ActionInspection
  now: number
  onBack: () => void
  /** Shows the applied change in its workspace. */
  onView?: (changeId: string) => void
  /** Reverses an applied change exactly. Returns whether it was undone; `false` means nothing moved. */
  onUndo?: (changeId: string) => boolean
  /** Move focus to the heading on open. Off where taking focus would scroll a host page. */
  autoFocus?: boolean
  className?: string
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (autoFocus) headingRef.current?.focus({ preventScroll: true })
    // Once per action opened: a live update to the same action keeps focus where the person put it.
  }, [autoFocus, inspection.key])

  const [phase, setPhase] = useState<UndoPhase>({ kind: "idle" })
  const [trackedKey, setTrackedKey] = useState(inspection.key)
  if (trackedKey !== inspection.key) {
    setTrackedKey(inspection.key)
    setPhase({ kind: "idle" })
  }

  const undo = inspection.undo
  const canUndo = undo?.kind === "available" && Boolean(onUndo)
  const tone = AGENT_VISUAL_STATE_PRESENTATION[ACTION_VISUAL_STATE[inspection.status]].tone

  const runUndo = () => {
    if (undo?.kind !== "available" || !onUndo) return
    let undone = false
    try {
      undone = onUndo(undo.changeId)
    } catch {
      undone = false
    }
    setPhase(undone ? { kind: "idle" } : { kind: "failed" })
  }

  return (
    <article
      data-action-inspector
      data-action-status={inspection.status}
      aria-labelledby={`action-inspector-${inspection.key}`}
      className={cn("flex min-w-0 flex-col duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0", className)}
    >
      <Button type="button" size="xs" variant="ghost" className="-ml-1.5 self-start" onClick={onBack}>
        <ChevronLeft />
        All activity
      </Button>

      <h3
        ref={headingRef}
        id={`action-inspector-${inspection.key}`}
        tabIndex={-1}
        className="mt-1.5 text-body-sm font-medium text-foreground outline-none"
      >
        {inspection.title}
      </h3>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <AgentStatusPill tone={tone} label={ACTION_STATUS_LABEL[inspection.status]} />
        <span className="flex min-w-0 items-center gap-1 text-meta text-tertiary">
          <span className="text-muted-foreground">
            <AgentIcon connector={inspection.provider} size="xs" />
          </span>
          <span className="truncate">
            {inspection.agentName}
            {inspection.workspaceName ? ` · ${inspection.workspaceName}` : ""}
          </span>
        </span>
      </div>

      {inspection.chain.length > 0 && (
        <ol aria-label="What happened" className="mt-3 flex flex-col">
          {inspection.chain.map((step, index) => {
            const time = timeLabel(step.at, now)
            const last = index === inspection.chain.length - 1
            return (
              <li key={step.key} className="relative flex gap-2.5">
                <span className="relative flex w-3.5 shrink-0 justify-center pt-[3px]">
                  <ChainGlyph step={step} />
                  {!last && <span aria-hidden className="absolute top-5 bottom-0 left-1/2 w-px -translate-x-1/2 bg-strong" />}
                </span>
                <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", last ? "pb-0" : "pb-2")}>
                  <span className={cn("min-w-0 flex-1 text-body-sm", step.tone === "waiting" ? "text-link" : "text-foreground")}>
                    {step.label}
                  </span>
                  {time && step.at !== undefined && (
                    <time dateTime={new Date(step.at).toISOString()} className="shrink-0 text-meta text-tertiary">
                      {time}
                    </time>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}

      <dl className="mt-2 flex flex-col border-t border-subtle pt-1.5">
        {inspection.action && <Fact label="Action">{inspection.action}</Fact>}
        {inspection.request && (
          <Fact label="Original request">
            {inspection.request.summary}
            {inspection.request.reason && (
              <span className="mt-0.5 block text-meta text-muted-foreground">{inspection.request.reason}</span>
            )}
          </Fact>
        )}
        {inspection.status === "waiting_for_approval" && (
          <Fact label="Approval">
            <span className="text-link">Answer it in the conversation to continue.</span>
          </Fact>
        )}
        {inspection.result && (
          <Fact label="Result">
            <span
              className={cn(
                inspection.result.tone === "failure" && "text-destructive",
                inspection.result.tone === "warning" && "text-warning",
                inspection.result.tone === "neutral" && "text-muted-foreground"
              )}
            >
              {inspection.result.text}
            </span>
          </Fact>
        )}
        {inspection.changes && (
          <Fact label={inspection.changes.planned ? "Requested changes" : "Changes"}>
            <ul className="flex flex-col">
              {inspection.changes.lines.map((line, index) => (
                <li key={index} className="flex min-w-0 items-baseline gap-1.5">
                  <span aria-hidden className="w-2.5 shrink-0 text-center font-mono text-meta text-tertiary">
                    {SIGN[line.sign]}
                  </span>
                  <span className="sr-only">{SIGN_WORD[line.sign]}: </span>
                  <span className={cn("min-w-0 break-words", inspection.status === "undone" && "text-muted-foreground")}>{line.text}</span>
                </li>
              ))}
            </ul>
          </Fact>
        )}
        {inspection.file && (
          <Fact label="File">
            <span className="break-all">{inspection.file.relativePath}</span>
            {inspection.file.projectName && <span className="block text-meta text-tertiary">In {inspection.file.projectName}</span>}
          </Fact>
        )}
      </dl>

      {(inspection.view || canUndo) && phase.kind === "idle" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {inspection.view && onView && (
            <Button type="button" size="sm" variant="outline" onClick={() => onView(inspection.view!.changeId)}>
              {inspection.view.label}
            </Button>
          )}
          {canUndo && undo?.kind === "available" && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setPhase({ kind: "confirming" })}>
              <Undo2 />
              {undo.label}
            </Button>
          )}
        </div>
      )}

      {undo?.kind === "unavailable" && <p className="mt-2 text-meta text-tertiary">{undo.reason}</p>}
      {undo?.kind === "done" && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-meta text-muted-foreground">
          <Undo2 aria-hidden className="size-3" />
          Undone{timeLabel(undo.at, now) ? ` · ${timeLabel(undo.at, now)}` : ""}. The original action stays in the activity.
        </p>
      )}

      {phase.kind === "confirming" && canUndo && undo?.kind === "available" && (
        <div role="group" aria-label="Undo this change?" className="mt-2 rounded-md border border-border bg-surface px-3 py-2">
          <p className="text-body-sm text-foreground">Undo this change?</p>
          <p className="mt-0.5 text-meta text-tertiary">This will:</p>
          <ul className="mt-0.5 flex flex-col">
            {undo.effects.map((effect) => (
              <li key={effect} className="text-body-sm text-muted-foreground">
                {effect}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={runUndo}>
              Undo change
            </Button>
          </div>
        </div>
      )}

      {phase.kind === "failed" && (
        <div role="alert" className="mt-2 rounded-md border border-destructive/40 bg-surface px-3 py-2">
          <p className="text-body-sm text-foreground">Couldn&apos;t undo this change</p>
          <p className="mt-0.5 text-meta text-tertiary">The workspace has not been modified.</p>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </Button>
            {canUndo && (
              <Button type="button" size="sm" variant="secondary" onClick={runUndo}>
                Try again
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
