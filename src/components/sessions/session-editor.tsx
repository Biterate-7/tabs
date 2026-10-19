"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { createId } from "@/lib/id"
import { createTimestamp } from "@/lib/timestamps"
import { describeWriteError } from "@/lib/sessions/messages"
import { replaceSessionTabs } from "@/lib/sessions/model"
import { writeSessions } from "@/lib/sessions/persistence"
import { SavedTabRow } from "./saved-tab-row"
import type { SavedTab, TabSession } from "@/lib/sessions/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Edit a session's tabs: remove some, change their order. Nothing is stored
 * until "Save changes"; Cancel (or closing) leaves the saved session exactly
 * as it was. A save is refused when the session changed elsewhere since this
 * opened, rather than overwriting that change.
 */
export function SessionEditor({ session, onClose }: { session: TabSession | null; onClose: () => void }) {
  return (
    <Dialog open={session !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
        {session && <EditorBody key={session.id} session={session} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function EditorBody({ session, onClose }: { session: TabSession; onClose: () => void }) {
  const [draft, setDraft] = useState<SavedTab[]>(() => session.tabs)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [revision] = useState(session.revision)

  const removed = session.tabs.length - draft.length
  const reordered = removed === 0 && draft.some((tab, index) => tab.id !== session.tabs[index]?.id)
  const changed = removed > 0 || reordered

  function move(index: number, by: -1 | 1) {
    setDraft((current) => {
      const target = index + by
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function removeSelected() {
    setDraft((current) => current.filter((tab) => !selected.has(tab.id)))
    setSelected(new Set())
  }

  function save() {
    const result = writeSessions((state) => replaceSessionTabs(state, session.id, draft, { now: createTimestamp(), mintId: createId, expectedRevision: revision }))
    if (!result.ok) {
      setError(describeWriteError(result.error))
      return
    }
    toast.success(`Updated “${result.value.name}”`, { description: plural(result.value.tabs.length, "tab", "tabs") })
    onClose()
  }

  const allSelected = draft.length > 0 && selected.size === draft.length

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit tabs</DialogTitle>
        <DialogDescription className="truncate">{session.name}</DialogDescription>
      </DialogHeader>

      <div className="mt-3 flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(allSelected ? new Set() : new Set(draft.map((tab) => tab.id)))}>
          {allSelected ? "Clear selection" : "Select all"}
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={selected.size === 0} onClick={removeSelected}>
          Remove {selected.size > 0 ? plural(selected.size, "tab", "tabs") : "selected"}
        </Button>
      </div>

      <ul className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1" aria-label="Saved tabs">
        {draft.map((tab, index) => (
          <li key={tab.id}>
            <SavedTabRow
              tab={tab}
              checked={selected.has(tab.id)}
              onCheckedChange={(on) => toggle(tab.id, on)}
              actions={
                <span className="flex shrink-0">
                  <Button type="button" variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${tab.title || "tab"} up`}>
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" disabled={index === draft.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${tab.title || "tab"} down`}>
                    <ArrowDown />
                  </Button>
                </span>
              }
            />
          </li>
        ))}
      </ul>

      <p className="mt-2 text-meta text-tertiary" role="status">
        {draft.length === 0
          ? "A session needs at least one tab. To remove it entirely, delete the session."
          : `${plural(draft.length, "tab", "tabs")}${removed > 0 ? ` · ${removed} removed` : ""}${reordered ? " · reordered" : ""}`}
      </p>
      {error && (
        <p className="text-body-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="lg" disabled={!changed || draft.length === 0} onClick={save}>
          Save changes
        </Button>
      </DialogFooter>
    </>
  )
}
