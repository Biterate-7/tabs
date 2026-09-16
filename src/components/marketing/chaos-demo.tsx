"use client"

import { useState } from "react"
import type { CSSProperties } from "react"
import { AgentGlyph, RunStatusPill } from "./agent-primitives"
import { DEMO_ARTIFACT_SEEDS, DEMO_CONTEXT_TABS } from "./agent-data"
import { DEMO_UNIQUE_TABS, hashUnit, roundLayout } from "./data"
import { cn } from "@/lib/utils"
import { DemoFavicon, DemoWindow } from "./primitives"

/**
 * Before and after, as one frame with a switch rather than two pictures.
 *
 * A side-by-side pair asks a reader to compare two static images and find the
 * difference themselves. One frame that *changes* puts the difference in
 * motion, and every object survives the change — the same favicons are in both
 * states, which is the actual claim: nothing was thrown away, it was placed.
 *
 * The scatter is deterministic (`hashUnit` over each tab's own id, rounded by
 * `roundLayout`), not random. The page is server-rendered at /welcome, and a
 * `Math.random()` here would serialise one arrangement into the HTML and
 * generate a different one on hydration.
 */

/** Enough tabs to look like a bad afternoon, few enough to stay legible at 390px. */
const SCATTER_TABS = DEMO_UNIQUE_TABS.slice(0, 26)

/** The things that are not tabs and have nowhere to live: agent sessions, in four terminals. */
const STRAY_SESSIONS = ["Claude Code", "a second session", "yesterday's session", "the one you closed"]

export function ChaosDemo() {
  const [ordered, setOrdered] = useState(false)

  return (
    <DemoWindow
      chrome={ordered ? "app" : "browser"}
      // Counted from the arrays below rather than typed, so the title cannot
      // end up describing a frame that holds something else.
      title={
        ordered
          ? "Building TabDump — command center"
          : `${SCATTER_TABS.length} tabs, ${STRAY_SESSIONS.length} agent sessions`
      }
      label="The same work, scattered and then placed"
      toolbar={
        <div className="flex items-center gap-1 rounded-full border border-subtle p-0.5">
          {[
            { value: false, label: "Before" },
            { value: true, label: "After" },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setOrdered(option.value)}
              aria-pressed={ordered === option.value}
              className={cn(
                "h-6 rounded-full px-2.5 text-[0.6875rem] transition-colors duration-(--duration-fast)",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                ordered === option.value
                  ? "bg-white/[0.1] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="relative h-[17rem] overflow-hidden sm:h-[20rem]">
        <div
          aria-hidden
          className={cn(
            "m-grid absolute inset-0 transition-opacity duration-700",
            ordered ? "opacity-40" : "opacity-0"
          )}
        />

        {/* Tabs. One element per tab in both states — the position is what
            changes, so the browser animates each chip from where it was rather
            than tearing the list down and building a different one. */}
        {SCATTER_TABS.map((tab, i) => {
          const at = ordered ? placedAt(i) : chaosAt(tab.id)
          return (
            <span
              key={tab.id}
              className={cn(
                "absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg border",
                "transition-[left,top,border-color,background-color,opacity] duration-[900ms] ease-(--m-spring)",
                ordered
                  ? "border-subtle bg-card/80 opacity-100"
                  : "border-transparent bg-card/50 opacity-70"
              )}
              style={{
                left: `${at.x}%`,
                top: `${at.y}%`,
                // Staggered so the field resolves as many objects finding
                // places rather than as one block sliding.
                transitionDelay: `${Math.round(hashUnit(tab.id, 3) * 220)}ms`,
              }}
              title={tab.title}
            >
              <DemoFavicon domain={tab.domain} size={15} />
            </span>
          )
        })}

        {/* Section labels — only meaningful once there are sections. */}
        {ordered &&
          SECTION_BANDS.map((band) => (
            <span
              key={band.label}
              className="m-label absolute -translate-y-1/2"
              style={{ left: "3%", top: `${band.y}%` }}
            >
              {band.label}
            </span>
          ))}

        {/* Agent sessions. Before: four unlabelled terminals, nowhere in
            particular. After: one agent, in the workspace, with a status and
            something to show for itself. */}
        {!ordered &&
          STRAY_SESSIONS.map((label, i) => (
            <span
              key={label}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border border-subtle bg-[#0c0c11] px-2 py-1.5 text-[0.625rem] text-tertiary opacity-80"
              style={{ left: `${STRAY_AT[i].x}%`, top: `${STRAY_AT[i].y}%` }}
            >
              <span className="m-num">$ </span>
              {label}
            </span>
          ))}

        {ordered && (
          <div
            className="m-enter absolute right-[4%] bottom-[5%] flex items-center gap-2.5 rounded-xl border border-strong/50 bg-[#12121a] px-3 py-2.5 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.95)]"
            style={{ "--m-enter-delay": "500ms" } as CSSProperties}
          >
            <AgentGlyph className="size-6" />
            <span>
              <span className="block text-body-sm text-foreground">Claude Code</span>
              <span className="m-num block text-[0.625rem] text-tertiary">
                {DEMO_ARTIFACT_SEEDS.length} files · {DEMO_CONTEXT_TABS.length} context tabs
              </span>
            </span>
            <RunStatusPill status="waiting" size="sm" />
          </div>
        )}
      </div>
    </DemoWindow>
  )
}

/* -------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------- */

type Point = { x: number; y: number }

/** Where a tab sits before anything has been done with it. Deterministic per id. */
function chaosAt(id: string): Point {
  return {
    x: roundLayout(8 + hashUnit(id, 1) * 84),
    y: roundLayout(10 + hashUnit(id, 2) * 78),
  }
}

/** Horizontal bands, one per section. */
const SECTION_BANDS = [
  { label: "Research", y: 18 },
  { label: "Development", y: 41 },
  // Stops well short of the floor: the agent card sits in the bottom-right
  // corner, and a third row any lower would have tabs sitting behind it.
  { label: "Personal", y: 64 },
]

/**
 * Where a tab sits once it belongs somewhere: in rows, by index.
 *
 * By index rather than by the tab's real section, because this demo is about
 * the *shape* of the change — scattered to placed — and the section tree
 * further down the page is where the actual grouping is argued. Nine per row
 * keeps the rows inside the frame at every width the page is tested at.
 */
function placedAt(index: number): Point {
  const perRow = 9
  const row = Math.floor(index / perRow)
  const col = index % perRow
  const band = SECTION_BANDS[Math.min(row, SECTION_BANDS.length - 1)]
  return {
    x: roundLayout(22 + col * 8.4),
    y: roundLayout((band?.y ?? 64) + 4),
  }
}

/** The four stray terminals, placed by hand so none of them lands on a tab cluster. */
const STRAY_AT: Point[] = [
  { x: 24, y: 16 },
  { x: 72, y: 30 },
  { x: 35, y: 74 },
  { x: 78, y: 86 },
]
