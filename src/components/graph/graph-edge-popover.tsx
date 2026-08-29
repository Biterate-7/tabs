"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { DEPENDENCY_TYPES } from "@/lib/dependencies/types"
import type { EdgeReason, GraphDependencyEdge, GraphEdge, GraphNode } from "@/lib/graph/types"

export type GraphEdgePopoverState =
  | { kind: "relation"; edge: GraphEdge; source: GraphNode; target: GraphNode; x: number; y: number }
  | {
      kind: "dependency"
      edge: GraphDependencyEdge
      /** The dependency's parent (what depends on `target`). */
      source: GraphNode
      /** The dependency's child (the resource `source` depends on). */
      target: GraphNode
      /** Other relation reasons (domain/workspace/etc, including a manual link) that also connect this same pair, if any — AGENTS.md section 9: "If another relationship also exists... show all applicable reasons." */
      otherReasons: EdgeReason[]
      x: number
      y: number
    }

const REASON_LABEL: Record<EdgeReason, string> = {
  domain: "Same domain",
  workspace: "Same workspace",
  category: "Same category",
  group: "Same group",
  manual: "Manually linked",
}

function titleOf(node: GraphNode): string {
  return node.tab.title?.trim() || node.tab.domain
}

export function GraphEdgePopover({
  state,
  onClose,
  onRemoveManualLink,
  onRemoveDependency,
}: {
  state: GraphEdgePopoverState | null
  onClose: () => void
  onRemoveManualLink: () => void
  onRemoveDependency: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<{ left: number; top: number } | null>(null)

  // Reset the computed position during render when a different edge is
  // clicked, rather than in an effect (see graph-context-menu.tsx for why).
  const [trackedState, setTrackedState] = useState(state)
  if (state !== trackedState) {
    setTrackedState(state)
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

  const { source, target } = state
  const category = (source.tab.category as CategoryId | undefined) ?? "other"

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Why are these connected?"
      className="fixed z-50 w-72 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left: style?.left ?? state.x, top: style?.top ?? state.y, visibility: style ? "visible" : "hidden" }}
    >
      {state.kind === "dependency" ? (
        <>
          <p className="truncate text-body-sm font-medium text-foreground">
            {titleOf(source)} <span className="text-tertiary">──→</span> {titleOf(target)}
          </p>

          <p className="mt-2.5 text-label text-tertiary">CONNECTIONS</p>
          <ul className="mt-1 space-y-1">
            <li className="flex items-center gap-1.5 text-body-sm text-foreground">
              <Check className="size-3.5 text-success" /> Dependency
              {state.edge.type ? ` — ${DEPENDENCY_TYPES[state.edge.type].name}` : " — Untyped"}
            </li>
            {state.otherReasons.map((reason) => (
              <li key={reason} className="flex items-center gap-1.5 text-body-sm text-foreground">
                <Check className="size-3.5 text-success" /> {REASON_LABEL[reason]}
              </li>
            ))}
          </ul>

          <p className="mt-2.5 border-t border-subtle pt-2 text-body-sm text-muted-foreground">
            {titleOf(source)} depends on {titleOf(target)}
          </p>

          <button
            type="button"
            onClick={onRemoveDependency}
            className="mt-2.5 w-full rounded-md border-t border-subtle pt-2 text-left text-body-sm text-destructive hover:underline"
          >
            Remove dependency
          </button>
        </>
      ) : (
        <>
          <p className="truncate text-body-sm font-medium text-foreground">
            {titleOf(source)} <span className="text-tertiary">──</span> {titleOf(target)}
          </p>

          <p className="mt-2.5 text-label text-tertiary">CONNECTION</p>
          <ul className="mt-1 space-y-1">
            {state.edge.reasons.map((reason) => (
              <li key={reason} className="flex items-center gap-1.5 text-body-sm text-foreground">
                <Check className="size-3.5 text-success" /> {REASON_LABEL[reason]}
              </li>
            ))}
          </ul>

          {(state.edge.reasons.includes("workspace") ||
            state.edge.reasons.includes("category") ||
            state.edge.reasons.includes("domain")) && (
            <div className="mt-2.5 space-y-0.5 border-t border-subtle pt-2 text-body-sm text-muted-foreground">
              {state.edge.reasons.includes("workspace") && <p>Workspace: {source.workspaceName}</p>}
              {state.edge.reasons.includes("category") && <p>Category: {CATEGORIES[category].name}</p>}
              {state.edge.reasons.includes("domain") && <p>Domain: {source.tab.domain}</p>}
            </div>
          )}

          {state.edge.reasons.includes("manual") && (
            <button
              type="button"
              onClick={onRemoveManualLink}
              className="mt-2.5 w-full rounded-md border-t border-subtle pt-2 text-left text-body-sm text-destructive hover:underline"
            >
              Remove manual link
            </button>
          )}
        </>
      )}
    </div>
  )
}
