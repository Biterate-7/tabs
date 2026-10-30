"use client"

import { useMemo, useState } from "react"
import { Radar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ItemIcon } from "@/components/memory/item-icon"
import { useContextState } from "@/hooks/use-context-intelligence"
import { subjectName } from "@/lib/product/subjects"
import { recordIconItem } from "./activity-row"
import { suggestionPages } from "./suggestion-card"
import { SuggestionReviewDialog } from "./suggestion-review-dialog"
import type { SuggestionEdits } from "@/lib/intelligence/proposal"
import type { Suggestion } from "@/lib/intelligence/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Inside a project: pages Hubble noticed that may belong here, as one quiet
 * line — the same stored suggestion Home shows, so deciding in either place
 * decides in both. Nothing is added until the person reviews and confirms.
 */
export function ProjectContextStrip({
  workspace,
  projects,
  onAccept,
}: {
  workspace: Workspace
  projects: readonly Workspace[]
  onAccept: (suggestion: Suggestion, edits: SuggestionEdits) => Promise<boolean>
}) {
  const state = useContextState()
  const [reviewing, setReviewing] = useState<Suggestion | null>(null)
  const suggestion = useMemo(
    () => state.suggestions.find((entry) => entry.status === "open" && entry.destination.kind === "project" && entry.destination.workspaceId === workspace.id && suggestionPages(entry, state.records).length > 0),
    [state.suggestions, state.records, workspace.id]
  )
  const choices = useMemo(() => projects.map((entry) => ({ id: entry.id, name: subjectName(entry) })), [projects])
  if (!suggestion) return null
  const pages = suggestionPages(suggestion, state.records)
  return (
    <>
      <div className="mb-4 flex min-w-0 items-center gap-2 rounded-md border border-subtle bg-card px-3 py-2" role="status" data-context-strip>
        <Radar aria-hidden className="size-4 shrink-0 text-tertiary" />
        <span aria-hidden className="flex shrink-0 -space-x-1">
          {pages.slice(0, 3).map((record) => (
            <span key={record.key} className="grid size-5 place-items-center rounded-full bg-background ring-1 ring-subtle">
              <ItemIcon item={recordIconItem(record)} {...(record.favicon ? { favicon: record.favicon } : {})} size={12} className="size-3" />
            </span>
          ))}
        </span>
        <p className="min-w-0 flex-1 truncate text-body-sm text-foreground">
          {pages.length === 1 ? `“${pages[0]!.title || pages[0]!.domain}” may belong here` : `${pages.length} pages may belong here`}
        </p>
        <Button type="button" size="sm" variant="secondary" onClick={() => setReviewing(suggestion)}>
          Review
        </Button>
      </div>
      <SuggestionReviewDialog
        suggestion={reviewing}
        records={state.records}
        projects={choices}
        onOpenChange={(open) => !open && setReviewing(null)}
        onConfirm={(entry, edits) => void onAccept(entry, edits).then((done) => done && setReviewing(null))}
      />
    </>
  )
}
