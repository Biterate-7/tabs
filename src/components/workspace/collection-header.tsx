"use client"

import { ChevronDown, ChevronRight, Download, ExternalLink, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * The row a CollectionGroup renders above its (possibly collapsed) tab list.
 * Kept quiet by design (AGENTS.md-style "COLLECTION HEADER" spec section):
 * name, tab count, and expansion state are the only things always visible —
 * everything else lives behind the overflow menu.
 */
export function CollectionHeader({
  name,
  tabCount,
  expanded,
  onToggleExpanded,
  contentId,
  onRename,
  onAddTabs,
  onOpenAll,
  onExport,
  onDelete,
}: {
  name: string
  tabCount: number
  expanded: boolean
  onToggleExpanded: () => void
  /** id of the expandable content region this header controls — wires aria-controls for screen readers. */
  contentId: string
  onRename: () => void
  onAddTabs: () => void
  onOpenAll: () => void
  onExport?: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-1 py-1">
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-tertiary" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-tertiary" aria-hidden />
        )}
        <span className="truncate text-body font-medium text-foreground">{name}</span>
        <span className="shrink-0 text-meta text-tertiary">
          {tabCount} tab{tabCount === 1 ? "" : "s"}
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton aria-label={`More actions for ${name}`} className="shrink-0">
              <MoreHorizontal />
            </IconButton>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAddTabs}>
            <Plus /> Add tabs
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenAll} disabled={tabCount === 0}>
            <ExternalLink /> Open all
          </DropdownMenuItem>
          {onExport && (
            <DropdownMenuItem onClick={onExport} disabled={tabCount === 0}>
              <Download /> Export
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete collection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
