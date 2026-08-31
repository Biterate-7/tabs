"use client"

import { Star } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { cn } from "@/lib/utils"

/**
 * The Favorites toggle, rendered wherever a tab is already interacted with
 * (TabCard's action row, Tab Peek's footer) — mirrors TabNotesButton's
 * fill/tooltip conventions so the two read as siblings. Unlike the other
 * action-row buttons (which only reveal on hover/focus), a favorited tab
 * keeps this visible at all times via `alwaysVisible` — the star itself is
 * the "subtle persistent indicator" the product spec calls for, not a
 * separate badge layered on top of it.
 */
export function TabFavoriteButton({
  tabId,
  domain,
  isFavorite,
  onToggleFavorite,
  alwaysVisible = false,
  className,
}: {
  tabId: string
  domain: string
  isFavorite: boolean
  onToggleFavorite: (id: string) => void
  /** Skips the hover/focus-only opacity treatment other action-row buttons use — pass true when the surrounding row is always-on (Tab Peek) or when the tab is favorited (see tab-card.tsx). */
  alwaysVisible?: boolean
  className?: string
}) {
  return (
    <IconButton
      aria-label={isFavorite ? `Remove ${domain} from favorites` : `Add ${domain} to favorites`}
      aria-pressed={isFavorite}
      tooltip={isFavorite ? "Remove from favorites" : "Add to favorites"}
      onClick={() => onToggleFavorite(tabId)}
      className={cn(
        "size-11 sm:size-8",
        isFavorite && "text-favorite-accent",
        !alwaysVisible && !isFavorite && "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
        className
      )}
    >
      <Star fill={isFavorite ? "currentColor" : "none"} fillOpacity={isFavorite ? 0.2 : 1} />
    </IconButton>
  )
}
