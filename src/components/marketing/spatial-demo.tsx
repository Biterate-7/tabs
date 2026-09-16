"use client"

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { Undo2 } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { DEMO_UNIQUE_TABS, hashUnit, roundLayout, type DemoTab } from "./data"
import { useReducedMotion } from "./hooks"
import { DemoFavicon, DemoWindow, MButton } from "./primitives"

/**
 * The spatial section: sections as places, and tabs as things that live in one.
 *
 * Deliberately NOT a node graph. Hubs joined to leaves by edges is the shape
 * every "knowledge tool" diagram reaches for, and it says the wrong thing
 * here — a spoke means "is connected to", when TabDump's claim is "is *in*".
 * So a section is drawn as a region with area, a tab is an object sitting
 * inside one, and membership is decided by nothing more than where the object
 * is. Drag a tab across a boundary and it genuinely changes section: the
 * colour of its spine, the counts on both regions, and the line in the status
 * bar all follow from its coordinates.
 *
 * That is the argument for spatial organisation made operable in one gesture,
 * which no amount of copy beside a node graph would achieve.
 *
 * Coordinates are percentages of the canvas, never pixels, so a layout
 * survives the responsive height change between breakpoints with no
 * re-measurement — and the positions the server renders are the ones the
 * client keeps.
 */

type Point = { x: number; y: number }

/** A section, as an area of the canvas. Percentages, inclusive. */
type Region = {
  id: string
  name: string
  /** The corpus section this region stands for, and the source of its accent. */
  section: string
  category: DemoTab["category"]
  x1: number
  y1: number
  x2: number
  y2: number
}

const REGIONS: Region[] = [
  { id: "research", name: "Research", section: "Research", category: "research", x1: 2, y1: 10, x2: 46, y2: 58 },
  {
    id: "development",
    name: "Development",
    section: "Development",
    category: "projects",
    x1: 53,
    y1: 4,
    x2: 98,
    y2: 52,
  },
  { id: "personal", name: "Personal", section: "Personal", category: "read-later", x1: 15, y1: 62, x2: 85, y2: 98 },
]

/**
 * Six tabs per region. Five left the regions measurably under-filled once the
 * page's container widened — 52–60% of each region's height — and a room with
 * a few things floating in the middle of it undercuts the only claim this demo
 * makes, which is that these are places tabs *live* in.
 */
const NODES: DemoTab[] = REGIONS.flatMap((r) =>
  DEMO_UNIQUE_TABS.filter((t) => t.section === r.section).slice(0, 6)
)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const regionById = (id: string | null) => REGIONS.find((r) => r.id === id)

/** The region a point falls in, or null for the open ground between them. */
function regionAt(p: Point): string | null {
  for (const r of REGIONS) {
    if (p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2) return r.id
  }
  return null
}

/**
 * Home positions: each tab scattered inside its own region, inset from the
 * edges so a card never straddles a boundary at rest and leaves its
 * membership looking ambiguous before the visitor has touched anything.
 */
