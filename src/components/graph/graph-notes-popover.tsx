"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { NotesEditorFields } from "@/components/workspace/notes-editor-fields"
import type { GraphNode } from "@/lib/graph/types"

export type GraphNotesAnchor = { x: number; y: number; radius: number }

/**
 * Obsidian-style node-anchored notes editor for the Graph view. Reuses
 * NotesEditorFields (extracted from TabNotesButton) for the actual editing
 * UI and writes through the same onNotesChange callback GraphView already
 * uses for tab removal/dependency mutations — tab.notes stays the single
 * source of truth, this is just another entry point to it.
 *
 * Unlike GraphContextMenu/GraphEdgePopover (which anchor once to the
 * clientX/Y of the click that opened them and never move again), this
 * popover must keep tracking its node's screen position while pan/zoom/drag
 * or physics settling moves it — so instead of a static point it takes
 * `getAnchor`, polled every frame via requestAnimationFrame, and positions
 * itself with an imperative style write (not React state) to avoid a
 * re-render on every tick.
 */
export function GraphNotesPopover({
  tabId,
  node,
  getAnchor,
  onNotesChange,
  onClose,
}: {
  tabId: string | null
  node: GraphNode | null
  getAnchor: (tabId: string) => GraphNotesAnchor | null
  onNotesChange: (id: string, notes: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const lastPosRef = useRef<{ left: number; top: number } | null>(null)

  const [draft, setDraft] = useState(node?.tab.notes ?? "")
  const [visible, setVisible] = useState(false)
  // Mirrors `draft` for the pointerup/keydown listeners below, which are
  // only re-subscribed when `tabId` changes (not on every keystroke) — kept
  // in sync via effect rather than a during-render write, since refs can't
  // be mutated during render.
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  // Reset the draft (and hide until repositioned) whenever the target tab
  // changes — same "adjust state during render" reset GraphContextMenu uses
  // for its own tracked-state, so switching nodes never flashes the
  // previous node's text before snapping to the new one.
  const [trackedTabId, setTrackedTabId] = useState(tabId)
  if (tabId !== trackedTabId) {
    setTrackedTabId(tabId)
    setDraft(node?.tab.notes ?? "")
    setVisible(false)
  }

  function commit() {
    if (!tabId) return
    const trimmed = draftRef.current.trim()
    if (trimmed !== (node?.tab.notes ?? "")) onNotesChange(tabId, trimmed)
  }

  function handleClose() {
    commit()
    onClose()
  }

  /** Clamped, radius-aware placement next to `anchor` — flips to the node's left when there isn't room on the right, and never lets the panel drift off any viewport edge. Returns false when nothing needed to change (used to skip redundant style writes on every animation frame). */
  function applyPosition(panel: HTMLDivElement, anchor: GraphNotesAnchor): boolean {
    const rect = panel.getBoundingClientRect()
    const GAP = 14
    const MARGIN = 8
    const fitsRight = anchor.x + anchor.radius + GAP + rect.width + MARGIN <= window.innerWidth
    const rawLeft = fitsRight ? anchor.x + anchor.radius + GAP : anchor.x - anchor.radius - GAP - rect.width
    const rawTop = anchor.y - rect.height / 2

    const left = Math.min(Math.max(MARGIN, rawLeft), Math.max(MARGIN, window.innerWidth - rect.width - MARGIN))
    const top = Math.min(Math.max(MARGIN, rawTop), Math.max(MARGIN, window.innerHeight - rect.height - MARGIN))

    const last = lastPosRef.current
    if (last && last.left === left && last.top === top) return false
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    lastPosRef.current = { left, top }
    return true
  }

  // Position synchronously before paint, exactly like usePointAnchoredPanel's
  // useLayoutEffect — this is what lets the panel become visible in the same
  // commit it mounts in, instead of only after a requestAnimationFrame delay
  // (which would otherwise leave it `visibility: hidden`, and so invisible to
  // accessibility-tree-based queries like getByRole, for a whole frame).
  useLayoutEffect(() => {
    if (!tabId) return
    const panel = panelRef.current
    const anchor = getAnchor(tabId)
    if (!panel || !anchor) return
    applyPosition(panel, anchor)
    setVisible(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // Per-frame anchor tracking thereafter, so pan/zoom/drag/physics settling
  // keep the panel glued to its node — see the module doc comment above.
  useEffect(() => {
    if (!tabId) return
    function frame() {
      const panel = panelRef.current
      const anchor = tabId ? getAnchor(tabId) : null
      if (!panel || !anchor) {
        setVisible(false)
      } else {
        applyPosition(panel, anchor)
        setVisible(true)
      }
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [tabId, getAnchor])

  // Outside click / Escape closes, matching every other graph popover (see
  // usePointAnchoredPanel) — committing first so a dismissed edit isn't
  // silently lost. A genuine outside *click* is distinguished from a canvas
  // pan/drag (which also starts with a pointerdown outside the panel) by
  // requiring the pointerup to land within CLICK_DRAG_THRESHOLD of the
  // pointerdown — the same distance graph-canvas.tsx uses to tell its own
  // clicks from drags. Without this, grabbing empty canvas to pan away from
  // the node would close the popover before the drag even started.
  useEffect(() => {
    if (!tabId) return
    let downPoint: { x: number; y: number } | null = null
    function handlePointerDown(e: PointerEvent) {
      downPoint = panelRef.current?.contains(e.target as Node) ? null : { x: e.clientX, y: e.clientY }
    }
    function handlePointerUp(e: PointerEvent) {
      if (!downPoint) return
      const moved = Math.hypot(e.clientX - downPoint.x, e.clientY - downPoint.y)
      downPoint = null
      if (moved <= 4) handleClose()
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose()
    }
    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("pointerup", handlePointerUp)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("pointerup", handlePointerUp)
      window.removeEventListener("keydown", handleKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  if (!tabId || !node) return null

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Note"
      className="fixed z-50 w-72 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ visibility: visible ? "visible" : "hidden" }}
    >
      <NotesEditorFields
        id={`graph-notes-${tabId}`}
        value={draft}
        onChange={setDraft}
        onDone={handleClose}
        placeholder={`Add a note for ${node.tab.domain}…`}
      />
    </div>
  )
}
