"use client"

import { ChevronLeft, LoaderCircle, TriangleAlert, Waypoints } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { describeOrganizationStage, type OrganizationStage, type OrganizationState } from "@/lib/organize/lifecycle"

/**
 * The stages, in the order they are entered, as the preparation screen's
 * checklist. Every entry is a state the pipeline actually reports (see
 * lib/organize/lifecycle.ts's OrganizationStage) — there is no synthetic step
 * here to pad the list out, and no percentage anywhere: the only honest
 * progress signal available is which stage is running, so that is all this
 * shows.
 */
const STAGE_SEQUENCE: { stage: OrganizationStage; label: string }[] = [
  { stage: "receiving", label: "Receiving tabs" },
  { stage: "classifying", label: "Organizing tabs" },
  { stage: "grouping", label: "Building groups" },
  { stage: "other", label: 'Organizing "Other" tabs' },
  { stage: "arranging", label: "Arranging tabs" },
  { stage: "settling", label: "Finalizing layout" },
]

function stageIndex(stage: OrganizationStage | null): number {
  if (!stage) return -1
  return STAGE_SEQUENCE.findIndex((entry) => entry.stage === stage)
}

/**
 * Shown in place of the Graph View for as long as a dump is still being
 * organized, laid out or settled.
 *
 * Deliberately *instead of* the graph, not on top of it: the requirement is
 * that the first interactive graph state a user ever sees is the final one,
 * which an overlay over a live canvas cannot deliver — the canvas underneath
 * would still be mounting nodes, running physics and restructuring itself as
 * "Other" resolved. Nothing here renders GraphCanvas, so there is no
 * intermediate graph to leak through.
 */
export function OrganizationPreparationView({
  state,
  onClose,
  onRetry,
  onOpenAnyway,
}: {
  state: OrganizationState
  onClose: () => void
  onRetry?: () => void
  onOpenAnyway?: () => void
}) {
  const failed = state.status === "error"
  const current = stageIndex(state.stage)

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-6">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <Waypoints className="size-4 shrink-0 text-tertiary" />
        <p className="text-h1 text-foreground">Graph</p>
      </div>

      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-sm" role="status" aria-live="polite">
          <div className="flex items-center gap-2">
            {failed ? (
              <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
            ) : (
              <LoaderCircle className="size-4 shrink-0 animate-spin text-tertiary" aria-hidden />
            )}
            <p className="text-body font-medium text-foreground">
              {failed ? "Couldn't finish organizing your tabs." : describeOrganizationStage(state)}
            </p>
          </div>
          <p className="mt-1 pl-6 text-body-sm text-muted-foreground">
            {failed
              ? "The graph stays closed until organizing finishes, so it never opens onto a half-organized layout."
              : "The graph opens once every tab has been organized and the layout has settled."}
          </p>

          {!failed && (
            <ol className="mt-5 space-y-1.5 pl-6">
              {STAGE_SEQUENCE.map((entry, index) => {
                const done = current > index
                const active = current === index
                return (
                  <li
                    key={entry.stage}
                    aria-current={active ? "step" : undefined}
                    className={
                      active
                        ? "text-body-sm text-foreground"
                        : done
                          ? "text-body-sm text-muted-foreground"
                          : "text-body-sm text-tertiary"
                    }
                  >
                    {done ? "✓ " : active ? "› " : "· "}
                    {entry.label}
                  </li>
                )
              })}
            </ol>
          )}

          {failed && (
            <div className="mt-5 flex flex-wrap gap-2 pl-6">
              {onRetry && (
                <Button size="sm" onClick={onRetry}>
                  Try again
                </Button>
              )}
              {onOpenAnyway && (
                <Button size="sm" variant="secondary" onClick={onOpenAnyway}>
                  Open graph anyway
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The same lifecycle, as one unobtrusive line inside the workspace — the
 * workspace itself stays fully usable while a dump organizes, so this is a
 * status line rather than a blocking overlay. Only the graph is gated.
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
      className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-card px-3 py-2"
    >
      {failed ? (
        <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      ) : (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-tertiary" aria-hidden />
      )}
      <p className="text-body-sm text-foreground">{describeOrganizationStage(state)}</p>
      {!failed && <p className="text-body-sm text-muted-foreground">Graph opens when this finishes.</p>}
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
