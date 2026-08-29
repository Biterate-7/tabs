"use client"

import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { GraphNode } from "@/lib/graph/types"
import type { HoverInfo } from "./graph-canvas"

/** A lightweight hover tooltip positioned at the last known cursor point — deliberately not tracking continuous physics motion frame-by-frame, since a hover target barely moves once the layout has settled. */
export function GraphNodeTooltip({ hover }: { hover: HoverInfo | null }) {
  if (!hover) return null
  const node: GraphNode = hover.node
  const category = (node.tab.category as CategoryId | undefined) ?? "other"
  const title = node.tab.title?.trim() || node.tab.domain

  return (
    <div
      className="pointer-events-none fixed z-50 max-w-64 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-md bg-popover px-2.5 py-1.5 text-label text-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left: hover.screenX, top: hover.screenY }}
    >
      <p className="truncate font-medium text-foreground">{title}</p>
      <p className="truncate text-tertiary">{node.tab.domain}</p>
      <p className="mt-0.5 flex items-center gap-1 text-tertiary">
        <span className="truncate">{node.workspaceName}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{CATEGORIES[category].name}</span>
      </p>
    </div>
  )
}
