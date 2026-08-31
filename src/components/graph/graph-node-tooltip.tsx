"use client"

import { useEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react"
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

/**
 * A lightweight hover tooltip positioned at the last known cursor point —
 * deliberately not tracking continuous physics motion frame-by-frame, since
 * a hover target barely moves once the layout has settled.
 *
 * After the cursor rests on the same node for PEEK_DELAY_MS, this escalates
 * into full Tab Peek — the same TabPeekContent every DOM tab row shows (see
 * TabPeekTrigger) — so the Graph gets the identical "what is this tab"
 * surface, just reached without a DOM anchor to hang a real popup off of.
 *
 * The escalated card floats in a `position: fixed` div stacked above the
 * canvas, which means the canvas's own `pointerleave` fires the instant the
 * cursor crosses onto the card — the canvas is no longer the topmost element
 * under the pointer, even though it's still visually behind it. Naively
 * tying the card's mounted lifetime to `hover` becoming null would make it
 * vanish the moment the user tries to move into it. Instead `pinned` (the
 * node the card is currently showing) is only updated to null once neither
 * the canvas-reported hover, the card's own pointer presence, nor focus
 * inside it have been true for PEEK_CLOSE_DELAY_MS — tracked via refs so the
 * close timer always reads live state rather than a stale closure.
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
  const [pinned, setPinned] = useState<HoverInfo | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [context, setContext] = useState<TabPeekContext | null>(null)

  const triggerHoveredRef = useRef(false)
  const cardHoveredRef = useRef(false)
  const cardFocusedRef = useRef(false)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cancelClose() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  function scheduleClose() {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      if (triggerHoveredRef.current || cardHoveredRef.current || cardFocusedRef.current) return
      setPinned(null)
      setExpanded(false)
      setContext(null)
    }, PEEK_CLOSE_DELAY_MS)
  }

  useEffect(() => {
    triggerHoveredRef.current = hover !== null

    if (hover) {
      cancelClose()
      setPinned((prev) => {
        if (prev?.node.id === hover.node.id) return hover
        // Retargeted to a different node — restart the open-delay escalation
        // from scratch rather than keeping the previous node's expanded card.
        if (openTimerRef.current) clearTimeout(openTimerRef.current)
        setExpanded(false)
        setContext(null)
        openTimerRef.current = setTimeout(() => {
          openTimerRef.current = null
          setExpanded(true)
          setContext(computeTabPeekContext(hover.node.tab))
        }, PEEK_DELAY_MS)
        return hover
      })
      return
    }

    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    scheduleClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover])

  useEffect(
    () => () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    []
  )

  if (!pinned) return null

  const node: GraphNode = pinned.node
  const category = (node.tab.category as CategoryId | undefined) ?? "other"
  const title = node.tab.title?.trim() || node.tab.domain

  if (!expanded) {
    return (
      <div
        className="pointer-events-none fixed z-50 max-w-64 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-md bg-popover px-2.5 py-1.5 text-label text-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: pinned.screenX, top: pinned.screenY }}
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

  const { left, top, origin } = clampPeekPosition(pinned.screenX, pinned.screenY)

  function handleCardPointerEnter() {
    cardHoveredRef.current = true
    cancelClose()
  }

  function handleCardPointerLeave() {
    cardHoveredRef.current = false
    scheduleClose()
  }

  function handleCardFocus() {
    cardFocusedRef.current = true
    cancelClose()
  }

  function handleCardBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    cardFocusedRef.current = false
    scheduleClose()
  }

  return (
    <div
      className="fixed z-50 origin-(--peek-origin) overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0 zoom-in-95"
      style={{ left, top, "--peek-origin": origin } as CSSProperties}
      onPointerEnter={handleCardPointerEnter}
      onPointerLeave={handleCardPointerLeave}
      onFocus={handleCardFocus}
      onBlur={handleCardBlur}
    >
      <TabPeekContent tab={node.tab} context={context} onOpenNotes={onOpenNotes} onCategoryChange={onCategoryChange} />
    </div>
  )
}
