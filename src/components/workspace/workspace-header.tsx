"use client"

import { toast } from "sonner"
import { Command, Sparkles, Trash2, MoreHorizontal, FileText, Wand2, Waypoints, PanelLeftOpen } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SearchBar } from "@/components/workspace/search-bar"
import { ExportMenu } from "@/components/workspace/export-menu"
import { buildExportText, downloadTextFile } from "@/lib/workspace/export"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Collection } from "@/lib/collections/types"

export function WorkspaceHeader({
  tabs,
  searchValue,
  onSearch,
  onSearchArrowDown,
  onSearchArrowUp,
  onSearchEnter,
  onCleanup,
  onRequestClear,
  onOpenPalette,
  onOrganize,
  onOpenGraph,
  onOpenSidebar,
  currentWorkspace,
  allWorkspaces,
  dependencies,
  collections,
}: {
  tabs: Tab[]
  searchValue: string
  onSearch: (query: string) => void
  onSearchArrowDown?: () => void
  onSearchArrowUp?: () => void
  onSearchEnter?: () => void
  onCleanup: () => void
  onRequestClear: () => void
  onOpenPalette?: () => void
  /** Manually re-runs Auto-Organize analysis on demand — omitted in standalone/test contexts. */
  onOrganize?: () => void
  onOpenGraph?: () => void
  /** Opens the mobile sidebar drawer — the sidebar has no other affordance below the `md` breakpoint. Omitted in standalone/test contexts that don't render a shell around this view. */
  onOpenSidebar?: () => void
  currentWorkspace?: Workspace
  allWorkspaces?: Workspace[]
  dependencies?: TabDependency[]
  collections?: Collection[]
}) {
  const tabCount = tabs.length

  function handleExportTxt() {
    const ok = downloadTextFile("tabdump-export.txt", buildExportText(tabs))
    if (ok) toast.success("Workspace exported")
    else toast.error("Couldn't export workspace")
  }

  return (
    <header className="border-b border-subtle">
      <div className="mx-auto max-w-6xl px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          {onOpenSidebar && (
            <IconButton aria-label="Open sidebar" tooltip="Spaces" onClick={onOpenSidebar} className="md:hidden">
              <PanelLeftOpen />
            </IconButton>
          )}

          <div className="mr-auto">
            {/* Workspace identity now lives in the persistent sidebar (see
               AppSidebar) — this header only needs the tab count, not a
               second copy of the current workspace's name. */}
            <p className="text-meta text-tertiary">
              {tabCount} tab{tabCount === 1 ? "" : "s"}
            </p>
          </div>

          {onOpenPalette && (
            <IconButton
              aria-label="Open command palette"
              tooltip="Open command palette"
              shortcut="Ctrl + K"
              onClick={onOpenPalette}
              className="hidden md:inline-flex"
            >
              <Command />
            </IconButton>
          )}

          <div className="hidden items-center gap-0.5 sm:flex">
            {onOrganize && (
              <IconButton aria-label="Organize tabs" tooltip="Auto-organize tabs" onClick={onOrganize}>
                <Wand2 />
              </IconButton>
            )}
            {onOpenGraph && (
              <IconButton aria-label="Open Graph view" tooltip="Open visual graph" onClick={onOpenGraph}>
                <Waypoints />
              </IconButton>
            )}
            <IconButton aria-label="Cleanup tabs" tooltip="Find duplicate & broken tabs" onClick={onCleanup}>
              <Sparkles />
            </IconButton>
            <ExportMenu
              tabs={tabs}
              currentWorkspace={currentWorkspace}
              allWorkspaces={allWorkspaces}
              dependencies={dependencies}
              collections={collections}
            />
            <IconButton
              aria-label="Clear"
              tooltip="Remove all tabs in this workspace"
              destructive
              onClick={onRequestClear}
            >
              <Trash2 />
            </IconButton>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton
                  aria-label="More actions"
                  tooltip="More actions"
                  className="sm:hidden"
                >
                  <MoreHorizontal />
                </IconButton>
              }
            />
            <DropdownMenuContent align="end">
              {onOpenPalette && (
                <DropdownMenuItem onClick={onOpenPalette}>Command menu</DropdownMenuItem>
              )}
              {onOrganize && (
                <DropdownMenuItem onClick={onOrganize}>
                  <Sparkles /> Organize
                </DropdownMenuItem>
              )}
              {onOpenGraph && (
                <DropdownMenuItem onClick={onOpenGraph}>
                  <Waypoints /> Graph view
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onCleanup}>
                <Sparkles /> Cleanup
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportTxt}>
                <FileText /> Export as TXT
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onRequestClear}>
                <Trash2 /> Clear workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <SearchBar
            value={searchValue}
            onChange={onSearch}
            onArrowDown={onSearchArrowDown}
            onArrowUp={onSearchArrowUp}
            onEnter={onSearchEnter}
            className="order-last w-full basis-full sm:order-none sm:w-64 sm:basis-auto"
          />
        </div>
      </div>
    </header>
  )
}
