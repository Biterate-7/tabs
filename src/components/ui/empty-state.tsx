import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * How much room the empty state is standing in.
 *
 * `page` is a view with nothing in it — Favorites, Agent History, a
 * category with no tabs. The generous padding is right there: the message
 * is the only thing on screen and it should sit in the middle of it.
 *
 * `panel` is a section inside a column that has other sections under it.
 * The same padding there is not generous, it is a gap: measured in the
 * 288px graph panel, `py-16` made the AI Agents section 339px tall to
 * hold a heading, a connector strip, four filter chips and one sentence,
 * and pushed CONNECTIONS most of a screen down. Same message, same
 * information, a quarter of the emptiness.
 */
type EmptyStateDensity = "page" | "panel"

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
        density === "panel" ? "gap-2 py-6" : "gap-3 py-16"
      )}
    >
      <Icon
        className={cn("text-tertiary", density === "panel" ? "size-5" : "size-6")}
        aria-hidden
      />
      <div className="space-y-1">
        <p
          className={cn(
            "font-medium text-foreground",
            density === "panel" ? "text-body-sm" : "text-body"
          )}
        >
          {title}
        </p>
        {/* Sans at both densities. The panel version is tighter, not a
            different voice — mono is reserved for micro-labels and
            figures (see `.text-eyebrow` in globals.css), and this is a
            sentence. */}
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
