"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { SectionFolder } from "@/components/workspace/section-folder"
import { SectionPage } from "@/components/workspace/section-page"
import { buildSectionTree, findSectionTreeNode, OTHER_SECTION_ID } from "@/lib/sections/tree"
import type { Section } from "@/lib/sections/types"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

/**
 * The default "browsing" view once sections exist — replaces the old flat
 * CategoryGrid. Renders the workspace's section forest as folder tiles;
 * opening one drills into a full-page SectionPage, which can itself drill
 * one level deeper (root -> subcategory -> project, MAX_SECTION_DEPTH's 3
 * levels). Only one page is ever on screen at a time (a navigation stack of
 * section ids), matching the existing CategoryPage's single fixed-overlay
 * pattern rather than nesting overlays.
 */
export function SectionGrid({
  sections,
  tabs,
  onCategoryChange,
  onSectionChange,
  onDropTabOnSection,
  onCreateSection,
  onRenameSection,
  onDeleteSection,
  onAddDependency,
  onInspect,
  onNotesChange,
  onToggleFavorite,
  onOpenTab,
  recentlyAddedIds,
}: {
  sections: Section[]
  tabs: Tab[]
  /** Still wired to TabCard's existing flat category badge/dropdown — unchanged, additive alongside the new hierarchical move below. */
  onCategoryChange: (id: string, category: CategoryId) => void
  onSectionChange: (tabId: string, sectionId: string) => void
  onDropTabOnSection: (sectionId: string, tabId: string) => void
  /** `parentId` is null for a new root section, or the current page's section id for "+ New subsection". */
  onCreateSection: (parentId: string | null) => void
  onRenameSection: (id: string) => void
  onDeleteSection: (id: string) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
  onToggleFavorite?: (id: string) => void
  onOpenTab?: (id: string) => void
  recentlyAddedIds?: Set<string>
}) {
  const [openPath, setOpenPath] = useState<string[]>([])
  const tree = buildSectionTree(sections, tabs)
  const cardEntries = tree.filter((n) => n.presence !== "compact")
  const chipEntries = tree.filter((n) => n.presence === "compact")

  const openId = openPath[openPath.length - 1]
  const openNode = openId ? findSectionTreeNode(tree, openId) : undefined

  function handleClose() {
    setOpenPath([])
  }

  function handleBack() {
    setOpenPath((prev) => prev.slice(0, -1))
  }

  function handleOpenChild(id: string) {
    setOpenPath((prev) => [...prev, id])
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cardEntries.map((node) => (
          <SectionFolder
            key={node.section.id}
            node={node}
            onOpen={() => setOpenPath([node.section.id])}
            onDropTab={node.section.id === OTHER_SECTION_ID ? undefined : (tabId) => onDropTabOnSection(node.section.id, tabId)}
          />
        ))}
        <button
          type="button"
          onClick={() => onCreateSection(null)}
          className="flex min-h-[100px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-subtle text-tertiary transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:text-foreground"
        >
          <Plus className="size-4" />
          <span className="text-body-sm">New Section</span>
        </button>
      </div>

      {chipEntries.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {chipEntries.map((node) => (
            <SectionFolder
              key={node.section.id}
              node={node}
              onOpen={() => setOpenPath([node.section.id])}
              onDropTab={node.section.id === OTHER_SECTION_ID ? undefined : (tabId) => onDropTabOnSection(node.section.id, tabId)}
            />
          ))}
        </div>
      )}

      {openNode && (
        <SectionPage
          node={openNode}
          allSections={sections}
          depth={openPath.length - 1}
          isOther={openNode.section.id === OTHER_SECTION_ID}
          onBack={openPath.length > 1 ? handleBack : handleClose}
          onOpenChild={handleOpenChild}
          onCreateSubsection={() => onCreateSection(openNode.section.id)}
          onRename={() => onRenameSection(openNode.section.id)}
          onDelete={() => onDeleteSection(openNode.section.id)}
          onDropTab={(tabId) => onDropTabOnSection(openNode.section.id, tabId)}
          onCategoryChange={onCategoryChange}
          onSectionChange={onSectionChange}
          onAddDependency={onAddDependency}
          onInspect={onInspect}
          onNotesChange={onNotesChange}
          onToggleFavorite={onToggleFavorite}
          onOpenTab={onOpenTab}
          recentlyAddedIds={recentlyAddedIds}
        />
      )}
    </>
  )
}
