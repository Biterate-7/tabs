"use client"

import { Copy, ExternalLink, FileUp, Info, MoreHorizontal, Pencil, RotateCw, Trash2, Captions, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SourceStatus } from "./source-status"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { formatRelativeTime } from "@/lib/time-format"
import { RESOURCE_KIND_LABEL } from "@/lib/resources/types"
import { cn } from "@/lib/utils"
import type { Tab } from "@/lib/tabs/types"

export type SourceActions = {
  onOpen: (tab: Tab) => void
  /** "Ask AI" about this one resource. */
  onUseInTask?: (tab: Tab) => void
  onRename: (tab: Tab) => void
  onRemove: (tab: Tab) => void
  onRetry: (tab: Tab) => void
  onDetails: (tab: Tab) => void
  onCopyUrl: (tab: Tab) => void
}

/**
 * One resource in a subject:
 *
 *   ☐  ▶  Cuban Missile Crisis Explained
 *         youtube.com · YouTube video · 4 min ago
 *         ⓘ Saved · Transcript isn't available — add one…   (only when not simply ready)
 *         [Open] [Ask AI] [•••]
 *
 * A ready resource says nothing about being ready — that is the normal case,
 * and the student does not need to be told it. Reading, saved-without-text
 * and couldn't-read still say so, with what fixes them.
 *
 * `selection` turns on the checkbox, for "select some → Ask AI".
 */
export function ResourceCard({
  tab,
  now,
  actions,
  highlighted = false,
  selection,
}: {
  tab: Tab
  now: number
  actions: SourceActions
  highlighted?: boolean
  selection?: { selected: boolean; onToggle: () => void }
}) {
  const resource = tab.resource!
  const title = tab.title?.trim() || tab.domain
  const canRetry = resource.status === "failed" || resource.status === "partial"
  const needsFile = resource.kind === "pdf" && resource.status !== "ready"
  const needsTranscript = (resource.kind === "youtube" || resource.kind === "video") && resource.status !== "ready"
  const added = formatRelativeTime(resource.addedAt, now)
  return (
    <li
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-md border border-subtle bg-card p-3 transition-[border-color] duration-(--duration-fast)",
        "hover:border-strong",
        (highlighted || selection?.selected) && "border-ring"
      )}
      data-source-card={tab.id}
      data-source-kind={resource.kind}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {selection && (
          <Checkbox
            checked={selection.selected}
            onCheckedChange={selection.onToggle}
            aria-label={`Select ${title}`}
            className="mt-0.5"
          />
        )}
        {/* The site's own icon (Chrome's, when the tab came from Chrome); the kind is named in words below. */}
        <span className="mt-0.5 flex" data-source-icon>
          <TabFavicon domain={tab.domain} icon={tab.favicon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <button type="button" className="block w-full truncate text-left text-body text-foreground outline-none hover:underline focus-visible:underline" title={title} onClick={() => actions.onDetails(tab)}>
            {title}
          </button>
          <p className="truncate text-meta text-tertiary">
            {tab.domain} · {RESOURCE_KIND_LABEL[resource.kind]}
            {added ? ` · ${added}` : ""}
          </p>
        </div>
      </div>
      {resource.status !== "ready" && <SourceStatus resource={resource} />}
      <div className="mt-auto flex flex-wrap items-center gap-1">
        <Button type="button" size="xs" variant="secondary" onClick={() => actions.onOpen(tab)} aria-label={`Open ${title}`}>
          <ExternalLink /> Open
        </Button>
        {actions.onUseInTask && (
          <Button type="button" size="xs" variant="ghost" onClick={() => actions.onUseInTask!(tab)} aria-label={`Ask AI about ${title}`}>
            <Sparkles /> Ask AI
          </Button>
        )}
        {needsFile && (
          <Button type="button" size="xs" variant="ghost" onClick={() => actions.onDetails(tab)} aria-label={`Upload the PDF for ${title}`}>
            <FileUp /> Upload PDF
          </Button>
        )}
        {needsTranscript && (
          <Button type="button" size="xs" variant="ghost" onClick={() => actions.onDetails(tab)} aria-label={`Add a transcript for ${title}`}>
            <Captions /> Add transcript
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={`More actions for ${title}`} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => actions.onDetails(tab)}>
              <Info /> View details
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.onRename(tab)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.onCopyUrl(tab)}>
              <Copy /> Copy link
            </DropdownMenuItem>
            {canRetry && (
              <DropdownMenuItem onClick={() => actions.onRetry(tab)}>
                <RotateCw /> Read again
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.onRemove(tab)}>
              <Trash2 /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
