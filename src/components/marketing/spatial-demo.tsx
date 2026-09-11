"use client"

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { Sparkles } from "lucide-react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { DEMO_UNIQUE_TABS, hashUnit } from "./data"
import { useReducedMotion } from "./hooks"
import { DemoWindow, MButton } from "./primitives"

/**
 * The spatial section: tabs as objects you can actually pick up.
 *
 * This one has to be really draggable — a canvas that only *looks* spatial
 * would undercut the claim it exists to make. So every node is a real pointer
 * target with pointer capture, keyboard nudging, and a "tidy up" that springs
 * the field back to its computed home layout.
 *
 * Coordinates are percentages of the canvas, never pixels. That is what lets
 * the same saved layout survive a resize (and the responsive height change
 * between breakpoints) without any re-measurement, and it means the node
 * positions the server renders are the ones the client keeps.
 *
 * Cost control: positions live in one state object and are applied as a
 * transform on each node, so a drag repaints one composited layer; the edge
 * layer is a single SVG whose lines are recomputed from the same numbers.
 */

type Point = { x: number; y: number }

type Cluster = {
  name: string
  category: (typeof DEMO_UNIQUE_TABS)[number]["category"]
  hub: Point
  tabs: typeof DEMO_UNIQUE_TABS
}

const CLUSTER_SPEC: { section: string; label: string; hub: Point }[] = [
  { section: "Research", label: "Research", hub: { x: 24, y: 30 } },
  { section: "Development", label: "Development", hub: { x: 74, y: 32 } },
  { section: "Personal", label: "Personal", hub: { x: 48, y: 76 } },
]

const CLUSTERS: Cluster[] = CLUSTER_SPEC.map((spec) => {
  const tabs = DEMO_UNIQUE_TABS.filter((t) => t.section === spec.section).slice(0, 6)
  return {
    name: spec.label,
    category: tabs[0]?.category ?? "other",
    hub: spec.hub,
    tabs,
  }
})

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** A ring around each hub, with a per-node hash nudge so it never reads as a clock face. */
function homeLayout(): Record<string, Point> {
  const out: Record<string, Point> = {}
  for (const cluster of CLUSTERS) {
    cluster.tabs.forEach((tab, i) => {
      const angle = (i / cluster.tabs.length) * Math.PI * 2 + hashUnit(tab.id, 11) * 0.9
      // Wide enough that six ~140px cards around one hub do not sit on top of
      // each other on a ~1100px canvas, tight enough that the three clusters
      // still read as three.
      const radius = 17 + hashUnit(tab.id, 12) * 8
      // Clamped to the same bounds a drag respects, so a node whose ring
      // would put it past the canvas edge starts inside it instead.
      out[tab.id] = {
        x: clamp(cluster.hub.x + Math.cos(angle) * radius, 9, 91),
        y: clamp(cluster.hub.y + Math.sin(angle) * radius * 0.72, 9, 91),
      }
    })
  }
  return out
}

const CLUSTER_OF = new Map<string, string>(
  CLUSTERS.flatMap((c) => c.tabs.map((t) => [t.id, c.name] as const))
)

