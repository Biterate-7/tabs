"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { GraphNode } from "@/lib/graph/types"
import type { HoverInfo } from "./graph-canvas"
import { TabPeekContent } from "@/components/workspace/tab-peek-content"
import { computeTabPeekContext, type TabPeekContext } from "@/lib/tabs/peek"

// Same hover-intent delay Tab Peek uses everywhere else (see
// TabPeekTrigger) — a canvas node has no DOM element to anchor a real
// PreviewCard to, so this reimplements just the timing/positioning by hand
// while still rendering the exact same TabPeekContent everyone else gets.
const PEEK_DELAY_MS = 400
const PEEK_CLOSE_DELAY_MS = 200
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

type NodeHoverCardProps = {
  hover: HoverInfo
  onOpenNotes?: (id: string) => void
  onCategoryChange?: (id: string, category: CategoryId) => void
}

/**
 * Owns the "has this node been hovered long enough to escalate" state for
 * exactly one hovered node. Mounted with `key={hover.node.id}` by
 * GraphNodeTooltip below, the same trick GraphNodeNotesView uses for
 * "reset on retarget" — switching to a different node remounts this with
 * fresh state instead of needing an effect to notice the id changed and
 * reset things by hand.
 */
function NodeHoverCard({ hover, onOpenNotes, onCategoryChange }: NodeHoverCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [context, setContext] = useState<TabPeekContext | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setExpanded(true)
      setContext(computeTabPeekContext(hover.node.tab))
    }, PEEK_DELAY_MS)
    return () => clearTimeout(timer)
    // Deliberately only depends on mount (this component remounts fresh via
    // `key` whenever the hovered node changes) — re-running on every
    // `hover` update would restart the delay on each mousemove tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  const node: GraphNode = hover.node
  const category = (node.tab.category as CategoryId | undefined) ?? "other"
  const title = node.tab.title?.trim() || node.tab.domain

  if (!expanded) {
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

  const { left, top, origin } = clampPeekPosition(hover.screenX, hover.screenY)

  function handleMouseEnter() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  function handleMouseLeave() {
    closeTimer.current = setTimeout(() => setExpanded(false), PEEK_CLOSE_DELAY_MS)
  }

  return (
    <div
      className="fixed z-50 origin-(--peek-origin) overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0 zoom-in-95"
      style={{ left, top, "--peek-origin": origin } as CSSProperties}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <TabPeekContent
        tab={node.tab}
        context={context}
        onOpenNotes={onOpenNotes}
        onCategoryChange={onCategoryChange}
      />
    </div>
  )
}

/**
 * A lightweight hover tooltip positioned at the last known cursor point —
 * deliberately not tracking continuous physics motion frame-by-frame, since
 * a hover target barely moves once the layout has settled.
 *
 * After the cursor rests on the same node for PEEK_DELAY_MS, this escalates
 * into full Tab Peek — the same TabPeekContent every DOM tab row shows (see
 * TabPeekTrigger) — so the Graph gets the identical "what is this tab"
 * surface, just reached without a DOM anchor to hang a real popup off of.
 */
export function GraphNodeTooltip({
  hover,
  onOpenNotes,
  onCategoryChange,
}: {
  hover: HoverInfo | null
  /** Routes to the Graph's own full-page notes view (GraphNodeNotesView) rather than the inline popover editor — Graph's existing Notes entry point, reused as-is. */
  onOpenNotes?: (id: string) => void
  onCategoryChange?: (id: string, category: CategoryId) => void
}) {
  if (!hover) return null
  return <NodeHoverCard key={hover.node.id} hover={hover} onOpenNotes={onOpenNotes} onCategoryChange={onCategoryChange} />
}
