"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

/**
 * The label/textarea/Done body used by TabNotesButton's popover. Callers own
 * the draft state and open/close semantics, so this stays a plain
 * presentational piece rather than a stateful editor.
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
