"use client"

import { useState, type DragEvent } from "react"
import { Bookmark, ChevronLeft, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/ui/empty-state"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TabCard } from "@/components/workspace/tab-card"
import { accentForSection, SectionFolder } from "@/components/workspace/section-folder"
import { getDragTabId, hasDragTabId } from "@/lib/collections/drag"
import { MAX_SECTION_DEPTH } from "@/lib/sections/types"
import type { Section } from "@/lib/sections/types"
import type { SectionTreeNode } from "@/lib/sections/tree"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

/**
 * Full-page "inside the section" view — same fixed-overlay pattern as the
 * legacy CategoryPage, extended with a row of child subsections (one level)
 * above this section's own direct tabs. A subsection's tile opens one level
 * deeper via `onOpenChild`; SectionGrid manages the actual navigation stack.
 */
export function SectionPage({
  node,
  allSections,
  depth,
  isOther,
  onBack,
  onOpenChild,
  onCreateSubsection,
  onRename,
  onDelete,
  onDropTab,
  onCategoryChange,
  onSectionChange,
  onAddDependency,
  onInspect,
  onNotesChange,
  onToggleFavorite,
  onOpenTab,
  recentlyAddedIds,
}: {
  node: SectionTreeNode
  allSections: Section[]
  depth: number
  /** The synthetic "Other" bucket isn't a real section — no rename/delete/subsection/drop-target affordances for it. */
  isOther: boolean
  onBack: () => void
  onOpenChild: (id: string) => void
  onCreateSubsection: () => void
  onRename: () => void
  onDelete: () => void
  onDropTab: (tabId: string) => void
  onCategoryChange: (id: string, category: CategoryId) => void
  onSectionChange: (tabId: string, sectionId: string) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
  onToggleFavorite?: (id: string) => void
  onOpenTab?: (id: string) => void
  recentlyAddedIds?: Set<string>
}) {
  const [dragOver, setDragOver] = useState(false)
  const accent = accentForSection(node.section.id)
  const canCreateSubsection = !isOther && depth < MAX_SECTION_DEPTH

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (isOther || !hasDragTabId(e.dataTransfer)) return
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
    if (isOther) return
    const tabId = getDragTabId(e.dataTransfer)
    if (tabId) onDropTab(tabId)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-6">
        <IconButton aria-label="Back" tooltip="Back" onClick={onBack}>
          <ChevronLeft />
        </IconButton>
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: `var(${accent})` }} />
        <p className="text-h1 text-foreground">
          {node.section.name}{" "}
          <span className="text-tertiary">
            · {node.totalTabCount} tab{node.totalTabCount === 1 ? "" : "s"}
          </span>
        </p>
        {!isOther && (
          <div className="ml-auto flex items-center gap-1">
            {canCreateSubsection && (
              <IconButton aria-label="New subsection" tooltip="New subsection" onClick={onCreateSubsection}>
                <Plus />
              </IconButton>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<IconButton aria-label={`More actions for ${node.section.name}`}><MoreHorizontal /></IconButton>}
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onRename}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDelete} variant="destructive">
                  <Trash2 /> Delete section
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
          {node.children.length > 0 && (
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {node.children.map((child) => (
                <SectionFolder key={child.section.id} node={child} onOpen={() => onOpenChild(child.section.id)} />
              ))}
            </div>
          )}

          {node.tabs.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-16">
              <EmptyState
                icon={Bookmark}
                title={isOther ? "Nothing uncategorized right now." : `No tabs directly in ${node.section.name}.`}
                description={
                  node.children.length > 0
                    ? "They may be inside one of the subsections above."
                    : isOther
                      ? "Every tab has found a home."
                      : "Drag tabs here, or move them here from a tab's menu."
                }
              />
            </div>
          ) : (
            <div
              className={`rounded-lg border px-2 pb-6 transition-colors duration-(--duration-fast) ease-(--ease-standard) ${
                dragOver ? "border-primary/50 bg-primary/[0.04] ring-1 ring-primary/30" : "border-subtle bg-card"
              }`}
            >
              {node.tabs.map((tab: Tab) => (
                <TabCard
                  key={tab.id}
                  tab={tab}
                  onCategoryChange={onCategoryChange}
                  onAddDependency={onAddDependency}
                  onInspect={onInspect}
                  onNotesChange={onNotesChange}
                  onToggleFavorite={onToggleFavorite}
                  onOpenTab={onOpenTab}
                  sections={allSections}
                  onMoveToSection={onSectionChange}
                  isRecentlyAdded={recentlyAddedIds?.has(tab.id) ?? false}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
