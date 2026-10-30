"use client"

import { useState } from "react"
import { Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import { ProjectIcon } from "@/components/workspace/project-icon"
import { describeSummary } from "@/lib/intelligence/resume"
import { subjectName } from "@/lib/product/subjects"
import { formatRelativeTime } from "@/lib/time-format"
import type { ResumeRecommendation } from "@/lib/intelligence/resume"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Smart Resume on Home: the project the person was last working on, what it
 * holds, what is new since they last picked it up, and — when it has tabs to
 * reopen — a tick to reopen them. Everything here comes from the project
 * itself; the one-line note under the counts says so.
 */
export function ResumePrompt({
  recommendation,
  workspace,
  now,
  reopen,
  pending = false,
  onResume,
  onDismiss,
}: {
  recommendation: ResumeRecommendation
  workspace: Workspace
  now: number
  /** Tabs it can reopen: a saved session's, or the pages last used for it. Absent where tabs can't be opened. */
  reopen?: { count: number; label: string }
  pending?: boolean
  onResume: (options: { reopenTabs: boolean }) => void
  onDismiss: () => void
}) {
  const [reopenTabs, setReopenTabs] = useState(true)
  const name = subjectName(workspace)
  const { counts, gaps } = describeSummary(recommendation.summary)
  const latest = recommendation.summary.latest[0]
  const headline = recommendation.reason === "new-related" ? `New research for ${name}` : `Continue ${name}?`
  return (
    <section aria-label="Pick up where you left off" data-resume={workspace.id} className="mt-5 flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-(--shadow-panel) animate-enter sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <ProjectIcon workspace={workspace} size={20} />
        <div className="min-w-0 flex-1">
          <p className="text-eyebrow text-tertiary">Pick up where you left off</p>
          <h2 className="mt-1 truncate text-h2 text-foreground">{headline}</h2>
          <p className="mt-0.5 text-body-sm text-muted-foreground">
            Last worked {formatRelativeTime(recommendation.lastAt, now)?.toLowerCase()}
            {counts ? ` · ${counts}` : ""}
          </p>
        </div>
        <IconButton aria-label="Not now" tooltip="Not now" onClick={onDismiss}>
          <X />
        </IconButton>
      </div>

      <ul className="flex min-w-0 flex-col gap-1 text-body-sm text-muted-foreground">
        {recommendation.summary.focus && <li className="truncate">Focus: {recommendation.summary.focus}</li>}
        {latest && (
          <li className="truncate">
            Latest: <span className="text-foreground">{latest.title}</span>
          </li>
        )}
        {recommendation.newSinceCheckpoint > 0 && <li>{recommendation.newSinceCheckpoint} new since you last picked it up</li>}
        {recommendation.waiting > 0 && <li>{recommendation.waiting === 1 ? "New pages may belong here — see the suggestion below" : `${recommendation.waiting} suggestions may belong here`}</li>}
        {gaps.map((gap) => (
          <li key={gap} className="text-tertiary">
            {gap}
          </li>
        ))}
      </ul>
      <p className="text-meta text-tertiary">From the project&rsquo;s titles, kinds and dates — not a summary of what they say.</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" onClick={() => onResume({ reopenTabs: Boolean(reopen) && reopenTabs })} disabled={pending}>
          <Play /> {pending ? "Opening…" : "Resume"}
        </Button>
        {reopen && reopen.count > 0 && (
          <div className="flex min-w-0 items-center gap-2">
            <Checkbox checked={reopenTabs} onCheckedChange={(checked) => setReopenTabs(checked === true)} aria-label={`Reopen ${reopen.label}`} />
            <span className="min-w-0 cursor-default truncate text-body-sm text-muted-foreground" onClick={() => setReopenTabs((value) => !value)}>
              Reopen {reopen.label}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
