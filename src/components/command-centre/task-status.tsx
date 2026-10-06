"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { AgentStatusGlyph } from "@/components/agents/agent-status-glyph"
import { PROJECT_CHANGE_GONE, ProjectChangeDiff } from "@/components/agents/project-work"
import { Button } from "@/components/ui/button"
import { TASK_STATE_LABEL, taskOutcomeFacts } from "@/lib/agents/activity/outcome"
import { PROJECT_CHECK_LABELS } from "@/lib/agents/project/checks"
import { recordLoopMilestone } from "@/lib/product/loop-log"
import { cn } from "@/lib/utils"
import type { ProjectWorkActions } from "@/components/agents/project-work"
import type { TaskOutcome, TaskState } from "@/lib/agents/activity/outcome"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { ProjectCheckId } from "@/lib/agents/project/checks"
import type { ProjectChangeReview } from "@/lib/agents/project/changes"
import type { AgentVisualState } from "@/lib/agents/visual/types"

/**
 * Where the agent's task stands, above the composer (Stage 3):
 *
 *     ✓ Done · Changed 2 files in hubble-app          Review changes  Run tests  Continue with…
 *       “Fix the authentication bug.” · +17 −6 · Checks not run
 *
 * Mission control's one line. It answers, without opening anything, the
 * questions a developer asks of an agent they delegated to: is it working,
 * does it need me, did it finish, what changed, did the checks pass, what do
 * I do next. Every word comes from `taskOutcome` over the session's records;
 * the buttons are the existing project actions (review, checks), the
 * approval card already in the conversation, and "Continue with…".
 *
 * It is beside the composer rather than in the side panel because that panel
 * is not on screen below 1280px — and the answer to "is it done?" must be.
 */

const STATE_GLYPH: Record<TaskState, AgentVisualState> = {
  ready: "idle",
  working: "working",
  needs_you: "waiting",
  done: "success",
  failed: "error",
  stopped: "idle",
}

/** Which check "Run tests" runs: the most telling one the project has. */
const CHECK_PREFERENCE: readonly ProjectCheckId[] = ["test", "typecheck", "lint", "build"]

