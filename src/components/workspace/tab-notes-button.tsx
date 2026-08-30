"use client"

import { useState } from "react"
import { StickyNote } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/**
 * Per-tab notes editor, rendered inline in TabCard's action row. Keeps its
 * draft text as local state and only calls onNotesChange on close (outside
 * click, Escape, or Done) — mirroring RenameWorkspaceDialog's commit-on-close
 * pattern — so a keystroke never touches the shared tabs array or triggers a
 * workspace-wide re-render.
 */
export function TabNotesButton({
  tabId,
  domain,
  notes,
  onNotesChange,
}: {
  tabId: string
  domain: string
  notes?: string
  onNotesChange: (id: string, notes: string) => void
}) {
  const hasNotes = Boolean(notes?.trim())
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(notes ?? "")

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setDraft(notes ?? "")
    } else {
      const trimmed = draft.trim()
      if (trimmed !== (notes ?? "")) onNotesChange(tabId, trimmed)
    }
    setOpen(nextOpen)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <IconButton
            aria-label={hasNotes ? `Edit note for ${domain}` : `Add note for ${domain}`}
            tooltip={hasNotes ? "Edit note" : "Add note"}
            className={cn("size-11 sm:size-8", hasNotes && "text-accent-text")}
          >
            <StickyNote fill={hasNotes ? "currentColor" : "none"} fillOpacity={hasNotes ? 0.15 : 1} />
          </IconButton>
        }
      />
      <PopoverContent>
        <label htmlFor={`tab-notes-${tabId}`} className="text-label text-tertiary">
          Notes
        </label>
        <Textarea
          id={`tab-notes-${tabId}`}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a note for ${domain}…`}
          className="mt-2"
          rows={4}
        />
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" onClick={() => handleOpenChange(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
