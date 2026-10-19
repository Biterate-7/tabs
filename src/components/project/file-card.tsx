"use client"

import { Download, FileText, FileType2, Info, MessageSquareShare, MoreHorizontal, RotateCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { StatusLine } from "./source-status"
import { canRereadFile } from "@/lib/files/note"
import { FILE_FORMAT_LABEL, formatBytes } from "@/lib/files/formats"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { NoteFile, ProjectNote } from "@/lib/notes/notes"

export type FileCardActions = {
  onOpen: (note: ProjectNote) => void
  onUseInAi?: (note: ProjectNote) => void
  onDownload: (note: ProjectNote) => void
  onRetry: (note: ProjectNote) => void
  onRemove: (note: ProjectNote) => void
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`

/** What Hubble holds for a ready file, in words: "12 pages", "1,840 words". */
export function fileContentLine(note: ProjectNote, file: NoteFile): string {
  const amount = file.pages ? plural(file.pages, "page", "pages") : plural(Math.max(1, Math.round(note.chars / 6)), "word", "words")
  return `${amount}${file.truncated ? " (first part)" : ""}`
}

/**
 * One uploaded file in a project — the same shape as a source's card, so the
 * list reads as one list:
 *
 *   ☐  ▤  Lecture 4
 *         PDF · 2.1 MB · 3 min ago
 *         ◌ Reading…                     (only when not simply ready)
 *         [Read] [⇪] [•••]
 *
 * Ready says nothing about being ready. Reading, kept-without-text (a scan)
 * and couldn't-read say so, with the reason in words.
 */
export function FileCard({
  note,
  now,
  actions,
  selection,
}: {
  note: ProjectNote
  now: number
  actions: FileCardActions
  selection?: { selected: boolean; onToggle: () => void }
}) {
  const file = note.file!
  const Icon = file.format === "pdf" ? FileText : FileType2
  const added = formatRelativeTime(note.createdAt, now)
  const detail = file.status === "ready" ? undefined : file.error?.message
  return (
    <li
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-md border border-subtle bg-card p-3 transition-[border-color] duration-(--duration-fast) hover:border-strong",
        selection?.selected && "border-ring"
      )}
      data-file-card={note.id}
      data-file-status={file.status}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {selection && <Checkbox checked={selection.selected} onCheckedChange={selection.onToggle} aria-label={`Select ${note.title}`} className="mt-0.5" />}
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <button type="button" className="block w-full truncate text-left text-body text-foreground outline-none hover:underline focus-visible:underline" title={file.name} onClick={() => actions.onOpen(note)}>
            {note.title}
          </button>
          <p className="flex min-w-0 items-center gap-1 truncate text-meta text-tertiary">
            <span className="shrink-0">{FILE_FORMAT_LABEL[file.format]}</span>
            <span className="shrink-0">· {formatBytes(file.size)}</span>
            {file.status === "ready" ? <span className="shrink-0">· {fileContentLine(note, file)}</span> : null}
            {added ? <span className="shrink-0">· {added}</span> : null}
          </p>
        </div>
      </div>
      {file.status !== "ready" && <StatusLine status={file.status} {...(detail ? { detail } : {})} />}
      <div className="mt-auto flex flex-wrap items-center gap-1">
        <Button type="button" size="xs" variant="secondary" onClick={() => actions.onOpen(note)} aria-label={`Read ${note.title}`}>
          Read
        </Button>
        {actions.onUseInAi && file.status === "ready" && (
          <IconButton className="size-6" aria-label={`Use ${note.title} in an AI chat`} tooltip="Use in AI chat" onClick={() => actions.onUseInAi!(note)}>
            <MessageSquareShare />
          </IconButton>
        )}
        {canRereadFile(file) && (
          <Button type="button" size="xs" variant="ghost" onClick={() => actions.onRetry(note)} aria-label={`Read ${note.title} again`}>
            <RotateCw /> Try again
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={`More actions for ${note.title}`} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => actions.onOpen(note)}>
              <Info /> View details
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.onDownload(note)}>
              <Download /> Download original
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.onRemove(note)}>
              <Trash2 /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
