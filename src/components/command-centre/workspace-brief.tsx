"use client"

import { useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { BRIEF_LIMITS, briefCountsLine } from "@/lib/workspace/brief"
import type { WorkspaceBriefView } from "@/lib/workspace/brief"

/**
 * The workspace brief, where an agent works (Hubble 1.5): the workspace's
 * name, what it is for and what is being worked on now — in the user's own
 * words — and how much it holds.
 *
 *     Research                                   Edit
 *     Research and organize sources for the climate policy project.
 *     Focus  Comparing carbon-pricing approaches.
 *     12 tabs · 3 collections · 4 recent changes
 *     Pricing Research · Competitors · Policy
 *
 * Edited in place: two one-line fields, Save or Escape, focus back on Edit.
 * Nothing here is generated, and an empty brief says how to write one rather
 * than showing a blank.
 */
export function WorkspaceBrief({
  view,
  detail,
  onSave,
}: {
  view: WorkspaceBriefView
  /** One quieter sentence beneath — what the agent can reach here. */
  detail?: string
  /** Absent: read-only (a historical session, a deleted workspace). */
  onSave?: (brief: { description: string; focus: string }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState("")
  const [focus, setFocus] = useState("")
  const editButton = useRef<HTMLButtonElement>(null)
  const id = useId()
  const hasBrief = Boolean(view.description || view.focus)

  const open = () => {
    setDescription(view.description ?? "")
    setFocus(view.focus ?? "")
    setEditing(true)
  }
  const close = () => {
    setEditing(false)
    // Back where the person was, once the form is gone.
    requestAnimationFrame(() => editButton.current?.focus())
  }
  const save = () => {
    onSave?.({ description, focus })
    close()
  }

  if (editing) {
    return (
      <form
        aria-label={`Brief for ${view.name}`}
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            close()
          }
        }}
      >
        <p className="truncate text-body-sm text-foreground">{view.name}</p>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-description`} className="text-meta text-tertiary">
            What it&apos;s for
          </label>
          <Input
            id={`${id}-description`}
            autoFocus
            value={description}
            maxLength={BRIEF_LIMITS.description}
            placeholder="Research and organize sources for…"
            onChange={(event) => setDescription(event.target.value)}
            className="h-7 text-body-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-focus`} className="text-meta text-tertiary">
            Current focus
          </label>
          <Input
            id={`${id}-focus`}
            value={focus}
            maxLength={BRIEF_LIMITS.focus}
            placeholder="Comparing…"
            onChange={(event) => setFocus(event.target.value)}
            className="h-7 text-body-sm"
          />
        </div>
        <p className="text-meta text-tertiary">Agents working here receive this. Don&apos;t include passwords or keys.</p>
        <div className="flex items-center justify-end gap-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" size="xs">
            Save
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-1" data-workspace-brief>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-body-sm text-foreground">{view.name}</p>
        {onSave && (
          <Button
            ref={editButton}
            type="button"
            size="xs"
            variant="ghost"
            aria-label={hasBrief ? `Edit brief for ${view.name}` : `Add a brief for ${view.name}`}
            onClick={open}
          >
            {hasBrief ? "Edit" : "Add brief"}
          </Button>
        )}
      </div>
      {view.description && <p className="line-clamp-3 break-words text-body-sm text-muted-foreground">{view.description}</p>}
      {view.focus && (
        <p className="flex min-w-0 items-baseline gap-1.5 text-body-sm">
          <span className="shrink-0 text-meta text-tertiary">Focus</span>
          <span className="line-clamp-2 min-w-0 break-words text-foreground">{view.focus}</span>
        </p>
      )}
      {!hasBrief && onSave && (
        <p className="text-meta text-tertiary">Say what this workspace is for, so agents working here know.</p>
      )}
      <p className="text-meta text-tertiary">{briefCountsLine(view)}</p>
      {view.importantCollections.length > 0 && (
        <p className="truncate text-meta text-muted-foreground" title={view.importantCollections.map((collection) => collection.name).join(" · ")}>
          {view.importantCollections.map((collection) => collection.name).join(" · ")}
        </p>
      )}
      {detail && <p className="text-meta text-tertiary">{detail}</p>}
    </div>
  )
}
