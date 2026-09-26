"use client"

import { useRef, useState, type ChangeEvent } from "react"
import { ChevronsUpDown, Check, Plus, Pencil, Trash2, Upload } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { RenameWorkspaceDialog } from "@/components/workspace/rename-workspace-dialog"
import { DeleteWorkspaceDialog } from "@/components/workspace/delete-workspace-dialog"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/lib/workspace/types"

export function WorkspaceSwitcher({
  workspaces,
  currentId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onImportFile,
  onUpdateLogo,
  collapsed = false,
}: {
  workspaces: Workspace[]
  currentId: string
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  /** Reads and hands off the raw text of a user-picked .json file. */
  onImportFile: (text: string) => void
  onUpdateLogo: (id: string, logo: string | undefined) => void
  /** Renders the trigger as a compact icon badge with no name text, for the icon-rail sidebar. */
  collapsed?: boolean
}) {
  const [newOpen, setNewOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    file.text().then(onImportFile)
  }

  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            collapsed ? (
              <button
                type="button"
                className="mx-auto flex size-7 shrink-0 items-center justify-center rounded-xs transition-colors duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover"
                aria-label="Switch workspace"
              >
                <WorkspaceAvatar workspace={current ?? { name: "" }} size={20} />
              </button>
            ) : (
              <button
                type="button"
                className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-xs px-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover aria-expanded:bg-surface-hover"
                aria-label="Switch workspace"
              >
                <WorkspaceAvatar workspace={current ?? { name: "" }} size={16} />
                <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                  {current?.name ?? "Workspace"}
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 text-tertiary" />
              </button>
            )
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          {workspaces.map((w) => (
            <DropdownMenuItem key={w.id} onClick={() => onSwitch(w.id)} className="justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <Check className={cn("size-3.5 shrink-0", w.id !== currentId && "invisible")} />
                <WorkspaceAvatar workspace={w} size={16} />
                <span className="truncate">{w.name}</span>
              </span>
              <span className="shrink-0 text-meta text-tertiary">{w.tabs.length}</span>
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => setNewOpen(true)}>
            <Plus /> New workspace
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
            <Upload /> Import from JSON…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRenameOpen(true)}>
            <Pencil /> Edit &quot;{current?.name}&quot;
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 /> Delete &quot;{current?.name}&quot;
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleFileChange}
        aria-label="Import workspace JSON file"
      />

      <NewWorkspaceDialog open={newOpen} onOpenChange={setNewOpen} onCreate={onCreate} />

      {current && (
        <>
          <RenameWorkspaceDialog
            key={current.id}
            open={renameOpen}
            onOpenChange={setRenameOpen}
            currentName={current.name}
            onRename={(name) => onRename(current.id, name)}
            logo={current.logo}
            onLogoChange={(logo) => onUpdateLogo(current.id, logo)}
          />
          <DeleteWorkspaceDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            workspaceName={current.name}
            tabCount={current.tabs.length}
            onConfirm={() => {
              setDeleteOpen(false)
              onDelete(current.id)
            }}
          />
        </>
      )}
    </>
  )
}
