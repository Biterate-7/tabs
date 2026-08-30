"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

/**
 * The label/textarea/Done body shared by every notes editor surface —
 * extracted from TabNotesButton so the Graph view's node-anchored popover
 * (graph-notes-popover.tsx) can reuse the exact same fields instead of a
 * second implementation. Callers own the draft state and open/close
 * semantics (base-ui Popover vs. a canvas-anchored fixed panel), since those
 * differ enough between call sites that sharing them would mean threading
 * one component through two very different positioning strategies.
 */
export function NotesEditorFields({
  id,
  value,
  onChange,
  onDone,
  placeholder,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  onDone: () => void
  placeholder: string
}) {
  return (
    <>
      <label htmlFor={id} className="text-label text-tertiary">
        Notes
      </label>
      <Textarea
        id={id}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-2"
        rows={4}
      />
      <div className="mt-2 flex justify-end">
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  )
}
