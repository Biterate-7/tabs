"use client"

import { Loader2, ListChecks } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PendingActionPreview } from "@/lib/ai/types"

/**
 * Renders one proposed-changes plan inside the Ask TabDump conversation —
 * structured data (preview.plan), not model-generated prose. Handles the
 * single-action and long-list cases the same way (a plain stacked list;
 * ScrollArea in the parent panel already scrolls the whole conversation),
 * and wraps long workspace/group names via break-words + min-w-0 rather
 * than truncating them, so nothing narrow (mobile width, a long name)
 * clips silently.
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
  const isAwaiting = preview.status === "awaiting"
  const isApplying = preview.status === "applying"
  const isResolved = !isAwaiting && !isApplying

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
        {preview.plan.map((action, i) => (
          <li key={i} className="min-w-0 break-words text-body-sm text-foreground">
            {action.label}
          </li>
        ))}
      </ul>

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
