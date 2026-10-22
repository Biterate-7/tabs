"use client"

import { LoaderCircle, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { describeOrganizationStage, type OrganizationState } from "@/lib/organize/lifecycle"

/**
 * The organizer's progress, as one unobtrusive line inside the workspace —
 * the workspace itself stays fully usable while a dump organizes, so this is
 * a status line rather than a blocking overlay. Nothing is gated on it: the
 * Graph places tabs as they arrive.
 */
export function OrganizationStatusBar({
  state,
  onRetry,
  onDismissError,
}: {
  state: OrganizationState
  onRetry?: () => void
  onDismissError?: () => void
}) {
  if (state.status === "idle" || state.status === "ready") return null
  const failed = state.status === "error"

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
    >
      {failed ? (
        <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      ) : (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-tertiary" aria-hidden />
      )}
      <p className="text-body-sm text-foreground">{describeOrganizationStage(state)}</p>
      {failed && (
        <div className="ml-auto flex gap-2">
          {onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )}
          {onDismissError && (
            <Button size="sm" variant="ghost" onClick={onDismissError}>
              Dismiss
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
