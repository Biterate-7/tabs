import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Attention } from "@/lib/workspace/attention"

export function AttentionStrip({
  attention,
  onCleanup,
  onViewOther,
}: {
  attention: Attention
  onCleanup: () => void
  onViewOther: () => void
}) {
  if (!attention) return null

  const { message, actionLabel, onAction } =
    attention.kind === "duplicates"
      ? {
          message: `${attention.count} duplicate tab${attention.count === 1 ? "" : "s"} found.`,
          actionLabel: "Clean up",
          onAction: onCleanup,
        }
      : {
          message: `${attention.count} tabs landed in "Other" — TabDump wasn't confident where they belong.`,
          actionLabel: "Review Other",
          onAction: onViewOther,
        }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-subtle bg-primary/[0.06] px-3 py-2">
      <AlertCircle className="size-4 shrink-0 text-accent-text" aria-hidden />
      <p className="text-body-sm text-foreground">{message}</p>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto shrink-0"
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  )
}
