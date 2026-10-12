"use client"

import { useState, type ReactNode } from "react"
import { ChevronLeft, Group, MoreHorizontal, Pencil, Sparkles, Trash2, Waypoints, PanelLeftOpen, Eraser } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SearchBar } from "@/components/workspace/search-bar"
import { ExportMenu } from "@/components/workspace/export-menu"
import { RenameWorkspaceDialog } from "@/components/workspace/rename-workspace-dialog"
import { DeleteWorkspaceDialog } from "@/components/workspace/delete-workspace-dialog"
import { subjectName } from "@/lib/product/subjects"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Collection } from "@/lib/collections/types"

/** Renaming or removing the subject on screen, from its own menu. Absent: those rows are not offered. */
export type SubjectMenuActions = {
  onRename: (name: string) => void
  onUpdateLogo: (logo: string | undefined) => void
  onDelete: () => void
  /** Deleting is refused for the last subject (see deleteWorkspace). */
  canDelete: boolean
}

/**
 * A subject's bar: the way back to Subjects, search, and one menu.
 *
 *     ← Subjects                          [Search…]  ⤓  ⋯
 *
 * Everything that used to be a row of icons — Organize, Graph, Find
 * duplicates, Clear — is in the ⋯ menu, with renaming and removing the
 * subject. Export keeps its own icon: it holds several formats, and it is
 * the backup the import in Settings → Subjects reads. The subject's name
 * and its Add / Ask AI actions are the page's own heading, below this bar.
 */
export function WorkspaceHeader({
  tabs,
  searchValue,
  onSearch,
  onSearchArrowDown,
  onSearchArrowUp,
  onSearchEnter,
  onCleanup,
  onRequestClear,
  onOrganize,
  onOpenGraph,
  graphLocked = false,
  graphLockedReason,
  onOpenSidebar,
  onBack,
  subjectMenu,
  hideSearch = false,
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
  /** Kept for callers that pass it; the palette is the rail's Search now. */
  onOpenPalette?: () => void
  /** Opens Smart Organize for this subject's tabs — omitted in standalone/test contexts. */
  onOrganize?: () => void
  onOpenGraph?: () => void
  /** True while a dump is still being organized/laid out — see lib/organize/lifecycle.ts. */
  graphLocked?: boolean
  /** What the graph is waiting on, used as the disabled row's label. */
  graphLockedReason?: string
  /** Opens the mobile sidebar drawer — the sidebar has no other affordance below the `md` breakpoint. */
  onOpenSidebar?: () => void
  /** "← Subjects": back to Home. Absent outside the shell. */
  onBack?: () => void
  subjectMenu?: SubjectMenuActions
  /** No tab filter in the bar: the page has its own search for everything in it. */
  hideSearch?: boolean
  currentWorkspace?: Workspace
  allWorkspaces?: Workspace[]
  dependencies?: TabDependency[]
  collections?: Collection[]
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      <div className="px-4 py-2 sm:py-0">
        <div className="flex min-h-12 flex-wrap items-center gap-2">
          {onOpenSidebar && (
            <IconButton aria-label="Open sidebar" tooltip="Subjects" onClick={onOpenSidebar} className="md:hidden">
              <PanelLeftOpen />
            </IconButton>
          )}

          <div className="mr-auto flex min-w-0 items-center gap-2">
            {onBack ? (
              <Button type="button" variant="ghost" size="sm" className="-ml-1.5" onClick={onBack}>
                <ChevronLeft /> Subjects
              </Button>
            ) : (
              currentWorkspace && <span className="truncate text-h2 text-foreground">{subjectName(currentWorkspace)}</span>
            )}
          </div>

          {!hideSearch && (
          <SearchBar
            value={searchValue}
            onChange={onSearch}
            onArrowDown={onSearchArrowDown}
            onArrowUp={onSearchArrowUp}
            onEnter={onSearchEnter}
            className="order-last w-full basis-full sm:order-none sm:w-56 sm:basis-auto"
          />
          )}

          <div className="hidden sm:flex">
            <ExportMenu
              tabs={tabs}
              currentWorkspace={currentWorkspace}
              allWorkspaces={allWorkspaces}
              dependencies={dependencies}
              collections={collections}
            />
          </div>

          <SubjectActionsMenu
            {...(currentWorkspace ? { workspace: currentWorkspace } : {})}
            {...(subjectMenu ? { subjectMenu } : {})}
            onRequestClear={onRequestClear}
          >
              {onOrganize && (
                <DropdownMenuItem onClick={onOrganize}>
                  <Group /> Organize tabs
                </DropdownMenuItem>
              )}
              {onOpenGraph && (
                <DropdownMenuItem disabled={graphLocked} onClick={onOpenGraph}>
                  <Waypoints /> {graphLocked ? (graphLockedReason ?? "Organizing your tabs…") : "Graph view"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onCleanup}>
                <Sparkles /> Find duplicates
              </DropdownMenuItem>
          </SubjectActionsMenu>
        </div>
      </div>
    </header>
  )
}

/**
 * The subject's ⋯ menu: whatever the page adds (`children`), then renaming,
 * clearing and deleting the subject — with their dialogs. Shared by a
 * subject with things in it (WorkspaceHeader) and an empty one (ProjectPage).
 */
export function SubjectActionsMenu({
  workspace,
  subjectMenu,
  onRequestClear,
  children,
}: {
  workspace?: Workspace
  subjectMenu?: SubjectMenuActions
  /** Empties the subject. Absent: no Clear row (an empty subject has nothing to clear). */
  onRequestClear?: () => void
  children?: ReactNode
}) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton aria-label="More actions" tooltip="More">
              <MoreHorizontal />
            </IconButton>
          }
        />
        <DropdownMenuContent align="end" className="min-w-48">
          {children}
          {subjectMenu && (
            <>
              {children && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                <Pencil /> Rename subject
              </DropdownMenuItem>
            </>
          )}
          {(onRequestClear || subjectMenu?.canDelete) && <DropdownMenuSeparator />}
          {onRequestClear && (
            <DropdownMenuItem variant="destructive" onClick={onRequestClear}>
              <Eraser /> Clear
            </DropdownMenuItem>
          )}
          {subjectMenu?.canDelete && (
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 /> Delete subject
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {subjectMenu && workspace && renameOpen && (
        <RenameWorkspaceDialog
          key={workspace.id}
          open
          onOpenChange={setRenameOpen}
          currentName={workspace.name}
          onRename={subjectMenu.onRename}
          logo={workspace.logo}
          onLogoChange={subjectMenu.onUpdateLogo}
        />
      )}
      {subjectMenu && workspace && deleteOpen && (
        <DeleteWorkspaceDialog
          open
          onOpenChange={setDeleteOpen}
          workspaceName={subjectName(workspace)}
          tabCount={workspace.tabs.length}
          onConfirm={() => {
            setDeleteOpen(false)
            subjectMenu.onDelete()
          }}
        />
      )}
    </>
  )
}
