"use client"

import { useState, type CSSProperties } from "react"
import { ArrowRight, Check } from "lucide-react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import { DEMO_UNIQUE_TABS, hashUnit } from "./data"
import { useReducedMotion, useSequence } from "./hooks"
import { BrandGlyph, DemoWindow, MButton } from "./primitives"

/**
 * The extension workflow, end to end: a browser window, the toolbar button,
 * the popup, and the tabs landing in TabDump.
 *
 * The numbers in the popup are the ones the real popup shows — a dump reports
 * how many of the current window's tabs are new versus already in the selected
 * workspace (see MSG_CHECK_IMPORTED in extension/src/config.js), so the demo
 * says "31 new · 16 already here" rather than an undifferentiated total.
 */

type Phase = "idle" | "popup" | "dumping" | "done"

const WINDOW_TAB_COUNT = 47
const ALREADY_IMPORTED = 16
const NEW_TABS = WINDOW_TAB_COUNT - ALREADY_IMPORTED

/** The strip of tabs across the top of the fake browser. */
const STRIP = DEMO_UNIQUE_TABS.slice(0, 7)
/** What lands in TabDump. */
const ARRIVALS = DEMO_UNIQUE_TABS.slice(7, 13)

export function ExtensionDemo() {
  const [phase, setPhase] = useState<Phase>("idle")
  const reduced = useReducedMotion()
  const { run, clear } = useSequence()

  function dump() {
    if (reduced) {
      setPhase("done")
      return
    }
    setPhase("dumping")
    run([{ at: 1250, do: () => setPhase("done") }])
  }

  function reset() {
    clear()
    setPhase("idle")
  }

  const landed = phase === "dumping" || phase === "done"

  return (
    <DemoWindow
      chrome="bare"
      label="Interactive demonstration: dumping a browser window with the TabDump extension"
    >
      <div className="grid gap-px bg-[var(--border)] lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.85fr)]">
        {/* --- The browser ------------------------------------------------ */}
        {/* Step labels sit above their panel, not below: the two panels are
            different heights, and captions underneath would land on two
            different baselines and read as unrelated. */}
        <div className="flex flex-col bg-background p-3">
          <p className="px-0.5 pb-2 text-meta text-tertiary">1 · Your browser</p>
          <div className="m-panel flex flex-1 flex-col overflow-hidden">
            {/* Tab strip */}
            <div className="flex items-center gap-1 overflow-hidden border-b border-subtle px-2 py-1.5">
              {STRIP.map((tab) => (
                <span
                  key={tab.id}
                  className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md border border-subtle bg-card px-1.5"
                  title={tab.title}
                >
                  <TabFavicon domain={tab.domain} size={11} />
                  <span className="hidden truncate text-[0.625rem] text-tertiary sm:block">
                    {tab.domain.replace(/^www\./, "").split(".")[0]}
                  </span>
                </span>
              ))}
              <span className="m-num ml-1 shrink-0 text-[0.625rem] whitespace-nowrap text-tertiary">
                +{WINDOW_TAB_COUNT - STRIP.length}
              </span>
            </div>

            {/* Toolbar */}
            <div className="relative flex items-center gap-2 px-2 py-2">
              <span aria-hidden className="h-6 flex-1 rounded-md border border-subtle bg-card" />
              <button
                type="button"
                onClick={() => setPhase((p) => (p === "idle" ? "popup" : "idle"))}
                aria-expanded={phase !== "idle"}
                aria-label="TabDump extension"
                className={cn(
                  "relative inline-flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors duration-(--duration-base)",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  phase === "idle"
                    ? "border-subtle text-muted-foreground hover:border-strong hover:text-foreground"
                    : "border-[color-mix(in_oklch,var(--primary),transparent_50%)] bg-accent-subtle text-foreground"
                )}
              >
                <BrandGlyph className="size-3.5" />
                {phase === "idle" && (
                  <span
                    aria-hidden
                    className="absolute inset-0 rounded-md border border-[color-mix(in_oklch,var(--primary),transparent_55%)]"
                    style={{ animation: "m-pulse-ring 2.2s ease-out infinite" }}
                  />
                )}
              </button>

              {/* Popup */}
              <div
                className="absolute top-full right-2 z-20 mt-1.5 w-[15rem] origin-top-right"
                style={{
                  opacity: phase === "idle" ? 0 : 1,
                  transform: phase === "idle" ? "translateY(-6px) scale(0.96)" : "none",
                  pointerEvents: phase === "idle" ? "none" : "auto",
                  transition: "opacity 200ms var(--m-ease), transform 260ms var(--m-spring)",
                }}
                aria-hidden={phase === "idle"}
              >
                <div className="rounded-xl border border-subtle bg-popover p-3 shadow-[0_24px_50px_-24px_rgba(0,0,0,0.95)]">
                  <div className="flex items-center gap-2">
                    <BrandGlyph className="size-3.5 text-muted-foreground" />
                    <span className="text-body-sm font-medium text-foreground">TabDump</span>
                  </div>
                  <p className="mt-2 text-meta text-tertiary">
                    <span className="m-num text-muted-foreground">{WINDOW_TAB_COUNT}</span> tabs in this window
                  </p>
                  <p className="mt-1 text-meta text-tertiary">
                    <span className="m-num text-muted-foreground">{NEW_TABS}</span> new ·{" "}
                    <span className="m-num">{ALREADY_IMPORTED}</span> already here
                  </p>
                  <button
                    type="button"
                    onClick={dump}
                    disabled={phase !== "popup"}
                    className="mt-3 inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary text-body-sm font-medium text-primary-foreground transition-colors duration-(--duration-fast) hover:bg-accent-hover disabled:opacity-60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {phase === "dumping" ? "Dumping…" : phase === "done" ? "Dumped" : `Dump ${NEW_TABS} new tabs`}
                  </button>
                </div>
              </div>
            </div>

            {/* Page area */}
            {/* Fills whatever height the row settles at, so the two panels
                stay the same height side by side. */}
            <div aria-hidden className="m-grid min-h-24 flex-1 border-t border-subtle opacity-30" />
          </div>
        </div>

        {/* --- The hop ----------------------------------------------------- */}
        <div className="flex items-center justify-center bg-background px-3 py-2 lg:px-4">
          <ArrowRight
            aria-hidden
            className="size-4 rotate-90 text-tertiary transition-[color,transform] duration-(--duration-slow) ease-(--ease-standard) lg:rotate-0"
            style={{ color: landed ? "var(--accent-text)" : undefined }}
          />
        </div>

        {/* --- TabDump ----------------------------------------------------- */}
        <div className="flex flex-col bg-background p-3">
          <p className="px-0.5 pb-2 text-meta text-tertiary">2 · TabDump</p>
          <div className="m-panel flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-subtle px-2.5 py-2">
              <BrandGlyph className="size-3.5 text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-meta text-tertiary">Thesis</span>
              <span className="m-num text-[0.625rem] text-tertiary">
                {phase === "done" ? NEW_TABS : 0} new
              </span>
            </div>

            <div className="relative flex min-h-[10rem] flex-1 flex-col gap-1 p-2">
              {ARRIVALS.map((tab, i) => (
                <div
                  key={tab.id}
                  className="flex items-center gap-2 rounded-md border border-subtle bg-card/70 px-2 py-1.5"
                  style={
                    landed
                      ? ({
                          "--m-from-x": "-22px",
                          "--m-from-y": `${(hashUnit(tab.id, 41) - 0.5) * 10}px`,
                          animation: `m-settle-in 520ms var(--m-spring) ${i * 90}ms both`,
                        } as CSSProperties)
                      : { opacity: 0 }
                  }
                >
                  <span
                    aria-hidden
                    className="h-4 w-0.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `var(${CATEGORIES[tab.category].accentColor})` }}
                  />
                  <TabFavicon domain={tab.domain} size={13} />
                  <span className="min-w-0 flex-1 truncate text-[0.6875rem] leading-4 text-muted-foreground">
                    {tab.title}
                  </span>
                </div>
              ))}

              {!landed && (
                <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-meta text-tertiary">
                  Waiting for a dump
                </p>
              )}

              {phase === "done" && (
                <p
                  className="mt-auto flex items-center gap-1.5 px-0.5 pt-1 text-meta text-tertiary"
                  style={{ animation: "m-settle-in 400ms var(--m-ease) 600ms both" }}
                >
                  <Check aria-hidden className="size-3 text-success" strokeWidth={3} />
                  Sorted and deduplicated on arrival
                </p>
              )}
            </div>
          </div>        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-subtle px-3.5 py-3">
        {phase === "done" ? (
          <MButton variant="secondary" onClick={reset}>
            Run it again
          </MButton>
        ) : (
          <MButton variant="secondary" onClick={() => setPhase("popup")} disabled={phase !== "idle"}>
            Open the extension
          </MButton>
        )}
        <p className="text-body-sm text-tertiary">
          {phase === "idle" && "Click the TabDump button in the toolbar."}
          {phase === "popup" && "It already knows which tabs you have seen before."}
          {phase === "dumping" && "Sending the window across…"}
          {phase === "done" && "One click. No copy-paste, no bookmark folder."}
        </p>
      </div>
    </DemoWindow>
  )
}
