import { cn } from "@/lib/utils"
import { TabCard } from "@/components/workspace/tab-card"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function FilteredTabList({
  tabs,
  highlightedIndex,
  onCategoryChange,
}: {
  tabs: Tab[]
  highlightedIndex: number
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  if (tabs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-16 text-center">
        <p className="text-sm font-medium text-foreground">No tabs found.</p>
        <p className="text-xs text-tertiary">Try a different search.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={cn(
            "rounded-lg",
            index === highlightedIndex && "ring-2 ring-primary/50"
          )}
        >
          <TabCard tab={tab} onCategoryChange={onCategoryChange} />
        </div>
      ))}
    </div>
  )
}
