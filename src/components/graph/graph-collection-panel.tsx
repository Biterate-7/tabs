"use client"

import { ExternalLink, Layers, Pencil, Scan, Trash2 } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { EmptyState } from "@/components/ui/empty-state"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import type { Collection } from "@/lib/collections/types"
import type { GraphNode } from "@/lib/graph/types"

/**
 * The Graph View sidebar's "COLLECTION" section — shown whenever a
 * collection region is selected, mirroring GraphDependencyPanel's role for a
 * selected node. Kept concise per AGENTS.md-style "COLLECTION INSPECTOR"
 * spec: name, tab count, member list, and a short actions row — nothing
 * more.
 */
export function GraphCollectionPanel({
  collection,
  nodeById,
  onSelectTab,
  onOpenTab,
  onFocus,
  onRename,
  onOpenAll,
  onDelete,
}: {
  collection: Collection
  nodeById: Map<string, GraphNode>
  onSelectTab: (id: string) => void
  onOpenTab: (id: string) => void
  onFocus: () => void
  onRename: () => void
  onOpenAll: () => void
  onDelete: () => void
}) {
  return (
    <div className="space-y-4 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0">
      <div className="flex items-center justify-between">
        <p className="text-label text-tertiary">COLLECTION</p>
        <IconButton aria-label="Focus collection" tooltip="Focus this collection" className="size-7" onClick={onFocus}>
          <Scan />
        </IconButton>
      </div>

      <div>
        <p className="truncate text-body font-medium text-foreground">{collection.name}</p>
        <p className="text-meta text-tertiary">
          {collection.tabIds.length} tab{collection.tabIds.length === 1 ? "" : "s"}
        </p>
      </div>

      {collection.tabIds.length === 0 ? (
        <EmptyState icon={Layers} title="No tabs yet." description="Gather tabs into this collection to see them here." />
      ) : (
        <div className="space-y-0.5">
          {collection.tabIds.map((tabId) => {
            const node = nodeById.get(tabId)
            const title = node ? node.tab.title?.trim() || node.tab.domain : "Deleted tab"
            return (
              <div
                key={tabId}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-(--duration-fast) hover:bg-accent"
              >
                {node && <TabFavicon domain={node.tab.domain} size={16} />}
                <button
                  type="button"
                  onClick={() => onSelectTab(tabId)}
                  onDoubleClick={() => onOpenTab(tabId)}
                  className="min-w-0 flex-1 text-left"
                  title="Click to select · Double-click to open"
                >
                  <p className="truncate text-body-sm text-foreground">{title}</p>
                  {node && <p className="truncate text-meta text-tertiary">{node.tab.domain}</p>}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-0.5 border-t border-subtle pt-3">
        <IconButton aria-label="Rename collection" tooltip="Rename collection" className="size-7" onClick={onRename}>
          <Pencil />
        </IconButton>
        <IconButton
          aria-label="Open all in collection"
          tooltip="Open all tabs in this collection"
          className="size-7"
          onClick={onOpenAll}
          disabled={collection.tabIds.length === 0}
        >
          <ExternalLink />
        </IconButton>
        <IconButton
          aria-label="Delete collection"
          tooltip="Delete collection"
          destructive
          className="size-7"
          onClick={onDelete}
        >
          <Trash2 />
        </IconButton>
      </div>
    </div>
  )
}
