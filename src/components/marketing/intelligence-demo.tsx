"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { Copy, Layers } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { DEMO_TABS, DEMO_UNIQUE_TABS } from "./data"
import { useInView, useReducedMotion } from "./hooks"
import { DemoFavicon, DemoWindow, MButton } from "./primitives"

/**
 * Two demonstrations of TabDump doing the organizing work itself.
 *
 * `ReasoningDemo` surfaces a real field of the product's data model — every
 * organized tab carries an `organizationReason`, the short human-readable
 * note explaining why it landed where it did (see Tab.organizationReason in
 * src/lib/tabs/types.ts). Showing that on the landing page is the honest
 * version of "intelligent organization": not a claim, but the same sentence
 * the app itself would show you.
 *
 * `DuplicateDemo` collapses rows that genuinely repeat in the shared corpus,
 * rather than staging a collapse of invented ones.
 */

/* -------------------------------------------------------------------------
 * Why it landed here
 * ---------------------------------------------------------------------- */

/** Representative tabs, paired with the kind of explanation the app writes. */
const REASONED = [
  {
    tab: DEMO_UNIQUE_TABS.find((t) => t.domain === "khanacademy.org")!,
    reason:
      "Course material on entropy, alongside 2 other thermodynamics tabs from this dump — filed under School → Physics rather than Research.",
  },
  {
    tab: DEMO_UNIQUE_TABS.find((t) => t.domain === "linear.app")!,
    reason:
      "An issue tracker for the same repository as 4 GitHub tabs in this batch, so it sits with them in Development → References.",
  },
  {
    tab: DEMO_UNIQUE_TABS.find((t) => t.domain === "docs.google.com")!,
    reason:
      "A document, but its title matches the Physics coursework in this dump — School → Physics, not Personal.",
  },
  {
    tab: DEMO_UNIQUE_TABS.find((t) => t.domain === "longform.org")!,
    reason: "No confident signal from the page itself. Parked in Personal → Reading, where you can move it in one drag.",
  },
].filter((e) => e.tab)

