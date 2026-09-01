"use client"

import type { ReactElement } from "react"
import { FolderInput, GitBranchPlus, PanelRight, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { rootSections, childrenOf } from "@/lib/sections/relations"
import type { Section } from "@/lib/sections/types"
import type { Tab } from "@/lib/tabs/types"
import { openTab } from "@/lib/browser/open-tab"

/**
 * Recursively renders one level of the section tree as nested
 * DropdownMenuSub items — a leaf section (no children) is a plain clickable
 * item, one with children opens a further submenu for its own children so a
 * "Move to section" click can reach a project 3 levels deep.
 */
function SectionMenuItems({ sections, parentId, onSelect }: { sections: Section[]; parentId: string | null; onSelect: (sectionId: string) => void }) {
  const nodes = parentId === null ? rootSections(sections) : childrenOf(sections, parentId)
  return (
    <>
      {nodes.map((section) => {
        const children = childrenOf(sections, section.id)
        if (children.length === 0) {
          return (
            <DropdownMenuItem key={section.id} onClick={() => onSelect(section.id)}>
              {section.name}
            </DropdownMenuItem>
          )
        }
        return (
          <DropdownMenuSub key={section.id}>
            <DropdownMenuSubTrigger>{section.name}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => onSelect(section.id)}>Move to {section.name}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <SectionMenuItems sections={sections} parentId={section.id} onSelect={onSelect} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      })}
    </>
  )
}

/**
 * The "⋮ More actions" menu for a tab — Open / Inspect / Add dependency /
 * Remove from collection / Move to collection / Move to category. Extracted
 * out of TabCard so Tab Peek's action row can reuse the exact same menu
 * (same items, same gating) instead of standing up a second one.
 */
export function TabActionsMenu({
  tab,
  onCategoryChange,
  onInspect,
  onAddDependency,
  onRemoveFromCollection,
  otherCollections,
  onMoveToCollection,
  sections,
  onMoveToSection,
  onOpenTab,
  trigger,
  align = "end",
}: {
  tab: Tab
  onCategoryChange: (id: string, category: CategoryId) => void
  onInspect?: (id: string) => void
  onAddDependency?: (id: string) => void
  onRemoveFromCollection?: (id: string) => void
  otherCollections?: { id: string; name: string }[]
  onMoveToCollection?: (id: string, collectionId: string) => void
  /** This workspace's full section tree, for the "Move to section" submenu. Omitted (or empty) hides the submenu. */
  sections?: Section[]
  onMoveToSection?: (id: string, sectionId: string) => void
  /** When provided, takes over this menu's "Open" item entirely — see tab-card.tsx's matching prop for the full contract. */
  onOpenTab?: (id: string) => void
  trigger: ReactElement
  align?: "start" | "end" | "center"
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align}>
        <DropdownMenuItem onClick={() => (onOpenTab ? onOpenTab(tab.id) : openTab(tab.url))}>
          Open
        </DropdownMenuItem>
        {onInspect && (
          <DropdownMenuItem onClick={() => onInspect(tab.id)}>
            <PanelRight /> Inspect…
          </DropdownMenuItem>
        )}
        {onAddDependency && (
          <DropdownMenuItem onClick={() => onAddDependency(tab.id)}>
            <GitBranchPlus /> Add dependency…
          </DropdownMenuItem>
        )}
        {onRemoveFromCollection && (
          <DropdownMenuItem onClick={() => onRemoveFromCollection(tab.id)}>
            <X /> Remove from collection
          </DropdownMenuItem>
        )}
        {onMoveToCollection && otherCollections && otherCollections.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput /> Move to collection
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {otherCollections.map((c) => (
                <DropdownMenuItem key={c.id} onClick={() => onMoveToCollection(tab.id, c.id)}>
                  {c.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {onMoveToSection && sections && sections.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput /> Move to section
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <SectionMenuItems sections={sections} parentId={null} onSelect={(sectionId) => onMoveToSection(tab.id, sectionId)} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {(onInspect || onAddDependency || onRemoveFromCollection || onMoveToCollection || onMoveToSection) && <DropdownMenuSeparator />}
        {CATEGORY_ORDER.map((id) => (
          <DropdownMenuItem key={id} onClick={() => onCategoryChange(tab.id, id)}>
            Move to {CATEGORIES[id].name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
