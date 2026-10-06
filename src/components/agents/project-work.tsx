"use client"

import { useState } from "react"
import { ChevronDown, CircleAlert, CircleCheck, CircleMinus, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PROJECT_CHECK_LABELS } from "@/lib/agents/project/checks"
import { lineCountsText, REVIEW_NOTE_TEXT } from "@/lib/agents/project/changes"
import { cn } from "@/lib/utils"
import type { VerificationLine } from "@/lib/agents/activity/inspector"
import type { ProjectCheck, ProjectCheckId } from "@/lib/agents/project/checks"
import type { ControlProjectUndoInfo } from "@/lib/agents/control/events"
import type { ProjectChangeReview } from "@/lib/agents/project/changes"

/**
 * Project work in the Action Inspector (Hubble 1.6): the checks run on a
 * change, the buttons that run more, and the line-by-line review — all from
 * the runtime's own records, and only in a live session.
 */

/** What a live session can do about its project changes. Absent: a past session, read-only. */
export type ProjectWorkActions = {
  undo: (changeId: string) => Promise<Pick<ControlProjectUndoInfo, "outcome" | "reason" | "files"> | null>
  review: (changeId: string) => Promise<ProjectChangeReview | null>
  /** The checks this project offers, exactly as they would run. */
  checks: readonly ProjectCheck[]
  runCheck: (check: ProjectCheckId) => Promise<boolean>
  /** A check is running in this session. */
  checking: boolean
}

export function VerificationList({ lines }: { lines: readonly VerificationLine[] }) {
  return (
    <ul aria-label="Verification" className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line.checkId} className="flex min-w-0 items-start gap-1.5">
          <span className="pt-[3px]">
            {line.tone === "active" ? (
              <LoaderCircle aria-hidden className="size-3.5 animate-spin text-muted-foreground [animation-duration:1.4s]" />
            ) : line.tone === "success" ? (
              <CircleCheck aria-hidden className="size-3.5 text-success" />
            ) : line.tone === "failure" ? (
              <CircleAlert aria-hidden className="size-3.5 text-destructive" />
            ) : (
              <CircleMinus aria-hidden className="size-3.5 text-tertiary" />
            )}
          </span>
          <span className="min-w-0">
            <span className={cn("block", line.tone === "failure" && "text-destructive")}>{line.title}</span>
            {line.detail && <span className="block text-meta text-tertiary">{line.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The checks a person can run on the change — each shows what it runs before it runs it. */
export function ProjectCheckButtons({ actions }: { actions: ProjectWorkActions }) {
  const [refused, setRefused] = useState(false)
  if (actions.checks.length === 0) {
    return <p className="text-meta text-tertiary">This project defines no checks Hubble can run.</p>
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1.5">
        {actions.checks.map((check) => (
          <Button
            key={check.id}
            type="button"
            size="xs"
            variant="outline"
            title={check.command}
            aria-label={`Run ${PROJECT_CHECK_LABELS[check.id].toLowerCase()}: ${check.command}`}
            disabled={actions.checking}
            onClick={() => {
              setRefused(false)
              void actions.runCheck(check.id).then((ok) => setRefused(!ok))
            }}
          >
            {PROJECT_CHECK_LABELS[check.id]}
          </Button>
        ))}
      </div>
      <p className="text-meta text-tertiary">
        {actions.checking ? "A check is running." : "Runs the project's own command on this machine. Nothing is sent to the agent."}
      </p>
      {refused && <p role="alert" className="text-meta text-warning">Hubble couldn&apos;t start that check.</p>}
    </div>
  )
}

/** The changed lines of a measured change — fetched on request, while the runtime still holds them. */
export function ProjectChangeReviewToggle({ changeId, actions }: { changeId: string; actions: ProjectWorkActions }) {
  const [state, setState] = useState<{ kind: "closed" } | { kind: "loading" } | { kind: "open"; review: ProjectChangeReview } | { kind: "gone" }>({ kind: "closed" })
  const open = state.kind === "open" || state.kind === "loading"
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="-ml-2 self-start text-muted-foreground"
        aria-expanded={open}
        onClick={() => {
          if (open) return setState({ kind: "closed" })
          setState({ kind: "loading" })
          void actions.review(changeId).then((review) => setState(review ? { kind: "open", review } : { kind: "gone" }))
        }}
      >
        <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
        {open ? "Hide changes" : "Review changes"}
      </Button>
      {state.kind === "loading" && <p className="text-meta text-tertiary">Loading…</p>}
      {state.kind === "gone" && <p className="text-meta text-tertiary">{PROJECT_CHANGE_GONE}</p>}
      {state.kind === "open" && <ProjectChangeDiff review={state.review} />}
    </div>
  )
}

/** Said when a review is asked for and the runtime no longer holds the change. */
export const PROJECT_CHANGE_GONE = "Hubble no longer holds this change, so it can't show it."

/** A measured change, line by line — the one renderer the inspector and the task status share. */
export function ProjectChangeDiff({ review, className }: { review: ProjectChangeReview; className?: string }) {
  return (
    <div aria-label="Changed lines" className={cn("flex flex-col gap-2", className)}>
      {review.files.map((file) => (
        <div key={file.path} className="min-w-0">
          <p className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate font-mono text-meta text-foreground" title={file.path}>
              {file.path}
            </span>
            {lineCountsText(file) && <span className="shrink-0 font-mono text-meta text-tertiary">{lineCountsText(file)}</span>}
          </p>
          {file.note ? (
            <p className="text-meta text-tertiary">{REVIEW_NOTE_TEXT[file.note]}</p>
          ) : (
            <pre className="mt-0.5 max-h-72 overflow-auto rounded-sm border border-subtle bg-surface py-1 font-mono text-code">
              {(file.hunks ?? []).map((hunk, index) => (
                <div key={index}>
                  {index > 0 && <div className="px-2 text-tertiary">⋯</div>}
                  {hunk.lines.map((line, lineIndex) => (
                    <div
                      key={lineIndex}
                      className={cn(
                        "px-2 whitespace-pre-wrap break-all",
                        line.sign === "+" && "bg-success/10 text-foreground",
                        line.sign === "-" && "bg-destructive/10 text-foreground",
                        line.sign === " " && "text-muted-foreground"
                      )}
                    >
                      <span aria-hidden className="mr-2 select-none text-tertiary">
                        {line.sign === " " ? " " : line.sign === "-" ? "−" : "+"}
                      </span>
                      <span className="sr-only">{line.sign === "+" ? "Added: " : line.sign === "-" ? "Removed: " : ""}</span>
                      {line.text}
                    </div>
                  ))}
                </div>
              ))}
              {file.truncated && <div className="px-2 text-tertiary">More changes not shown.</div>}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
