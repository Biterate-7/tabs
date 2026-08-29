"use client"

import { useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

export type DependencyIndicatorItem = { id: string; label: string }

export type DependencyIndicatorData = {
  dependencies: DependencyIndicatorItem[]
  usedBy: DependencyIndicatorItem[]
}

const MAX_EXPANDED_ITEMS = 6

// A real double-click always fires two ordinary click events before the
// browser's dblclick event — without debouncing, a plain onClick/onDoubleClick
// pair on the same element fires the click action first every time, which
// here would select the tab (changing the search query, re-rendering the
// list) right before the intended double-click open ever gets a chance to
// register. Deferring the click action lets a following dblclick cancel it.
const CLICK_DEBOUNCE_MS = 220

function DependencyItemRow({
  item,
  direction,
  onSelect,
  onOpen,
}: {
  item: DependencyIndicatorItem
  direction: "down" | "up"
  onSelect?: (id: string) => void
  onOpen?: (id: string) => void
}) {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (clickTimer.current) clearTimeout(clickTimer.current)
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null
          onSelect?.(item.id)
        }, CLICK_DEBOUNCE_MS)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (clickTimer.current) {
          clearTimeout(clickTimer.current)
          clickTimer.current = null
        }
        onOpen?.(item.id)
      }}
      title="Click to find this tab · Double-click to open it"
      className="flex w-full min-w-0 items-center gap-1 text-left text-meta text-tertiary transition-colors duration-(--duration-fast) hover:text-foreground hover:underline"
    >
      <span aria-hidden>{direction === "down" ? "↓" : "↑"}</span>
      <span className="truncate">{item.label}</span>
    </button>
  )
}

/**
 * Compact "↓ N dependencies · ↑ M used by" line shown under a tab in search
 * results (see workspace-view.tsx's dependencyIndicators map). Stays a
 * single small line by default — the per-item list only renders once the
 * user clicks to expand it, so a tab with many dependencies never makes the
 * result list noticeably taller on its own.
 */
export function TabDependencyIndicator({
  data,
  onSelect,
  onOpen,
}: {
  data: DependencyIndicatorData
  onSelect?: (id: string) => void
  onOpen?: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { dependencies, usedBy } = data
  if (dependencies.length === 0 && usedBy.length === 0) return null

  const items = [
    ...dependencies.map((item) => ({ ...item, direction: "down" as const })),
    ...usedBy.map((item) => ({ ...item, direction: "up" as const })),
  ]
  const visible = items.slice(0, MAX_EXPANDED_ITEMS)
  const hiddenCount = items.length - visible.length

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setExpanded((v) => !v)
        }}
        aria-expanded={expanded}
        className="flex items-center gap-1 text-meta text-tertiary transition-colors duration-(--duration-fast) hover:text-foreground"
      >
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        {dependencies.length > 0 && (
          <span>
            ↓ {dependencies.length} dependenc{dependencies.length === 1 ? "y" : "ies"}
          </span>
        )}
        {dependencies.length > 0 && usedBy.length > 0 && <span aria-hidden>·</span>}
        {usedBy.length > 0 && <span>↑ {usedBy.length} used by</span>}
      </button>

      {expanded && (
        <ul className="mt-0.5 space-y-0.5 border-l border-subtle pl-2">
          {visible.map((item) => (
            <li key={`${item.direction}-${item.id}`} className="min-w-0">
              <DependencyItemRow item={item} direction={item.direction} onSelect={onSelect} onOpen={onOpen} />
            </li>
          ))}
          {hiddenCount > 0 && <li className="text-meta text-tertiary">+{hiddenCount} more</li>}
        </ul>
      )}
    </div>
  )
}
