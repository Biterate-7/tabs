"use client"

import { useId, useState, type DragEvent } from "react"
import { CollectionHeader } from "@/components/workspace/collection-header"
import { TabCard } from "@/components/workspace/tab-card"
import { getDragTabId, hasDragTabId } from "@/lib/collections/drag"
import { cn } from "@/lib/utils"
import type { DependencyIndicatorData } from "@/components/workspace/tab-dependency-indicator"
import type { CategoryId } from "@/lib/categories"
import type { Collection } from "@/lib/collections/types"
import type { Tab } from "@/lib/tabs/types"

/**
 * One collection, rendered as a lightweight bordered region — a header row
 * plus its (collapsible) member tabs, reusing TabCard for every row rather
 * than inventing a second tab-row component. The expand/collapse transition
 * is a pure-CSS grid-rows animation (0fr → 1fr) so the content never needs
 * to unmount/remount — smooth in both directions without tracking exit state.
 */
export function CollectionGroup({
  collection,
  tabs,
  expanded,
  onToggleExpanded,
  onCategoryChange,
  onRename,
  onAddTabs,
  onOpenAll,
  onExport,
  onDelete,
  onRemoveTab,
  otherCollections,
  onMoveTab,
  onDropTab,
  onAddDependency,
  onInspect,
  onNotesChange,
  dependencyIndicators,
  onSelectDependencyTab,
  onOpenDependencyTab,
  recentlyAddedIds,
}: {
  collection: Collection
  tabs: Tab[]
  expanded: boolean
  onToggleExpanded: () => void
  onCategoryChange: (id: string, category: CategoryId) => void
  onRename: () => void
  onAddTabs: () => void
  onOpenAll: () => void
  onExport?: () => void
  onDelete: () => void
  onRemoveTab: (tabId: string) => void
  otherCollections: { id: string; name: string }[]
  onMoveTab: (tabId: string, collectionId: string) => void
  onDropTab: (collectionId: string, tabId: string) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
  dependencyIndicators?: Map<string, DependencyIndicatorData>
  onSelectDependencyTab?: (id: string) => void
  onOpenDependencyTab?: (id: string) => void
  recentlyAddedIds?: Set<string>
}) {
  const contentId = useId()
  const [dragOver, setDragOver] = useState(false)

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (!hasDragTabId(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    if (!dragOver) setDragOver(true)
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const tabId = getDragTabId(e.dataTransfer)
    if (tabId) onDropTab(collection.id, tabId)
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-subtle bg-card px-2 transition-colors duration-(--duration-fast) ease-(--ease-standard)",
        dragOver && "border-primary/50 bg-primary/[0.04] ring-1 ring-primary/30"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <CollectionHeader
        name={collection.name}
        tabCount={tabs.length}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
        contentId={contentId}
        onRename={onRename}
        onAddTabs={onAddTabs}
        onOpenAll={onOpenAll}
        onExport={onExport}
        onDelete={onDelete}
      />

      <div
        id={contentId}
        className="grid transition-[grid-template-rows] duration-(--duration-base) ease-(--ease-standard)"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {tabs.length === 0 ? (
            <div className="px-1 pt-1 pb-4">
              <p className="text-body-sm text-tertiary">
                No tabs yet. Drag tabs here, or{" "}
                <button type="button" onClick={onAddTabs} className="text-accent-text hover:underline">
                  add tabs
                </button>
                .
              </p>
            </div>
          ) : (
            <div className="pb-1">
              {tabs.map((tab) => (
                <TabCard
                  key={tab.id}
                  tab={tab}
                  onCategoryChange={onCategoryChange}
                  onAddDependency={onAddDependency}
                  onInspect={onInspect}
                  onNotesChange={onNotesChange}
                  onRemoveFromCollection={onRemoveTab}
                  otherCollections={otherCollections}
                  onMoveToCollection={onMoveTab}
                  dependencyIndicator={dependencyIndicators?.get(tab.id)}
                  onSelectDependencyTab={onSelectDependencyTab}
                  onOpenDependencyTab={onOpenDependencyTab}
                  isRecentlyAdded={recentlyAddedIds?.has(tab.id) ?? false}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
