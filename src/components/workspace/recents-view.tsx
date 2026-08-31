"use client"

import { ChevronLeft, History } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/ui/empty-state"
import { TabCard } from "@/components/workspace/tab-card"
import { groupRecents, recentTabs } from "@/lib/workspace/recents"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

/**
 * Dedicated Recents destination — tabs the user has actually opened from
 * TabDump, grouped into Today / Yesterday / Earlier rather than stamping a
 * relative timestamp on every row (see lib/workspace/recents.ts). Same
 * full-page overlay shape and workspace scoping as FavoritesView/CategoryPage.
 */
export function RecentsView({
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
  onToggleFavorite?: (id: string) => void
  onOpenTab: (id: string) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
}) {
  const recent = recentTabs(tabs)
  const groups = groupRecents(recent)

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-6">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <History className="size-4 shrink-0 text-tertiary" />
        <p className="text-h1 text-foreground">
          Recent <span className="text-tertiary">· {recent.length} tab{recent.length === 1 ? "" : "s"}</span>
        </p>
      </div>

      {recent.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={History}
            title="Nothing recent yet."
            description="Tabs you open from TabDump will show up here."
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 space-y-6">
            {groups.map((group) => (
              <section key={group.key}>
                <p className="mb-2 px-1 text-label text-tertiary">{group.label.toUpperCase()}</p>
                <div className="rounded-lg border border-subtle bg-card px-2 pb-1">
                  {group.tabs.map((tab) => (
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
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
