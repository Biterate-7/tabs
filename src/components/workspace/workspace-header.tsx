"use client"

import type { ReactNode } from "react"
import { toast } from "sonner"
import { Sparkles, Trash2, MoreHorizontal, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Kbd } from "@/components/ui/kbd"
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
  workspaceSwitcher,
  currentWorkspace,
  allWorkspaces,
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
  workspaceSwitcher?: ReactNode
  currentWorkspace?: Workspace
  allWorkspaces?: Workspace[]
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
          <div className="mr-auto">
            {workspaceSwitcher ?? (
              <p className="text-body font-semibold tracking-tight text-foreground">TabDump</p>
            )}
            <p className="text-meta text-tertiary">
              {tabCount} tab{tabCount === 1 ? "" : "s"}
            </p>
          </div>

          {onOpenPalette && (
            <button
              type="button"
              onClick={onOpenPalette}
              className="hidden items-center gap-1.5 rounded-lg border border-subtle px-2 py-1 text-tertiary transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:text-foreground md:inline-flex"
              aria-label="Open command palette"
            >
              <span className="text-label">Commands</span>
              <Kbd keys={["⌘", "K"]} />
            </button>
          )}

          <div className="hidden items-center gap-1.5 sm:flex">
            <Button variant="ghost" size="sm" onClick={onCleanup}>
              <Sparkles /> Cleanup
            </Button>
            <ExportMenu tabs={tabs} currentWorkspace={currentWorkspace} allWorkspaces={allWorkspaces} />
            <Button variant="ghost" size="sm" onClick={onRequestClear}>
              <Trash2 /> Clear
            </Button>
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