export function ReasoningDemo() {
  const [selected, setSelected] = useState(0)
  const current = REASONED[selected]

  return (
    <DemoWindow
      title="Why it landed here"
      label="Interactive demonstration: TabDump's explanation for where each tab was filed"
      toolbar={<Layers aria-hidden className="size-3.5 text-tertiary" />}
    >
      {/* Fixed height, matched to the duplicates panel beside it so the two
          captions under them land on the same baseline instead of ~50px
          apart. */}
      <div className="flex h-[16.25rem] flex-col content-start gap-1 overflow-hidden p-3">
        {REASONED.map((entry, i) => {
          const isSelected = i === selected
          return (
            <button
              key={entry.tab.id}
              type="button"
              onClick={() => setSelected(i)}
              aria-pressed={isSelected}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-[background-color,border-color] duration-(--duration-base) ease-(--ease-standard)",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                isSelected
                  ? "border-[color-mix(in_oklch,var(--primary),transparent_50%)] bg-accent-subtle"
                  : "border-subtle bg-card/60 hover:border-strong"
              )}
            >
              <span
                aria-hidden
                className="h-5 w-0.5 shrink-0 rounded-full"
                style={{ backgroundColor: `var(${CATEGORIES[entry.tab.category].accentColor})` }}
              />
              <DemoFavicon domain={entry.tab.domain} size={16} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm text-foreground">{entry.tab.title}</span>
                <span className="block truncate text-meta text-tertiary">
                  {entry.tab.section} → {entry.tab.subsection}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* The notes are different lengths, so without a floor the panel — and
          everything under it — resizes each time you pick a different tab.
          Three lines is the longest of them. */}
      <div className="min-h-[7.25rem] border-t border-subtle px-3.5 py-3">
        <p className="m-label">TabDump&rsquo;s note</p>
        {/* Keyed on the selection so the explanation re-enters rather than
            silently swapping text under the reader's eyes. */}
        <p
          key={selected}
          className="mt-2 text-body-sm leading-relaxed text-muted-foreground"
          style={{ animation: "m-settle-in 320ms var(--m-ease) both" }}
        >
          {current.reason}
        </p>
      </div>
    </DemoWindow>
  )
}

/* -------------------------------------------------------------------------
 * Duplicates
 * ---------------------------------------------------------------------- */

/** Every URL that appears more than once in the corpus, with its copies. */
const DUPLICATE_GROUPS = (() => {
  const groups = new Map<string, { domain: string; title: string; category: (typeof DEMO_TABS)[number]["category"]; ids: string[] }>()
  for (const tab of DEMO_TABS) {
    const key = `${tab.domain}|${tab.title}`
    const existing = groups.get(key)
    if (existing) existing.ids.push(tab.id)
    else groups.set(key, { domain: tab.domain, title: tab.title, category: tab.category, ids: [tab.id] })
  }
  return [...groups.values()].filter((g) => g.ids.length > 1)
})()

export function DuplicateDemo() {
  const [collapsed, setCollapsed] = useState(false)
  const reduced = useReducedMotion()
  const { ref, shown } = useInView<HTMLDivElement>({ threshold: 0.5 })

  useEffect(() => {
    if (!shown) return
    if (reduced) {
      // Reduced motion: the demo must not play itself, so it lands on its
      // finished state instead. Driven by an IntersectionObserver + a media
      // query, neither of which is available at render time.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(true)
      return
    }
    const t = setTimeout(() => setCollapsed(true), 900)
    return () => clearTimeout(t)
  }, [shown, reduced])

  const removed = DUPLICATE_GROUPS.reduce((n, g) => n + g.ids.length - 1, 0)

  return (
    <div ref={ref}>
      <DemoWindow
        title={collapsed ? "Deduplicated" : "As they came in"}
        label="Interactive demonstration: repeated tabs collapsing into one"
        toolbar={<Copy aria-hidden className="size-3.5 text-tertiary" />}
      >
        {/* Fixed height, content pinned to the top. The rows collapse inside
            this box rather than shrinking it — otherwise the panel loses ~150px
            the moment it auto-plays, and everything below it on the page jumps
            up under the reader's eyes. That was the page's entire measured
            layout shift (CLS 0.11 -> ~0). */}
        <div className="flex h-[19.5rem] flex-col content-start gap-3 overflow-hidden p-3">
          {DUPLICATE_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              {group.ids.map((id, i) => {
                // Every copy past the first slides up onto the first and
                // fades — the stack literally compresses into one row, which
                // is the whole point. Height is animated via grid rows so the
                // list below closes up rather than leaving a gap.
                const isOriginal = i === 0
                const gone = collapsed && !isOriginal
                return (
                  <div
                    key={id}
                    className="grid transition-[grid-template-rows] duration-(--duration-slow) ease-(--ease-standard)"
                    style={{ gridTemplateRows: gone ? "0fr" : "1fr" }}
                  >
                    <div className="overflow-hidden">
                      <div
                        className="flex items-center gap-2.5 rounded-lg border border-subtle bg-card/60 px-2.5 py-2 transition-[opacity,transform] duration-(--duration-slow) ease-(--ease-standard)"
                        style={
                          {
                            opacity: gone ? 0 : 1,
                            transform: gone ? `translateY(-${i * 6}px) scale(0.97)` : "none",
                            marginBottom: gone ? 0 : 4,
                          } as CSSProperties
                        }
                      >
                        <span
                          aria-hidden
                          className="h-5 w-0.5 shrink-0 rounded-full"
                          style={{ backgroundColor: `var(${CATEGORIES[group.category].accentColor})` }}
                        />
                        <DemoFavicon domain={group.domain} size={16} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm text-foreground">{group.title}</span>
                          <span className="block truncate text-meta text-tertiary">{group.domain}</span>
                        </span>
                        {isOriginal && (
                          <span
                            className="m-num shrink-0 rounded-full border border-subtle px-1.5 py-0.5 text-[0.6875rem] text-tertiary transition-opacity duration-(--duration-slow)"
                            style={{ opacity: collapsed ? 1 : 0 }}
                          >
                            ×{group.ids.length}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-subtle px-3.5 py-3">
          <MButton variant="secondary" onClick={() => setCollapsed((v) => !v)} aria-pressed={collapsed}>
            {collapsed ? "Show the copies" : "Collapse duplicates"}
          </MButton>
          <p className="text-body-sm text-tertiary">
            {collapsed ? (
              <>
                <span className="m-num text-foreground">{removed}</span> copies folded away. Open one, and it is the
                same tab.
              </>
            ) : (
              <>
                <span className="m-num text-foreground">{removed}</span> of these are the same page twice.
              </>
            )}
          </p>
        </div>
      </DemoWindow>
    </div>
  )
}
