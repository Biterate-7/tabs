"use client"

import { Loader2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { UndoAction } from "@/lib/ai/types"

/**
 * Renders the [Undo] control attached to one assistant message. "unavailable"
 * renders nothing here — the explanatory "I can't safely undo..." text
 * arrives as its own follow-up assistant message (see useAskTabDump), so
 * there's nothing useful left for the button itself to say.
 */
export function UndoActionButton({ undo, onUndo }: { undo: UndoAction; onUndo: () => void }) {
  if (undo.status === "undone") {
    return (
      <p className="flex items-center gap-1 text-body-sm text-tertiary">
        <Undo2 className="size-3.5" aria-hidden />
        Undone
      </p>
    )
  }

  if (undo.status === "unavailable") return null

  const isUndoing = undo.status === "undoing"
  return (
    <Button size="sm" variant="ghost" onClick={onUndo} disabled={isUndoing}>
      {isUndoing ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 aria-hidden />}
      {isUndoing ? "Undoing…" : "Undo"}
    </Button>
  )
}