export function SpatialDemo() {
  const [positions, setPositions] = useState<Record<string, Point>>(homeLayout)
  const [active, setActive] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [moved, setMoved] = useState(false)
  const reduced = useReducedMotion()

  const canvasRef = useRef<HTMLDivElement | null>(null)
  // Captured once per drag: reading the rect on every pointermove would force
  // a layout on each frame of the very interaction that must stay smooth.
  const dragRef = useRef<{ rect: DOMRect; dx: number; dy: number } | null>(null)

  const highlighted = active ? CLUSTER_OF.get(active) : null
  const activeTab = active ? DEMO_UNIQUE_TABS.find((t) => t.id === active) : undefined

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const pos = positions[id]
      dragRef.current = {
        rect,
        dx: ((e.clientX - rect.left) / rect.width) * 100 - pos.x,
        dy: ((e.clientY - rect.top) / rect.height) * 100 - pos.y,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(id)
      setActive(id)
    },
    [positions]
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
      const drag = dragRef.current
      if (!drag || dragging !== id) return
      const x = ((e.clientX - drag.rect.left) / drag.rect.width) * 100 - drag.dx
      const y = ((e.clientY - drag.rect.top) / drag.rect.height) * 100 - drag.dy
      setMoved(true)
      setPositions((prev) => ({ ...prev, [id]: { x: clamp(x, 6, 94), y: clamp(y, 8, 92) } }))
    },
    [dragging]
  )

  const endDrag = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    dragRef.current = null
    setDragging(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const nudge = useCallback((id: string, dx: number, dy: number) => {
    setMoved(true)
    setPositions((prev) => ({
      ...prev,
      [id]: { x: clamp(prev[id].x + dx, 6, 94), y: clamp(prev[id].y + dy, 8, 92) },
    }))
  }, [])

  function tidy() {
    setPositions(homeLayout())
    setMoved(false)
  }

  return (
    <DemoWindow
      title="Thesis — spatial view"
      label="Interactive demonstration: a spatial canvas of tabs you can drag"
      toolbar={<span className="m-num text-[0.6875rem] text-tertiary">{CLUSTERS.length} clusters</span>}
    >
      <div
        ref={canvasRef}
        className="relative aspect-[4/5] w-full touch-pan-y select-none overflow-hidden sm:aspect-[16/9]"
        // A size container, so each node's percentage coordinates resolve to
        // cqw/cqh inside its own transform.
        style={{ containerType: "size" }}
        onPointerLeave={() => !dragging && setActive(null)}
      >
        <div aria-hidden className="m-grid absolute inset-0 opacity-30" />

        {/* Edges. One SVG for the whole field — a line per node, drawn from
            its cluster hub, so the structure stays legible however far a node
            is dragged from home. */}
        <svg
          aria-hidden
          className="absolute inset-0 size-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {CLUSTERS.map((cluster) =>
            cluster.tabs.map((tab) => {
              const p = positions[tab.id]
              const lit = highlighted === cluster.name
              return (
                <line
                  key={tab.id}
                  x1={cluster.hub.x}
                  y1={cluster.hub.y}
                  x2={p.x}
                  y2={p.y}
                  stroke={`var(${CATEGORIES[cluster.category].accentColor})`}
                  // In device pixels, not user units: with
                  // vector-effect="non-scaling-stroke" the width is applied
                  // after the viewBox transform, so these are literal pixels
                  // — a value picked on the 0–100 user scale would round to
                  // nothing.
                  strokeWidth={lit ? 1.5 : 1}
                  // Keeps the hairline even under the non-uniform scale that
                  // preserveAspectRatio="none" applies.
                  vectorEffect="non-scaling-stroke"
                  opacity={highlighted ? (lit ? 0.7 : 0.07) : 0.3}
                  style={{ transition: "opacity 220ms var(--m-ease), stroke-width 220ms var(--m-ease)" }}
                />
              )
            })
          )}
        </svg>

        {/* Cluster hubs */}
        {CLUSTERS.map((cluster) => {
          const lit = highlighted === cluster.name
          return (
            <div
              key={cluster.name}
              aria-hidden
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${cluster.hub.x}%`, top: `${cluster.hub.y}%` }}
            >
              <span
                className="flex items-center gap-1.5 rounded-full border px-2 py-1 text-[0.6875rem] transition-[opacity,border-color,background-color] duration-(--duration-base) ease-(--ease-standard)"
                style={{
                  borderColor: lit
                    ? `color-mix(in oklch, var(${CATEGORIES[cluster.category].accentColor}), transparent 50%)`
                    : "var(--border)",
                  backgroundColor: "var(--background)",
                  opacity: highlighted && !lit ? 0.45 : 1,
                }}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: `var(${CATEGORIES[cluster.category].accentColor})` }}
                />
                <span className="text-muted-foreground">{cluster.name}</span>
                <span className="m-num text-tertiary">{cluster.tabs.length}</span>
              </span>
            </div>
          )
        })}

        {/* Nodes */}
        {CLUSTERS.map((cluster) =>
          cluster.tabs.map((tab) => {
            const p = positions[tab.id]
            const isDragging = dragging === tab.id
            const dim = highlighted != null && CLUSTER_OF.get(tab.id) !== highlighted
            return (
              <button
                key={tab.id}
                type="button"
                aria-label={`${tab.title} — ${cluster.name}. Drag to move, or use the arrow keys.`}
                onPointerDown={(e) => onPointerDown(e, tab.id)}
                onPointerMove={(e) => onPointerMove(e, tab.id)}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerEnter={() => !dragging && setActive(tab.id)}
                onFocus={() => setActive(tab.id)}
                onBlur={() => setActive((cur) => (cur === tab.id ? null : cur))}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 6 : 2
                  if (e.key === "ArrowLeft") nudge(tab.id, -step, 0)
                  else if (e.key === "ArrowRight") nudge(tab.id, step, 0)
                  else if (e.key === "ArrowUp") nudge(tab.id, 0, -step)
                  else if (e.key === "ArrowDown") nudge(tab.id, 0, step)
                  else return
                  e.preventDefault()
                }}
                className={cn(
                  "absolute flex max-w-[9rem] items-center gap-1.5 rounded-lg border bg-card p-1.5 text-left sm:px-2",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isDragging ? "cursor-grabbing border-strong" : "cursor-grab border-subtle hover:border-strong"
                )}
                style={{
                  left: 0,
                  top: 0,
                  // Position is a transform, not left/top: a drag must never
                  // write a layout property per frame. The canvas is a size
                  // container (see below), so the percentage coordinates can
                  // be resolved against it in cqw/cqh right here.
                  transform: `translate3d(calc(${p.x} * 1cqw - 50%), calc(${p.y} * 1cqh - 50%), 0) scale(${
                    isDragging ? 1.06 : 1
                  })`,
                  opacity: dim ? 0.3 : 1,
                  zIndex: isDragging ? 30 : active === tab.id ? 20 : 10,
                  boxShadow: isDragging ? "0 18px 40px -18px rgba(0,0,0,0.95)" : "none",
                  // touch-action on the node itself only: the page still
                  // scrolls when a finger starts on empty canvas.
                  touchAction: "none",
                  // While dragging, the node must track the pointer exactly —
                  // any transition on transform would make it lag behind.
                  transition:
                    isDragging || reduced
                      ? "opacity 200ms var(--m-ease)"
                      : "transform 520ms var(--m-spring), opacity 220ms var(--m-ease), border-color 160ms var(--m-ease)",
                }}
              >
                <span
                  aria-hidden
                  className="h-4 w-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: `var(${CATEGORIES[tab.category].accentColor})` }}
                />
                <TabFavicon domain={tab.domain} size={14} />
                {/* Label only from `sm` up. A 140px card on a 340px canvas
                    cannot avoid its neighbours whatever the layout does, so
                    on a phone the nodes shrink to favicons and the caption
                    bar below names whichever one you are touching. */}
                <span className="hidden min-w-0 truncate text-[0.6875rem] leading-4 text-muted-foreground sm:block">
                  {tab.title}
                </span>
              </button>
            )
          })
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-subtle px-3.5 py-3">
        <MButton variant="secondary" onClick={tidy} disabled={!moved}>
          <Sparkles />
          Tidy up
        </MButton>
        {/* Names the node under the pointer. On a phone the nodes are
            favicon-only, so this is the only place their titles appear —
            which makes it load-bearing there and a useful readout on
            desktop rather than a duplicate of the label. */}
        <p className="min-w-0 truncate text-body-sm text-tertiary" aria-live="polite">
          {activeTab ? (
            <>
              <span className="text-foreground">{activeTab.title}</span>
              <span className="text-tertiary"> · {activeTab.section} → {activeTab.subsection}</span>
            </>
          ) : moved ? (
            "Moved. TabDump keeps the layout you built."
          ) : (
            "Drag a tab anywhere."
          )}
        </p>
      </div>
    </DemoWindow>
  )
}
