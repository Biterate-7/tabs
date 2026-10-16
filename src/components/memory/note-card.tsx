"use client"

import { MessageSquareShare, MessagesSquare, MoreHorizontal, NotebookPen, Quote, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProviderBadge } from "./provider-mark"
import { KNOWLEDGE_TYPE_LABEL } from "@/lib/memory/items"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { ProjectNote } from "@/lib/notes/notes"

const ICON = { note: NotebookPen, excerpt: Quote, conversation: MessagesSquare } as const

/**
 * One project note in the Knowledge Centre — a note, a kept passage, or an
 * AI conversation saved without its address. Same shape as a source's card,
 * so the list reads as one list.
 */
export function NoteCard({
  note,
  now,
  onOpen,
  onUseInAi,
  onDelete,
  selection,
}: {
  note: ProjectNote
  now: number
  onOpen: () => void
  onUseInAi?: () => void
  onDelete: () => void
  selection?: { selected: boolean; onToggle: () => void }
}) {
  const Icon = ICON[note.kind]
  const added = formatRelativeTime(note.createdAt, now)
  return (
    <li
      className={cn("group flex min-w-0 flex-col gap-2 rounded-md border border-subtle bg-card p-3 transition-[border-color] duration-(--duration-fast) hover:border-strong", selection?.selected && "border-ring")}
      data-note-card={note.id}
      data-note-kind={note.kind}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {selection && <Checkbox checked={selection.selected} onCheckedChange={selection.onToggle} aria-label={`Select ${note.title}`} className="mt-0.5" />}
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <button type="button" className="block w-full truncate text-left text-body text-foreground outline-none hover:underline focus-visible:underline" title={note.title} onClick={onOpen}>
            {note.title}
          </button>
          <p className="flex min-w-0 items-center gap-1 truncate text-meta text-tertiary">
            {note.provider ? <ProviderBadge provider={note.provider} /> : null}
            <span className="shrink-0">{note.provider ? "· " : ""}{KNOWLEDGE_TYPE_LABEL[note.kind]}</span>
            {note.turns ? <span className="shrink-0">· {note.turns} turns</span> : null}
            {added ? <span className="shrink-0">· {added}</span> : null}
          </p>
          {note.tags && note.tags.length > 0 && <p className="mt-0.5 truncate text-meta text-muted-foreground">{note.tags.map((tag) => `#${tag}`).join(" ")}</p>}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1">
        <Button type="button" size="xs" variant="secondary" onClick={onOpen} aria-label={`Read ${note.title}`}>
          Read
        </Button>
        {onUseInAi && (
          <IconButton className="size-6" aria-label={`Use ${note.title} in an AI chat`} tooltip="Use in AI chat" onClick={onUseInAi}>
            <MessageSquareShare />
          </IconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={`More actions for ${note.title}`} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
