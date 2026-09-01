"use client"

import { Layers, Plus } from "lucide-react"
import { CollectionGroup } from "@/components/workspace/collection-group"
import { getCollectionTabs } from "@/lib/collections/relations"
import type { DependencyIndicatorData } from "@/components/workspace/tab-dependency-indicator"
import type { CategoryId } from "@/lib/categories"
import type { Collection } from "@/lib/collections/types"
import type { Section } from "@/lib/sections/types"
import type { Tab } from "@/lib/tabs/types"

/**
 * The workspace's "Collections" region — rendered above CategoryGrid on the
 * default browsing view. Collections are an orthogonal dimension to
 * Category (AGENTS.md-style spec: "these represent different dimensions"),
 * so a tab inside a collection still appears in its category card too; this
 * section exists purely to surface the collection grouping, not to replace
 * category browsing.
 */
export function CollectionsSection({
  collections,
  tabsById,
  expandedIds,
  onToggleExpanded,
  onCategoryChange,
  sections,
  onMoveToSection,
  onNewCollection,
  onRename,
  onAddTabs,
  onOpenAll,
  onExport,
  onDelete,
  onRemoveTab,
  onMoveTab,
  onDropTab,
  onAddDependency,
  onInspect,
  onNotesChange,
  onToggleFavorite,
  onOpenTab,
  dependencyIndicators,
  onSelectDependencyTab,
  onOpenDependencyTab,
  recentlyAddedIds,
}: {
  collections: Collection[]
  tabsById: Map<string, Tab>
  expandedIds: Set<string>
  onToggleExpanded: (id: string) => void
  onCategoryChange: (id: string, category: CategoryId) => void
  /** This workspace's section tree, for each tab's "Move to section" submenu — omitted (or empty) hides it. */
  sections?: Section[]
  onMoveToSection?: (id: string, sectionId: string) => void
  onNewCollection: () => void
  onRename: (id: string) => void
  onAddTabs: (id: string) => void
  onOpenAll: (id: string) => void
  onExport: (id: string) => void
  onDelete: (id: string) => void
  onRemoveTab: (collectionId: string, tabId: string) => void
  onMoveTab: (tabId: string, collectionId: string) => void
  onDropTab: (collectionId: string, tabId: string) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
  onToggleFavorite?: (id: string) => void
  onOpenTab?: (id: string) => void
  dependencyIndicators?: Map<string, DependencyIndicatorData>
  onSelectDependencyTab?: (id: string) => void
  onOpenDependencyTab?: (id: string) => void
  recentlyAddedIds?: Set<string>
}) {
  if (collections.length === 0) return null

  return (
    <section aria-label="Collections">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-label text-tertiary">
          <Layers className="size-3.5" aria-hidden />
          COLLECTIONS
        </div>
        <button
          type="button"
          onClick={onNewCollection}
          className="flex items-center gap-1 text-label text-accent-text hover:underline"
        >
          <Plus className="size-3.5" aria-hidden /> New collection
        </button>
      </div>
      <div className="space-y-3">
        {collections.map((collection) => (
          <CollectionGroup
            key={collection.id}
            collection={collection}
            tabs={getCollectionTabs(collection, tabsById)}
            expanded={expandedIds.has(collection.id)}
            onToggleExpanded={() => onToggleExpanded(collection.id)}
            onCategoryChange={onCategoryChange}
            sections={sections}
            onMoveToSection={onMoveToSection}
            onRename={() => onRename(collection.id)}
            onAddTabs={() => onAddTabs(collection.id)}
            onOpenAll={() => onOpenAll(collection.id)}
            onExport={() => onExport(collection.id)}
            onDelete={() => onDelete(collection.id)}
            onRemoveTab={(tabId) => onRemoveTab(collection.id, tabId)}
            otherCollections={collections.filter((c) => c.id !== collection.id).map((c) => ({ id: c.id, name: c.name }))}
            onMoveTab={onMoveTab}
            onDropTab={onDropTab}
            onAddDependency={onAddDependency}
            onInspect={onInspect}
            onNotesChange={onNotesChange}
            onToggleFavorite={onToggleFavorite}
            onOpenTab={onOpenTab}
            dependencyIndicators={dependencyIndicators}
            onSelectDependencyTab={onSelectDependencyTab}
            onOpenDependencyTab={onOpenDependencyTab}
            recentlyAddedIds={recentlyAddedIds}
          />
        ))}
      </div>
    </section>
  )
}
