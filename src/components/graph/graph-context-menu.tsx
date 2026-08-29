"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Copy, ExternalLink, FolderInput, Link2, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { GraphNode } from "@/lib/graph/types"

export type GraphContextMenuState = { node: GraphNode; x: number; y: number }

const ITEM_CLASS =
  "flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"

/**
 * A self-contained fixed-position menu (not base-ui's Menu) because there is
 * no real DOM trigger element at the right-click point to anchor to — nodes
 * are canvas pixels, not DOM nodes. Styled to match DropdownMenuContent for
 * visual consistency with the rest of the app.
 */
export function GraphContextMenu({
  state,
  otherWorkspaces,
  onOpenTab,
  onOpenNewTab,
  onCopyUrl,
  onCopyCleanUrl,
  onMoveToWorkspace,
  onLinkTo,
  onRemove,
  onClose,
}: {
  state: GraphContextMenuState | null
  otherWorkspaces: { id: string; name: string }[]
  onOpenTab: () => void
  onOpenNewTab: () => void
  onCopyUrl: () => void
  onCopyCleanUrl: () => void
  onMoveToWorkspace: (workspaceId: string) => void
  onLinkTo: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [style, setStyle] = useState<{ left: number; top: number } | null>(null)

  // Reset transient UI (submenu open, computed position) whenever a
  // different menu invocation comes in — done during render, per React's
  // "adjusting state when a prop changes" pattern, rather than in an effect
  // (which would cause an extra visible render at the previous position).
  const [trackedState, setTrackedState] = useState(state)
  if (state !== trackedState) {
    setTrackedState(state)
    setMoveOpen(false)
    setStyle(null)
  }

  useLayoutEffect(() => {
    if (!state || !panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    const left = Math.min(state.x, window.innerWidth - rect.width - 8)
    const top = Math.min(state.y, window.innerHeight - rect.height - 8)
    setStyle({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [state])

  useEffect(() => {
    if (!state) return
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
  }, [state, onClose])

  if (!state) return null

  return (
    <div
      ref={panelRef}
      role="menu"
      className="fixed z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left: style?.left ?? state.x, top: style?.top ?? state.y, visibility: style ? "visible" : "hidden" }}
    >
      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={onOpenTab}>
        <ExternalLink /> Open tab
      </button>
      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={onOpenNewTab}>
        <ExternalLink /> Open in new tab
      </button>
      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={onCopyUrl}>
        <Copy /> Copy URL
      </button>
      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={onCopyCleanUrl}>
        <Copy /> Copy clean URL
      </button>

      {otherWorkspaces.length > 0 && (
        <div className="relative">
          <button
            type="button"
            role="menuitem"
            className={cn(ITEM_CLASS, moveOpen && "bg-accent text-accent-foreground")}
            onClick={() => setMoveOpen((v) => !v)}
          >
            <FolderInput /> Move to workspace
          </button>
          {moveOpen && (
            <div className="absolute top-0 left-full ml-1 min-w-40 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              {otherWorkspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="menuitem"
                  className={ITEM_CLASS}
                  onClick={() => onMoveToWorkspace(w.id)}
                >
                  {w.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={onLinkTo}>
        <Link2 /> Link to…
      </button>

      <div className="-mx-1 my-1 h-px bg-border" />

      <button
        type="button"
        role="menuitem"
        className={cn(ITEM_CLASS, "text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20 [&_svg]:text-destructive")}
        onClick={onRemove}
      >
        <Trash2 /> Remove from workspace
      </button>
    </div>
  )
}