export function TaskStatus({
  outcome,
  provider,
  project,
  onShowApproval,
  onViewWorkspaceChange,
  onContinue,
  onNewSession,
}: {
  outcome: TaskOutcome
  provider: AgentProviderId
  /** The live session's project actions — review and checks. Absent: nothing to review here. */
  project?: ProjectWorkActions
  /** Brings the approval card into view. */
  onShowApproval?: () => void
  /** Shows a workspace change where it was made. */
  onViewWorkspaceChange?: (changeId: string) => void
  /** "Continue with…" — hands the work to another agent. */
  onContinue?: () => void
  onNewSession?: () => void
}) {
  const [review, setReview] = useState<{ kind: "closed" } | { kind: "loading" } | { kind: "open"; review: ProjectChangeReview } | { kind: "gone" }>({ kind: "closed" })
  const [refused, setRefused] = useState(false)
  // A review belongs to the change it was opened on; a newer change (or an undo) closes it.
  const changeId = outcome.changes.latestProjectChangeId
  const [reviewedChange, setReviewedChange] = useState(changeId)
  if (reviewedChange !== changeId) {
    setReviewedChange(changeId)
    setReview({ kind: "closed" })
  }

  if (outcome.state === "ready" && !outcome.task) return null

  const checksAvailable = Boolean(project && project.checks.length > 0)
  const facts = taskOutcomeFacts(outcome, { checksAvailable })
  const check = project ? CHECK_PREFERENCE.map((id) => project.checks.find((candidate) => candidate.id === id)).find(Boolean) : undefined
  const settled = outcome.state === "done" || outcome.state === "stopped" || outcome.state === "failed"
  const reviewOpen = review.kind === "open" || review.kind === "loading"
  const attention = outcome.state === "needs_you"

  const toggleReview = () => {
    if (!project || !changeId) return
    if (reviewOpen) return setReview({ kind: "closed" })
    setReview({ kind: "loading" })
    recordLoopMilestone("result_reviewed", { provider })
    void project.review(changeId).then((found) => setReview(found ? { kind: "open", review: found } : { kind: "gone" }))
  }

  return (
    <section
      aria-label="Task status"
      data-task-state={outcome.state}
      className="px-6 pt-2"
    >
      <div
        className={cn(
          "mx-auto w-full max-w-[720px] rounded-md border px-3 py-2",
          attention ? "border-link/40 bg-link/5" : outcome.state === "failed" ? "border-destructive/40 bg-card" : "border-subtle bg-card"
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* At least 16rem before the buttons share its line; narrower, they wrap below it. */}
          <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-2">
            <span className="pt-[3px]">
              <AgentStatusGlyph state={STATE_GLYPH[outcome.state]} label={TASK_STATE_LABEL[outcome.state]} />
            </span>
            <div className="min-w-0">
              <p className="min-w-0 text-body-sm text-foreground" role="status" aria-live="polite">
                <span className={cn("font-medium", attention ? "text-link" : outcome.state === "failed" ? "text-destructive" : undefined)}>
                  {TASK_STATE_LABEL[outcome.state]}
                </span>
                <span className="text-tertiary"> · </span>
                <span>{outcome.headline}</span>
              </p>
              {(outcome.task || facts.length > 0) && (
                <p className="truncate text-meta text-tertiary" title={outcome.task}>
                  {outcome.task && <span className="text-muted-foreground">“{outcome.task}”</span>}
                  {outcome.task && facts.length > 0 && " · "}
                  {facts.join(" · ")}
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {attention && outcome.approval && onShowApproval && (
              <Button type="button" size="xs" variant="default" onClick={onShowApproval}>
                Show approval
              </Button>
            )}
            {settled && changeId && project && (
              <Button type="button" size="xs" variant="secondary" aria-expanded={reviewOpen} onClick={toggleReview}>
                <ChevronDown className={cn("transition-transform", reviewOpen && "rotate-180")} />
                {reviewOpen ? "Hide changes" : "Review changes"}
              </Button>
            )}
            {settled && !changeId && outcome.changes.latestWorkspaceChangeId && onViewWorkspaceChange && (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => {
                  recordLoopMilestone("result_reviewed", { provider })
                  onViewWorkspaceChange(outcome.changes.latestWorkspaceChangeId!)
                }}
              >
                View in workspace
              </Button>
            )}
            {settled && changeId && check && project && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                title={check.command}
                aria-label={`Run ${PROJECT_CHECK_LABELS[check.id].toLowerCase()}: ${check.command}`}
                disabled={project.checking}
                onClick={() => {
                  setRefused(false)
                  recordLoopMilestone("check_run", { provider })
                  void project.runCheck(check.id).then((ok) => setRefused(!ok))
                }}
              >
                {project.checking ? "Checking…" : `Run ${PROJECT_CHECK_LABELS[check.id].toLowerCase()}`}
              </Button>
            )}
            {outcome.state === "done" && onContinue && (
              <Button type="button" size="xs" variant="ghost" onClick={onContinue} aria-haspopup="dialog">
                Continue with…
              </Button>
            )}
            {(outcome.state === "failed" || outcome.state === "stopped") && onNewSession && (
              <Button type="button" size="xs" variant="outline" onClick={onNewSession}>
                Start a new session
              </Button>
            )}
          </div>
        </div>

        {refused && <p role="alert" className="mt-1 text-meta text-warning">Hubble couldn&apos;t start that check.</p>}
        {review.kind === "loading" && <p className="mt-2 text-meta text-tertiary">Loading the changes…</p>}
        {review.kind === "gone" && <p className="mt-2 text-meta text-tertiary">{PROJECT_CHANGE_GONE}</p>}
        {review.kind === "open" && (
          <div className="mt-2 max-h-80 overflow-y-auto border-t border-subtle pt-2">
            <ProjectChangeDiff review={review.review} />
          </div>
        )}
      </div>
    </section>
  )
}
