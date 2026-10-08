"use client"

import { Copy, ExternalLink, FileUp, Info, MessageSquarePlus, MoreHorizontal, Pencil, RotateCw, Trash2, Captions } from "lucide-react"
import { Button } from "@/components/ui/button"
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
  onUseInTask?: (tab: Tab) => void
  onRename: (tab: Tab) => void
  onRemove: (tab: Tab) => void
  onRetry: (tab: Tab) => void
  onDetails: (tab: Tab) => void
  onCopyUrl: (tab: Tab) => void
}

/**
 * One project source:
 *
 *   ▶  Cuban Missile Crisis Explained
 *      youtube.com · YouTube video · Added 4 min ago
 *      ⓘ Saved · Transcript isn't available — add one…
 *      [Open] [Use in task] [•••]
 */
export function ResourceCard({ tab, now, actions, highlighted = false }: { tab: Tab; now: number; actions: SourceActions; highlighted?: boolean }) {
  const resource = tab.resource!
  const title = tab.title?.trim() || tab.domain
  const canRetry = resource.status === "failed" || resource.status === "partial"
  const needsFile = resource.kind === "pdf" && resource.status !== "ready"
  const needsTranscript = (resource.kind === "youtube" || resource.kind === "video") && resource.status !== "ready"
  return (
    <li
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-md border border-subtle bg-card p-3 transition-[border-color] duration-(--duration-fast)",
        "hover:border-strong",
        highlighted && "border-ring"
      )}
      data-source-card={tab.id}
      data-source-kind={resource.kind}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {/* The site's own icon (Chrome's, when the tab came from Chrome); the kind is named in words below. */}
        <span className="mt-0.5 flex" data-source-icon>
          <TabFavicon domain={tab.domain} icon={tab.favicon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <button type="button" className="block w-full truncate text-left text-body text-foreground outline-none hover:underline focus-visible:underline" title={title} onClick={() => actions.onDetails(tab)}>
            {title}
          </button>
          <p className="truncate text-meta text-tertiary">
            {tab.domain} · {RESOURCE_KIND_LABEL[resource.kind]} · Added {formatRelativeTime(resource.addedAt, now)}
          </p>
        </div>
      </div>
      <SourceStatus resource={resource} />
      <div className="mt-auto flex flex-wrap items-center gap-1">
        <Button type="button" size="xs" variant="secondary" onClick={() => actions.onOpen(tab)} aria-label={`Open ${title}`}>
          <ExternalLink /> Open
        </Button>
        {actions.onUseInTask && (
          <Button type="button" size="xs" variant="ghost" onClick={() => actions.onUseInTask!(tab)} aria-label={`Use ${title} in a task`}>
            <MessageSquarePlus /> Use in task
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
              <Copy /> Copy URL
            </DropdownMenuItem>
            {canRetry && (
              <DropdownMenuItem onClick={() => actions.onRetry(tab)}>
                <RotateCw /> Read again
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.onRemove(tab)}>
              <Trash2 /> Remove from project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
