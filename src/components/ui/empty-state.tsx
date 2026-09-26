import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type EmptyStateDensity = "page" | "panel"

/**
 * HubbleEmptyState — a glyph at the tertiary tier, one medium line, one
 * secondary line, and at most one quiet action. No illustration, no card:
 * an empty region in the reference is simply a sentence in it.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  density = "page",
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  density?: EmptyStateDensity
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center",
        density === "panel" ? "gap-2 px-4 py-6" : "gap-3 px-6 py-16"
      )}
    >
      <Icon className="size-4 text-tertiary" aria-hidden />
      <div className="max-w-sm space-y-1">
        <p className="text-h2 text-foreground">{title}</p>
        {description && <p className="text-body-sm text-muted-foreground">{description}</p>}
      </div>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
