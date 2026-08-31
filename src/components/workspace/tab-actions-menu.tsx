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
import type { Tab } from "@/lib/tabs/types"
import { openTab } from "@/lib/browser/open-tab"

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
  trigger: ReactElement
  align?: "start" | "end" | "center"
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align}>
        <DropdownMenuItem onClick={() => openTab(tab.url)}>Open</DropdownMenuItem>
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
        {(onInspect || onAddDependency || onRemoveFromCollection || onMoveToCollection) && <DropdownMenuSeparator />}
        {CATEGORY_ORDER.map((id) => (
          <DropdownMenuItem key={id} onClick={() => onCategoryChange(tab.id, id)}>
            Move to {CATEGORIES[id].name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