function homeLayout(): Record<string, Point> {
  const out: Record<string, Point> = {}
  for (const region of REGIONS) {
    const members = DEMO_UNIQUE_TABS.filter((t) => t.section === region.section).slice(0, 6)
    const rw = region.x2 - region.x1
    const rh = region.y2 - region.y1
    // Column count follows the region's shape. A wide, short region packed
    // into two columns stacks its rows on top of each other; a tall narrow one
    // spread over three runs its cards off the sides.
    const cols = rw / rh > 1.6 ? 3 : 2
    const rows = Math.ceil(members.length / cols)
    // All three are percentages of the *canvas*, not of the region, so they
    // have to be sized against the canvas rather than picked to look right in
    // the region. padX is small because a card is ~150px and a column has to
    // be wider than that or neighbours overlap.
    const padX = 4
    // padTop reserves a band for the region name, which rows now start
    // immediately below rather than half a row into. It has to clear the label
    // (~26px) plus half a card (~14px) on the ~430px canvas this renders at,
    // and the label is proportionally widest on a phone — where a first-row
    // card would otherwise sit right under "Development". Measured until
    // labelCovered was 0 at 1440, 1024, 768 and 390.
    const padTop = 15
    const padBottom = 6
    const w = rw - padX * 2
    const h = rh - padTop - padBottom
    members.forEach((tab, i) => {
      const a = hashUnit(tab.id, 11)
      const b = hashUnit(tab.id, 12)
      // Loose rows, jittered — "put down roughly here" rather than a grid.
      const col = i % cols
      const row = Math.floor(i / cols)
      // The last row is usually short; centring it stops a lone trailing card
      // from hanging off one side of the region.
      const inRow = Math.min(cols, members.length - row * cols)
      const rowOffset = (cols - inRow) / 2
      // Rows span the usable band edge to edge (row / rows-1) rather than
      // sitting in its middle (row+0.5 / rows). The centred form wastes a
      // whole row's worth of height — with three rows it used 2/3 of the band
      // and left the region looking half empty.
      const rowT = rows > 1 ? row / (rows - 1) : 0.5
      out[tab.id] = {
        // Jitter stays under half a column so it never collides a neighbour.
        x: roundLayout(region.x1 + padX + ((col + rowOffset + 0.5) / cols) * w + (a - 0.5) * 2.5),
        y: roundLayout(region.y1 + padTop + rowT * h + (b - 0.5) * 3),
      }
    })
  }
  return out
}

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

  /** Live membership, derived from position — never stored. */
  const memberOf = (id: string) => regionAt(positions[id])
  const countIn = (regionId: string) => NODES.filter((t) => memberOf(t.id) === regionId).length

  const activeTab = active ? NODES.find((t) => t.id === active) : undefined
  // While dragging, the region under the card; otherwise the hovered card's.
  const litRegion = dragging ? memberOf(dragging) : active ? memberOf(active) : null

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
      setPositions((prev) => ({ ...prev, [id]: { x: clamp(x, 5, 95), y: clamp(y, 7, 95) } }))
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
      [id]: { x: clamp(prev[id].x + dx, 5, 95), y: clamp(prev[id].y + dy, 7, 95) },
    }))
  }, [])

  function reset() {
    setPositions(homeLayout())
    setMoved(false)
  }

  return (
    <DemoWindow
      title="Thesis — spatial view"
      label="Interactive demonstration: moving a tab between sections by dragging it across the canvas"
      toolbar={<span className="m-num text-[0.6875rem] text-tertiary">{REGIONS.length} sections</span>}
    >
      <div
        ref={canvasRef}
        className="relative aspect-[4/5] w-full touch-pan-y select-none overflow-hidden sm:aspect-[16/9]"
        // A size container, so each card's percentage coordinates resolve to
        // cqw/cqh inside its own transform.
        style={{ containerType: "size" }}
        onPointerLeave={() => !dragging && setActive(null)}
      >
        <div aria-hidden className="m-grid absolute inset-0 opacity-25" />

        {/* Regions — areas, not nodes. Each lights while a card sits in it or
            is dragged over it, which is what makes the boundary feel real. */}
        {REGIONS.map((region) => {
          const accent = `var(${CATEGORIES[region.category].accentColor})`
          const lit = litRegion === region.id
          return (
            <div
              key={region.id}
              aria-hidden
              className="pointer-events-none absolute rounded-2xl transition-[background-color,border-color] duration-(--duration-slow) ease-(--ease-standard)"
              style={{
                left: `${region.x1}%`,
                top: `${region.y1}%`,
                width: `${region.x2 - region.x1}%`,
                height: `${region.y2 - region.y1}%`,
                border: `1px solid color-mix(in oklch, ${accent}, transparent ${lit ? 60 : 86}%)`,
                background: `color-mix(in oklch, ${accent}, transparent ${lit ? 92 : 97}%)`,
              }}
            >
              <span className="absolute top-2.5 left-3 flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: accent }} />
                <span
                  className="text-[0.6875rem] font-medium transition-colors duration-(--duration-base)"
                  style={{ color: lit ? "var(--foreground)" : "var(--text-tertiary)" }}
                >
                  {region.name}
                </span>
                <span className="m-num text-[0.6875rem] text-tertiary">{countIn(region.id)}</span>
              </span>
            </div>
          )
        })}

        {/* Cards */}
        {NODES.map((tab) => {
          const p = positions[tab.id]
          const isDragging = dragging === tab.id
          const home = memberOf(tab.id)
          const region = regionById(home)
          // A card outside every region has no section — drawn grey, which is
          // what makes the boundaries legible without drawing them harder.
          const accent = region ? `var(${CATEGORIES[region.category].accentColor})` : "var(--text-disabled)"
          const dim = litRegion != null && home !== litRegion && !isDragging
          return (
            <button
              key={tab.id}
              type="button"
              aria-label={`${tab.title} — in ${region?.name ?? "no section"}. Drag it into another section, or use the arrow keys.`}
              onPointerDown={(e) => onPointerDown(e, tab.id)}
              onPointerMove={(e) => onPointerMove(e, tab.id)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerEnter={() => !dragging && setActive(tab.id)}
              onFocus={() => setActive(tab.id)}
              onBlur={() => setActive((cur) => (cur === tab.id ? null : cur))}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 8 : 3
                if (e.key === "ArrowLeft") nudge(tab.id, -step, 0)
                else if (e.key === "ArrowRight") nudge(tab.id, step, 0)
                else if (e.key === "ArrowUp") nudge(tab.id, 0, -step)
                else if (e.key === "ArrowDown") nudge(tab.id, 0, step)
                else return
                e.preventDefault()
              }}
              className={cn(
                "absolute flex max-w-[9rem] items-center gap-1.5 rounded-lg border bg-card p-1.5 text-left lg:px-2",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                isDragging ? "cursor-grabbing border-strong" : "cursor-grab border-subtle hover:border-strong"
              )}
              style={{
                left: 0,
                top: 0,
                // Position is a transform, not left/top: a drag must never
                // write a layout property per frame.
                transform: `translate3d(calc(${p.x} * 1cqw - 50%), calc(${p.y} * 1cqh - 50%), 0) scale(${
                  isDragging ? 1.07 : 1
                })`,
                opacity: dim ? 0.34 : 1,
                zIndex: isDragging ? 30 : active === tab.id ? 20 : 10,
                boxShadow: isDragging ? "0 20px 44px -18px rgba(0,0,0,0.95)" : "0 4px 14px -8px rgba(0,0,0,0.8)",
                // touch-action on the card itself only: the page still scrolls
                // when a finger starts on empty canvas.
                touchAction: "none",
                // While dragging, the card must track the pointer exactly, so
                // transform gets no transition.
                transition:
                  isDragging || reduced
                    ? "opacity 180ms var(--m-ease)"
                    : "transform 460ms var(--m-spring), opacity 200ms var(--m-ease), border-color 140ms var(--m-ease)",
              }}
            >
              <span
                aria-hidden
                className="h-4 w-0.5 shrink-0 rounded-full transition-colors duration-(--duration-slow) ease-(--ease-standard)"
                style={{ backgroundColor: accent }}
              />
              <DemoFavicon domain={tab.domain} size={14} />
              {/* Label only from `lg` up. A 140px card on a 340px canvas cannot
                  avoid its neighbours whatever the layout does, so on a phone
                  the cards shrink to favicons and the status bar below names
                  whichever one you are touching. */}
              <span className="hidden min-w-0 truncate text-[0.6875rem] leading-4 text-muted-foreground lg:block">
                {tab.title}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-subtle px-3.5 py-3">
        <MButton variant="secondary" onClick={reset} disabled={!moved}>
          <Undo2 />
          Put them back
        </MButton>
        {/* Reads out the consequence of the gesture, not the gesture itself. */}
        <p className="min-w-0 flex-1 truncate text-body-sm text-tertiary" aria-live="polite">
          {activeTab ? (
            <>
              <span className="text-foreground">{activeTab.title}</span>
              <span> is in </span>
              <span className="text-foreground">{regionById(memberOf(activeTab.id))?.name ?? "no section"}</span>
            </>
          ) : moved ? (
            "Membership follows position. TabDump keeps the layout you built."
          ) : (
            "Drag a tab into another section."
          )}
        </p>
      </div>
    </DemoWindow>
  )
}
