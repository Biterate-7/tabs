"use client"

import { ChevronLeft, Star } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/ui/empty-state"
import { TabCard } from "@/components/workspace/tab-card"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

/** Most recently interacted-with favorite first; a favorite that's never been opened from TabDump sorts after ones that have, in their existing relative order — see AGENTS.md's "Favorite Sorting" section. */
function sortFavorites(tabs: Tab[]): Tab[] {
  return [...tabs].sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0))
}

/**
 * Dedicated Favorites destination — same full-page overlay shape as
 * CategoryPage (fixed inset, view-pop-in), scoped to the current workspace
 * like every other TabDump view. Reuses TabCard for every row rather than a
 * bespoke favorite-row component, so unfavoriting here behaves identically
 * (and stays in sync) with unfavoriting anywhere else.
 */
export function FavoritesView({
  tabs,
  onClose,
  onCategoryChange,
  onToggleFavorite,
  onOpenTab,
  onAddDependency,
  onInspect,
  onNotesChange,
}: {
  tabs: Tab[]
  onClose: () => void
  onCategoryChange: (id: string, category: CategoryId) => void
  onToggleFavorite: (id: string) => void
  onOpenTab?: (id: string) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
}) {
  const favorites = sortFavorites(tabs.filter((t) => t.isFavorite))

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-6">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <Star className="size-4 shrink-0 text-favorite-accent" fill="currentColor" fillOpacity={0.2} />
        <p className="text-h1 text-foreground">
          Favorites{" "}
          <span className="text-tertiary">
            · {favorites.length} tab{favorites.length === 1 ? "" : "s"}
          </span>
        </p>
      </div>

      {favorites.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon={Star} title="No favorites yet." description="Favorite tabs to keep them close." />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
            <div className="rounded-lg border border-subtle bg-card px-2 pb-6">
              {favorites.map((tab) => (
                <TabCard
                  key={tab.id}
                  tab={tab}
                  onCategoryChange={onCategoryChange}
                  onToggleFavorite={onToggleFavorite}
                  onOpenTab={onOpenTab}
                  onAddDependency={onAddDependency}
                  onInspect={onInspect}
                  onNotesChange={onNotesChange}
                />
              ))}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
