"use client"

import { useId, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { explanationFor, headlineFor } from "@/lib/intelligence/explain"
import { willSaveText } from "@/lib/intelligence/records"
import { ActivityRow } from "./activity-row"
import type { SuggestionEdits } from "@/lib/intelligence/proposal"
import type { ActivityRecord, Suggestion } from "@/lib/intelligence/types"

const NEW_PROJECT = "__new__"
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export type ProjectChoice = { id: string; name: string }

/**
 * Reviewing a suggestion before anything happens: every page it would save,
 * each with what Hubble knows of it; tick a page off to leave it out; pick
 * a different project or name the new one. The button says exactly what
 * pressing it does. Nothing changes until it is pressed.
 */
export function SuggestionReviewDialog({
  suggestion,
  records,
  projects,
  onOpenChange,
  onConfirm,
}: {
  suggestion: Suggestion | null
  records: readonly ActivityRecord[]
  projects: readonly ProjectChoice[]
  onOpenChange: (open: boolean) => void
  onConfirm: (suggestion: Suggestion, edits: SuggestionEdits) => void
}) {
  return (
    <Dialog open={suggestion !== null} onOpenChange={onOpenChange}>
      {suggestion && <ReviewBody key={suggestion.id} suggestion={suggestion} records={records} projects={projects} onCancel={() => onOpenChange(false)} onConfirm={onConfirm} />}
    </Dialog>
  )
}

function ReviewBody({
  suggestion,
  records,
  projects,
  onCancel,
  onConfirm,
}: {
  suggestion: Suggestion
  records: readonly ActivityRecord[]
  projects: readonly ProjectChoice[]
  onCancel: () => void
  onConfirm: (suggestion: Suggestion, edits: SuggestionEdits) => void
}) {
  const nameId = useId()
  const pages = useMemo(() => {
    const byKey = new Map(records.map((record) => [record.key, record]))
    return suggestion.recordKeys.map((key) => byKey.get(key)).filter((record): record is ActivityRecord => record !== undefined)
  }, [records, suggestion.recordKeys])
  const [kept, setKept] = useState<Set<string>>(() => new Set(pages.map((record) => record.key)))
  const initialDestination = suggestion.destination.kind === "project" ? suggestion.destination.workspaceId : NEW_PROJECT
  const [destination, setDestination] = useState(initialDestination)
  const [name, setName] = useState(suggestion.destination.kind === "new-project" ? suggestion.destination.name : "")

  const project = projects.find((entry) => entry.id === destination)
  const suggested = suggestion.destination
  const suggestedName = suggested.kind === "project" ? projects.find((entry) => entry.id === suggested.workspaceId)?.name : undefined
  const chosen = pages.filter((record) => kept.has(record.key))
  const linkOnly = chosen.filter((record) => record.kind === "conversation" && !willSaveText(record)).length
  const trimmed = name.trim()
  const valid = chosen.length > 0 && (destination !== NEW_PROJECT || trimmed.length > 0)
  const confirmLabel =
    destination === NEW_PROJECT ? `Create “${trimmed || "project"}” with ${plural(chosen.length, "item", "items")}` : `Add ${plural(chosen.length, "item", "items")} to ${project?.name ?? "project"}`

  // Alternatives the engine found go first, then every other project.
  const options = [
    ...projects
      .slice()
      .sort((a, b) => Number(suggestion.alternatives.includes(b.id)) - Number(suggestion.alternatives.includes(a.id)))
      .map((entry) => ({ value: entry.id, label: entry.name })),
    { value: NEW_PROJECT, label: "New project…" },
  ]

  const toggle = (key: string) =>
    setKept((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{headlineFor(suggestion, pages, suggestedName)}</DialogTitle>
        <DialogDescription>{explanationFor(suggestion, suggestedName, pages.length)}</DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-label text-muted-foreground">Save to</p>
          <Select value={destination} onValueChange={setDestination} options={options} />
          {destination === NEW_PROJECT && (
            <div className="flex flex-col gap-1">
              <label htmlFor={nameId} className="sr-only">
                Project name
              </label>
              <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" maxLength={120} autoFocus />
            </div>
          )}
        </div>

        <ul aria-label="Items" className="flex max-h-[min(50vh,22rem)] min-w-0 flex-col overflow-y-auto rounded-md border border-subtle">
          {pages.map((record) => {
            const on = kept.has(record.key)
            return (
              <li key={record.key} className="flex min-w-0 items-center gap-3 border-b border-subtle px-3 py-2 last:border-b-0">
                <Checkbox checked={on} onCheckedChange={() => toggle(record.key)} aria-label={`Include ${record.title || record.domain}`} />
                {/* A sibling, not a <label> around the checkbox: the checkbox keeps its own name (see base-ui-label-wrap). */}
                <div className="min-w-0 flex-1 cursor-default" onClick={() => toggle(record.key)}>
                  <ActivityRow record={record} className={on ? "" : "opacity-50"} />
                </div>
              </li>
            )
          })}
        </ul>

        {linkOnly > 0 && (
          <p className="text-body-sm text-muted-foreground">
            {plural(linkOnly, "conversation is", "conversations are")} saved as a link: open {linkOnly === 1 ? "it" : "them"} in Chrome and use Save to Hubble to keep the text.
          </p>
        )}
        <p className="text-meta text-tertiary">Pages are read the way any source you add is. Nothing is closed in Chrome, and you can undo this.</p>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!valid}
          onClick={() =>
            onConfirm(suggestion, {
              recordKeys: chosen.map((record) => record.key),
              destination: destination === NEW_PROJECT ? { kind: "new-project", name: trimmed } : { kind: "project", workspaceId: destination },
            })
          }
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
