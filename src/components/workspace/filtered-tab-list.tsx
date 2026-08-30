import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/ui/empty-state"
import { TabCard } from "@/components/workspace/tab-card"
import type { DependencyIndicatorData } from "@/components/workspace/tab-dependency-indicator"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function FilteredTabList({
  tabs,
  highlightedIndex,
  onCategoryChange,
  onClearFilters,
  selectionMode = false,
  selectedIds,
  onToggleSelected,
  onAddDependency,
  onInspect,
  onNotesChange,
  dependencyIndicators,
  onSelectDependencyTab,
  onOpenDependencyTab,
  recentlyAddedIds,
  collectionNames,
}: {
  tabs: Tab[]
  highlightedIndex: number
  onCategoryChange: (id: string, category: CategoryId) => void
  onClearFilters?: () => void
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelected?: (id: string) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
  /** Keyed by tab id — only present for tabs that actually have a dependency/used-by relationship. Omitted entirely in contexts that don't compute it (e.g. no dependency store wired up). */
  dependencyIndicators?: Map<string, DependencyIndicatorData>
  onSelectDependencyTab?: (id: string) => void
  onOpenDependencyTab?: (id: string) => void
  recentlyAddedIds?: Set<string>
  /** Tab id → collection name — shown as a quiet "Collection: X" line so a tab's grouping is visible without leaving the search results. */
  collectionNames?: Map<string, string>
}) {
  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title="Nothing matches."
        description="Try a different search, or clear your filters."
        action={onClearFilters ? { label: "Clear filters", onClick: onClearFilters } : undefined}
      />
    )
  }

  return (
    <div className="rounded-lg border border-subtle bg-card px-2">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={cn(index === highlightedIndex && "rounded-md ring-2 ring-primary/50")}
        >
          <TabCard
            tab={tab}
            onCategoryChange={onCategoryChange}
            selectable={selectionMode}
            selected={selectedIds?.has(tab.id) ?? false}
            onToggleSelected={() => onToggleSelected?.(tab.id)}
            onAddDependency={onAddDependency}
            onInspect={onInspect}
            onNotesChange={onNotesChange}
            dependencyIndicator={dependencyIndicators?.get(tab.id)}
            onSelectDependencyTab={onSelectDependencyTab}
            onOpenDependencyTab={onOpenDependencyTab}
            isRecentlyAdded={recentlyAddedIds?.has(tab.id) ?? false}
            collectionName={collectionNames?.get(tab.id)}
          />
        </div>
      ))}
    </div>
  )
}
