"use client"

import { useState } from "react"
import { Loader2, ListChecks } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PendingActionPreview } from "@/lib/ai/types"

/** Beyond this many proposed changes, the list collapses behind a "Show N more" toggle (Step 8: "do not make previews excessively large"). */
const COLLAPSE_AFTER = 8

/**
 * Renders one proposed-changes plan inside the Ask TabDump conversation —
 * structured data (preview.plan), not model-generated prose. A short plan
 * always shows every line; a long one (more than COLLAPSE_AFTER actions —
 * e.g. a big Auto-Organize-adjacent multi-step plan) collapses the tail
 * behind a toggle so one message bubble can't dominate the whole
 * conversation. Wraps long workspace/group names via break-words + min-w-0
 * rather than truncating them, so nothing narrow (mobile width, a long
 * name) clips silently.
 */
export function ActionPreviewCard({
  preview,
  onApply,
  onCancel,
}: {
  preview: PendingActionPreview
  onApply: () => void
  onCancel: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isAwaiting = preview.status === "awaiting"
  const isApplying = preview.status === "applying"
  const isResolved = !isAwaiting && !isApplying

  const hasOverflow = preview.plan.length > COLLAPSE_AFTER
  const visiblePlan = expanded || !hasOverflow ? preview.plan : preview.plan.slice(0, COLLAPSE_AFTER)
  const hiddenCount = preview.plan.length - visiblePlan.length

  return (
    <div
      className={`space-y-3 rounded-lg border border-subtle p-3 transition-opacity duration-(--duration-fast) ${
        isResolved ? "opacity-60" : ""
      }`}
      data-status={preview.status}
    >
      <div className="flex items-center gap-1.5 text-label text-tertiary">
        <ListChecks className="size-3.5" aria-hidden />
        Proposed changes
      </div>

      <ul className="space-y-1.5">
        {visiblePlan.map((action, i) => (
          <li key={i} className="min-w-0 break-words text-body-sm text-foreground">
            {action.label}
          </li>
        ))}
      </ul>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-body-sm text-tertiary underline underline-offset-2 hover:text-foreground"
        >
          Show {hiddenCount} more
        </button>
      )}

      <p className="text-body-sm text-tertiary">{preview.summary}</p>

      {(isAwaiting || isApplying) && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onApply} disabled={isApplying}>
            {isApplying && <Loader2 className="animate-spin" aria-hidden />}
            Apply changes
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={isApplying}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
