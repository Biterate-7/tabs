"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { DEMO_SECTIONS, DEMO_UNIQUE_TABS, hashUnit } from "./data"
import { useInView, useReducedMotion } from "./hooks"
import { DemoFavicon, DemoWindow, MButton } from "./primitives"

/**
 * "From chaos to structure": the same tabs, shown as the flat pile a browser
 * gives you and as the tree TabDump builds from it.
 *
 * The two states are separate renders that cross-dissolve rather than a FLIP
 * of one list into the other. That is a deliberate trade: a true positional
 * morph of ~30 rows means measuring every row twice per toggle and animating
 * them all individually, and the thing worth communicating here is not "row 12
 * travelled to row 4" — it is that structure *appeared*. So the pile leaves
 * with a quick staggered lift and the tree arrives with a staggered settle,
 * which reads as reorganization at a fraction of the cost.
 *
 * The tree that arrives is genuinely interactive: every branch opens and
 * closes, and the counts on it are computed from the corpus rather than typed
 * in, so they can never disagree with what is listed underneath.
 */

const PILE = DEMO_UNIQUE_TABS
  // A stable scramble: the pile has to look unsorted, and sorting by a hash
  // of the id gives the same "unsorted" order on the server and the client.
  .map((t) => ({ tab: t, k: hashUnit(t.id, 7) }))
  .sort((a, b) => a.k - b.k)
  .map((e) => e.tab)
  .slice(0, 10)

function PileRow({ tab, index }: { tab: (typeof PILE)[number]; index: number }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-subtle bg-card/60 px-2 py-1.5"
      style={{ animation: `m-settle-in 320ms var(--m-ease) ${index * 18}ms both` }}
    >
      {/* Grey spine, not the category color: in the pile nothing has been
          classified yet, and coloring it here would give away the payoff. */}
      <span aria-hidden className="h-4 w-0.5 shrink-0 rounded-full bg-white/12" />
      <DemoFavicon domain={tab.domain} size={14} />
      <span className="min-w-0 flex-1 truncate text-[0.75rem] leading-4 text-muted-foreground">{tab.title}</span>
      <span className="hidden shrink-0 truncate text-meta text-tertiary sm:block">{tab.domain}</span>
    </div>
  )
}

function Branch({
  section,
  index,
  open,
  onToggle,
}: {
  section: (typeof DEMO_SECTIONS)[number]
  index: number
  open: boolean
  onToggle: () => void
}) {
  const accent = `var(${CATEGORIES[section.category].accentColor})`
  const total = section.children.reduce((n, c) => n + c.count, 0)

  return (
    <div
      className="m-panel overflow-hidden"
      style={{ animation: `m-settle-in 400ms var(--m-spring) ${index * 80}ms both` }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors duration-(--duration-fast) hover:bg-white/[0.03] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-tertiary transition-transform duration-(--duration-base) ease-(--ease-standard)"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
        <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-foreground">{section.name}</span>
        <span className="m-num shrink-0 text-[0.6875rem] text-tertiary">{total}</span>
      </button>

      {/* grid-template-rows 0fr → 1fr animates a genuinely unknown height
          without measuring it, and without the min-height pop that a
          max-height guess produces when the guess is wrong. */}
      <div
        className="grid transition-[grid-template-rows] duration-(--duration-slow) ease-(--ease-standard)"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <ul className="flex flex-col gap-px pb-2 pl-[1.9rem] pr-2.5">
            {section.children.map((child) => (
              <li
                key={child.name}
                className="flex items-center gap-2 border-l border-subtle py-1.5 pl-3 text-[0.75rem] text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{child.name}</span>
                <span className="m-num shrink-0 text-[0.6875rem] text-tertiary">{child.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export function StructureDemo() {
  const [organized, setOrganized] = useState(false)
  // Two branches open at rest, not one: a single open branch leaves the panel
  // visibly half empty, and two is also the clearer demonstration — you can see
  // that different sections carry different subsections.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(DEMO_SECTIONS.slice(0, 2).map((s) => s.name))
  )
  const reduced = useReducedMotion()
  const { ref, shown } = useInView<HTMLDivElement>({ threshold: 0.35 })

  // Plays itself once on arrival — a visitor scrolling past should see the
  // transformation happen, not a static "before" waiting to be clicked. The
  // toggle stays live either way, and a reduced-motion visitor gets the
  // organized state immediately instead of a delayed swap.
  useEffect(() => {
    if (!shown) return
    if (reduced) {
      // Reduced motion: the demo must not play itself, so it lands on its
      // finished state instead. Driven by an IntersectionObserver + a media
      // query, neither of which is available at render time.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOrganized(true)
      return
    }
    const t = setTimeout(() => setOrganized(true), 620)
    return () => clearTimeout(t)
  }, [shown, reduced])

  const pileTotal = DEMO_UNIQUE_TABS.length
  const subsectionTotal = useMemo(
    () => DEMO_SECTIONS.reduce((n, s) => n + s.children.length, 0),
    []
  )

  function toggleBranch(name: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div ref={ref}>
      <DemoWindow
        title={organized ? "Thesis — organized" : "Thesis — unsorted"}
        label="Interactive demonstration: a flat pile of tabs becoming a section tree"
        toolbar={
          <span className="m-num text-[0.6875rem] text-tertiary">
            {organized ? `${DEMO_SECTIONS.length} · ${subsectionTotal}` : pileTotal}
          </span>
        }
        bodyClassName="relative"
      >
        {/* Fixed height across both states — a panel that grows or shrinks as
            it toggles would drag the rest of the page with it. */}
        <div className="relative h-[24rem] overflow-hidden sm:h-[26rem]">
          <div
            className="absolute inset-0 flex flex-col gap-1 overflow-hidden p-3"
            style={{
              opacity: organized ? 0 : 1,
              pointerEvents: organized ? "none" : "auto",
              transform: organized ? "translateY(-8px)" : "none",
              transition: "opacity 300ms var(--m-ease), transform 420ms var(--m-ease)",
            }}
            aria-hidden={organized}
          >
            {PILE.map((tab, i) => (
              <PileRow key={tab.id} tab={tab} index={i} />
            ))}
            <div className="pt-1 text-center text-meta text-tertiary">
              + {pileTotal - PILE.length} more, in no particular order
            </div>
          </div>

          <div
            className="absolute inset-0 flex flex-col gap-2 overflow-y-auto p-3"
            style={{
              opacity: organized ? 1 : 0,
              pointerEvents: organized ? "auto" : "none",
              transition: "opacity 360ms var(--m-ease) 140ms",
            }}
            aria-hidden={!organized}
          >
            {organized &&
              DEMO_SECTIONS.map((section, i) => (
                <Branch
                  key={section.name}
                  section={section}
                  index={i}
                  open={open.has(section.name)}
                  onToggle={() => toggleBranch(section.name)}
                />
              ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-subtle px-3.5 py-3">
          <MButton
            variant="secondary"
            onClick={() => setOrganized((v) => !v)}
            aria-pressed={organized}
          >
            {organized ? "Show the pile again" : "Organize them"}
          </MButton>
          <p className={cn("text-body-sm", organized ? "text-muted-foreground" : "text-tertiary")}>
            {organized
              ? `${DEMO_SECTIONS.length} sections · ${subsectionTotal} subsections · open any branch`
              : `${pileTotal} tabs, no structure`}
          </p>
        </div>
      </DemoWindow>
    </div>
  )
}

