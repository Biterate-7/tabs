"use client"

import { Check, Star } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ThemeDefinition } from "@/lib/appearance/types"

/**
 * Renders directly from `theme.colors` via inline style — never touches the
 * global CSS vars this card sits alongside — so the grid can show every
 * preset's real palette at once without applying any of them.
 */
export function ThemeCard({
  theme,
  selected,
  favorited,
  onSelect,
  onToggleFavorite,
}: {
  theme: ThemeDefinition
  selected: boolean
  favorited: boolean
  onSelect: () => void
  onToggleFavorite: () => void
}) {
  const { colors } = theme
  return (
    <div
      className={cn(
        "group/theme-card relative flex flex-col overflow-hidden rounded-md border text-left transition-colors duration-(--duration-fast) ease-(--ease-color)",
        selected ? "border-foreground/50" : "border-border hover:border-strong"
      )}
      style={{ backgroundColor: colors.surface }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex flex-1 flex-col gap-2 p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {[colors.background, colors.accent, colors.success, colors.error].map((swatch, i) => (
              <span key={i} className="size-3 rounded-full border" style={{ backgroundColor: swatch, borderColor: colors.border }} />
            ))}
          </div>
          {selected && (
            <span className="flex size-4 items-center justify-center rounded-full" style={{ backgroundColor: colors.accent }}>
              <Check className="size-2.5" style={{ color: colors.background }} />
            </span>
          )}
        </div>
        <div
          className="rounded-xs px-2 py-2.5 text-left"
          style={{ backgroundColor: colors.background, border: `1px solid ${colors.border}` }}
        >
          <p className="text-body-sm" style={{ color: colors.text }}>
            {theme.name}
          </p>
          <p className="mt-0.5 text-[0.6875rem]" style={{ color: colors.textMuted }}>
            {theme.isDark ? "Dark" : "Light"}
          </p>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        aria-label={favorited ? `Unfavorite ${theme.name}` : `Favorite ${theme.name}`}
        aria-pressed={favorited}
        className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full opacity-0 outline-none transition-opacity duration-(--duration-fast) group-hover/theme-card:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 data-[favorited=true]:opacity-100"
        data-favorited={favorited}
        style={{ backgroundColor: `${colors.background}cc` }}
      >
        <Star className="size-3.5" style={{ color: colors.accent, fill: favorited ? colors.accent : "transparent" }} />
      </button>
    </div>
  )
}
