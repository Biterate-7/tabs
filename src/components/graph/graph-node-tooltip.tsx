"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { GraphNode } from "@/lib/graph/types"
import type { HoverInfo } from "./graph-canvas"
import { TabPeekContent } from "@/components/workspace/tab-peek-content"
import { computeTabPeekContext, type TabPeekContext } from "@/lib/tabs/peek"

const PEEK_WIDTH = 320
const PEEK_EST_HEIGHT = 280
const EDGE_MARGIN = 12

function clampPeekPosition(x: number, y: number): { left: number; top: number; origin: string } {
  if (typeof window === "undefined") return { left: x, top: y, origin: "top center" }
  const vw = window.innerWidth
  const vh = window.innerHeight

  let left = x - PEEK_WIDTH / 2
  let originX = "center"
  if (left < EDGE_MARGIN) {
    left = EDGE_MARGIN
    originX = "left"
  } else if (left + PEEK_WIDTH > vw - EDGE_MARGIN) {
    left = vw - EDGE_MARGIN - PEEK_WIDTH
    originX = "right"
  }

  let top = y + 16
  let originY = "top"
  if (top + PEEK_EST_HEIGHT > vh - EDGE_MARGIN) {
    top = y - PEEK_EST_HEIGHT - 16
    originY = "bottom"
  }
  if (top < EDGE_MARGIN) top = EDGE_MARGIN

  return { left, top, origin: `${originY} ${originX}` }
}

function nodeTitle(node: GraphNode): string {
  return node.tab.title?.trim() || node.tab.domain
}

/**
 * Renders two independent, non-conflated pieces of UI over the Graph canvas:
 *
 * - A small, non-interactive preview at the cursor for whatever node is
 *   currently `hover`ed — purely ephemeral, gone the instant the cursor
 *   moves off (no delay, nothing to keep alive).
 * - The full Tab Peek card — same TabPeekContent every DOM tab row shows via
 *   TabPeekTrigger — pinned to `selected`, the node the Graph has actually
 *   selected (clicked), positioned at its live canvas anchor rather than the
 *   cursor (see onSelectedNodeScreenChange in graph-canvas.tsx).
 *
 * The card's lifetime is tied to `selected` alone: it opens the moment a
 * node is selected and stays open — regardless of where the cursor wanders,
 * which other nodes get hovered, or the camera panning/zooming — until the
 * Graph's own selection changes (a different node, or an intentional
 * deselect). It never reacts to hover, so there's nothing for mouse movement
 * to race or accidentally tear down.
 */
export function GraphNodeTooltip({
  hover,
  selected,
  onOpenNotes,
  onCategoryChange,
  onToggleFavorite,
  onOpenTab,
}: {
  hover: HoverInfo | null
  /** The Graph's current selection with its live on-screen anchor, or null when nothing is selected. Independent of `hover` — see the component doc comment. */
  selected: HoverInfo | null
  /** Routes to the Graph's own full-page notes view (GraphNodeNotesView) rather than the inline popover editor — Graph's existing Notes entry point, reused as-is. */
  onOpenNotes?: (id: string) => void
  onCategoryChange?: (id: string, category: CategoryId) => void
  onToggleFavorite?: (id: string) => void
  onOpenTab?: (id: string) => void
}) {
  const [context, setContext] = useState<TabPeekContext | null>(null)
  const selectedIdRef = useRef<string | null>(null)

  useEffect(() => {
    const id = selected?.node.id ?? null
    if (id === selectedIdRef.current) return
    selectedIdRef.current = id
    setContext(id && selected ? computeTabPeekContext(selected.node.tab) : null)
  }, [selected])

  // The small hover preview is suppressed for the selected node itself —
  // its full card (below) already covers that node, so showing both would
  // just stack two popups on top of each other.
  const showHoverPreview = hover !== null && hover.node.id !== selected?.node.id

  return (
    <>
      {showHoverPreview && (
        <div
          className="pointer-events-none fixed z-50 max-w-64 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-md bg-popover px-2.5 py-1.5 text-label text-foreground shadow-md ring-1 ring-foreground/10"
          style={{ left: hover.screenX, top: hover.screenY }}
        >
          <p className="truncate font-medium text-foreground">{nodeTitle(hover.node)}</p>
          <p className="truncate text-tertiary">{hover.node.tab.domain}</p>
          <p className="mt-0.5 flex items-center gap-1 text-tertiary">
            <span className="truncate">{hover.node.workspaceName}</span>
            <span aria-hidden>·</span>
            <span className="truncate">
              {CATEGORIES[(hover.node.tab.category as CategoryId | undefined) ?? "other"].name}
            </span>
          </p>
        </div>
      )}

      {selected &&
        (() => {
          const { left, top, origin } = clampPeekPosition(selected.screenX, selected.screenY)
          return (
            <div
              key={selected.node.id}
              className="fixed z-50 origin-(--peek-origin) overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0 zoom-in-95"
              style={{ left, top, "--peek-origin": origin } as CSSProperties}
            >
              <TabPeekContent
                tab={selected.node.tab}
                context={context}
                onOpenNotes={onOpenNotes}
                onCategoryChange={onCategoryChange}
                onToggleFavorite={onToggleFavorite}
                onOpenTab={onOpenTab}
              />
            </div>
          )
        })()}
    </>
  )
}
