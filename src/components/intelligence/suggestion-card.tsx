"use client"

import { useEffect, useMemo } from "react"
import { ChevronDown, FolderPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProjectIcon } from "@/components/workspace/project-icon"
import { explanationFor, headlineFor } from "@/lib/intelligence/explain"
import { markSurfaced } from "@/lib/intelligence/decisions"
import { writeContext } from "@/lib/intelligence/persistence"
import { subjectName } from "@/lib/product/subjects"
import { cn } from "@/lib/utils"
import { ActivityRow } from "./activity-row"
import type { DismissReason } from "@/lib/intelligence/decisions"
import type { SuggestionEdits } from "@/lib/intelligence/proposal"
import type { ActivityRecord, Suggestion } from "@/lib/intelligence/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Smart Save and Smart Organize, as Hubble shows them: a compact card per
 * suggestion — what it proposes in one line, why in another (only words the
 * pages actually share), where it would go, the pages themselves with their
 * real icons and how much Hubble knows of each, one button that does exactly
 * what it says, Review to change any of it, and a way to say no.
 *
 * Every surface reads the same stored suggestions (lib/intelligence), so a
 * suggestion dismissed here is gone everywhere.
 */

export type SuggestionActions = {
  accept: (suggestion: Suggestion, edits: SuggestionEdits) => void
  review: (suggestion: Suggestion) => void
  dismiss: (suggestion: Suggestion, reason: DismissReason) => void
}

const VISIBLE_PAGES = 3

export function suggestionPages(suggestion: Suggestion, records: readonly ActivityRecord[]): ActivityRecord[] {
  const byKey = new Map(records.map((record) => [record.key, record]))
  return suggestion.recordKeys.map((key) => byKey.get(key)).filter((record): record is ActivityRecord => record !== undefined)
}

export function SuggestionCard({
  suggestion,
  records,
  workspaces,
  actions,
  pending = false,
}: {
  suggestion: Suggestion
  records: readonly ActivityRecord[]
  workspaces: readonly Workspace[]
  actions: SuggestionActions
  pending?: boolean
}) {
  const pages = suggestionPages(suggestion, records)
  const destination = suggestion.destination
  const workspace = destination.kind === "project" ? workspaces.find((entry) => entry.id === destination.workspaceId) : undefined
  const projectName = workspace ? subjectName(workspace) : undefined
  if (pages.length === 0 || (destination.kind === "project" && !workspace)) return null
  const more = pages.length - VISIBLE_PAGES
  const primary =
    destination.kind === "project" ? `Save to ${projectName}` : `Create “${destination.name}”`
  const notThisProject = destination.kind === "project" ? `Not ${projectName}` : "Not a project"

  return (
    <article
      aria-label={headlineFor(suggestion, pages, projectName)}
      data-suggestion={suggestion.id}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-(--shadow-panel)"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-surface-hover">
          {workspace ? <ProjectIcon workspace={workspace} size={16} /> : <FolderPlus aria-hidden className="size-4 text-muted-foreground" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-body text-foreground">{headlineFor(suggestion, pages, projectName)}</h3>
          <p className="mt-0.5 text-body-sm text-muted-foreground">{explanationFor(suggestion, projectName, pages.length)}</p>
        </div>
        {suggestion.band === "review" && <span className="shrink-0 rounded-full px-1.5 py-px text-meta text-tertiary ring-1 ring-inset ring-subtle">Check first</span>}
      </div>

      <ul aria-label="Items in this suggestion" className="flex min-w-0 flex-col gap-2 border-l border-subtle pl-3">
        {pages.slice(0, VISIBLE_PAGES).map((record) => (
          <li key={record.key} className="min-w-0">
            <ActivityRow record={record} />
          </li>
        ))}
        {more > 0 && (
          <li>
            <button type="button" onClick={() => actions.review(suggestion)} className="text-meta text-tertiary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
              and {more} more
            </button>
          </li>
        )}
      </ul>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => actions.accept(suggestion, { recordKeys: pages.map((record) => record.key), destination: destination.kind === "project" ? destination : { kind: "new-project", name: destination.name } })}
        >
          {pending ? "Saving…" : primary}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => actions.review(suggestion)}>
          Review
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" disabled={pending} />}>
            Not now <ChevronDown aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => actions.dismiss(suggestion, "not-now")}>Not now — ask in a few days</DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.dismiss(suggestion, "wrong-project")}>{notThisProject}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.dismiss(suggestion, "not-relevant")}>Not relevant — don&rsquo;t suggest these again</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  )
}

/**
 * Home's suggestions: a few at a time, strongest first. Marks what it shows
 * as surfaced, so a suggestion is announced once.
 */
export function SuggestionList({
  suggestions,
  records,
  workspaces,
  actions,
  pendingId,
  limit = 2,
  className,
}: {
  suggestions: readonly Suggestion[]
  records: readonly ActivityRecord[]
  workspaces: readonly Workspace[]
  actions: SuggestionActions
  pendingId?: string
  limit?: number
  className?: string
}) {
  const shown = useMemo(
    () =>
      suggestions
        .filter((suggestion) => suggestion.status === "open")
        .filter((suggestion) => suggestion.destination.kind !== "project" || workspaces.some((workspace) => suggestion.destination.kind === "project" && workspace.id === suggestion.destination.workspaceId))
        .filter((suggestion) => suggestionPages(suggestion, records).length > 0)
        .sort((a, b) => Number(b.band === "strong") - Number(a.band === "strong") || b.confidence - a.confidence || b.updatedAt - a.updatedAt)
        .slice(0, limit),
    [suggestions, records, workspaces, limit]
  )
  const unannounced = shown.filter((suggestion) => !suggestion.surfacedAt).map((suggestion) => suggestion.id).join(",")
  useEffect(() => {
    if (!unannounced) return
    writeContext((state) => markSurfaced(state, unannounced.split(","), Date.now()))
  }, [unannounced])
  if (shown.length === 0) return null
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {shown.map((suggestion) => (
        <SuggestionCard key={suggestion.id} suggestion={suggestion} records={records} workspaces={workspaces} actions={actions} pending={pendingId === suggestion.id} />
      ))}
    </div>
  )
}
