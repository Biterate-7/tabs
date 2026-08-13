import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/ui/empty-state"
import { TabCard } from "@/components/workspace/tab-card"
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
}: {
  tabs: Tab[]
  highlightedIndex: number
  onCategoryChange: (id: string, category: CategoryId) => void
  onClearFilters?: () => void
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelected?: (id: string) => void
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
          />
        </div>
      ))}
    </div>
  )
}
