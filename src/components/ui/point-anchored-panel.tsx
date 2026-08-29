"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"

export type AnchorPoint = { x: number; y: number }

/**
 * Positions a panel at an arbitrary screen point (a canvas-space right-click
 * or edge click has no real DOM element to anchor a base-ui Popover/Menu to
 * — see graph-context-menu.tsx and graph-edge-popover.tsx, the two
 * call sites this was extracted from) and handles the viewport clamp plus
 * outside-click/Escape-to-close that both of those previously duplicated.
 */
export function usePointAnchoredPanel(point: AnchorPoint | null, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<{ left: number; top: number } | null>(null)

  // Reset the computed position (and let callers reset their own transient
  // UI, e.g. an open submenu) during render when a different point comes in,
  // rather than in an effect — an effect would cause an extra visible render
  // at the previous position before snapping to the new one.
  const [trackedPoint, setTrackedPoint] = useState(point)
  if (point !== trackedPoint) {
    setTrackedPoint(point)
    setStyle(null)
  }

  useLayoutEffect(() => {
    if (!point || !panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    const left = Math.min(point.x, window.innerWidth - rect.width - 8)
    const top = Math.min(point.y, window.innerHeight - rect.height - 8)
    setStyle({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [point])

  useEffect(() => {
    if (!point) return
    function handlePointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [point, onClose])

  return {
    panelRef,
    /** Spread onto the panel's root element's `style` prop. Stays at the raw point (with `visibility: hidden`) for the one frame before the clamp has been measured, then snaps to the clamped position. */
    style: { left: style?.left ?? point?.x ?? 0, top: style?.top ?? point?.y ?? 0, visibility: style ? ("visible" as const) : ("hidden" as const) },
  }
}
