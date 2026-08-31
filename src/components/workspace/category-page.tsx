"use client"

import { Bookmark, ChevronLeft } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/ui/empty-state"
import { TabCard } from "@/components/workspace/tab-card"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

/**
 * Full-page "inside the folder" view, mounted the same way Graph's node
 * notes page and Settings are (fixed overlay + view-pop-in, see
 * GraphNodeNotesView/AppearanceSettingsView) — reached by zooming into a
 * CategoryFolder on the homepage, so landing here should read as having
 * stepped inside that category, not as a drawer sliding over the homepage.
 * That's why this replaces the CategorySheet side panel: a docked sheet
 * leaves the homepage visible behind it, which undercuts the "entering the
 * folder" gesture the open animation sets up.
 */
export function CategoryPage({
  categoryId,
  tabs,
  onClose,
  onCategoryChange,
  onAddDependency,
  onInspect,
  onNotesChange,
  recentlyAddedIds,
}: {
  categoryId: CategoryId
  tabs: Tab[]
  onClose: () => void
  onCategoryChange: (id: string, category: CategoryId) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
  recentlyAddedIds?: Set<string>
}) {
  const def = CATEGORIES[categoryId]
  const Icon = def.icon

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-6">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <Icon className="size-4 shrink-0" style={{ color: `var(${def.accentColor})` }} />
        <p className="text-h1 text-foreground">
          {def.name} <span className="text-tertiary">· {tabs.length} tab{tabs.length === 1 ? "" : "s"}</span>
        </p>
      </div>

      {tabs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={Bookmark}
            title={`No tabs in ${def.name} anymore.`}
            description="They were recategorized or removed elsewhere in this session."
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
            <div className="rounded-lg border border-subtle bg-card px-2 pb-6">
              {tabs.map((tab) => (
                <TabCard
                  key={tab.id}
                  tab={tab}
                  onCategoryChange={onCategoryChange}
                  onAddDependency={onAddDependency}
                  onInspect={onInspect}
                  onNotesChange={onNotesChange}
                  isRecentlyAdded={recentlyAddedIds?.has(tab.id) ?? false}
                />
              ))}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
