"use client"

import { useMemo, useState, type CSSProperties } from "react"
import { Check, RotateCcw } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import { cn } from "@/lib/utils"
import {
  DEMO_DUPLICATE_COUNT,
  DEMO_SECTIONS,
  DEMO_TABS,
  DEMO_UNIQUE_TABS,
  HERO_TAB_COUNT,
  hashUnit,
  roundLayout,
  type DemoTab,
} from "./data"
import { useReducedMotion, useSequence } from "./hooks"
import { DemoFavicon, DemoWindow, MButton } from "./primitives"

/**
 * The hero demonstration: a browser full of tabs becomes a TabDump workspace,
 * on one click, in one frame.
 *
 * One frame rather than two side-by-side panes on purpose. The product's claim
 * is that the mess and the workspace are the *same* material in two states,
 * not that tabs get copied from one place to another — so the container stays
 * put and its contents transform, with the title bar cross-fading from browser
 * chrome to TabDump's.
 *
 * Motion budget: every chip animates transform + opacity only, and its
 * scattered position is itself a transform (expressed in container query
 * units) rather than left/top — so the whole chaos field is one composited
 * layer per chip with no layout work at any point in the sequence. Positions
 * and delays come from a seeded hash of each tab's id, never Math.random, so
 * the server and client render the identical field.
 */

type Stage = "idle" | "dumping" | "processing" | "organized"

/** How many of the corpus's tabs get drawn as chips. A dense field, not all 142 — see HERO_TAB_COUNT. */
const CHIP_COUNT = 26

// Tightened from a 2.56s run. The sequence has a job — read, dedupe,
// categorise, land — and every stage has to be legible, but a visitor should
// not feel they are waiting for a progress bar. 2.0s total, with the four
// readout lines landing ~280ms apart.
const SEQUENCE = {
  processing: 680,
  steps: [800, 1080, 1360, 1640],
  organized: 2040,
} as const

type ChipLayout = {
  tab: DemoTab
  /** Offset from the field's centre, in container-query units. */
  x: number
  y: number
  rotate: number
  scale: number
  /** Near/far falloff — see buildChips. */
  opacity: number
  z: number
  enterDelay: number
  dumpDelay: number
}

function buildChips(tabs: DemoTab[]): ChipLayout[] {
  return tabs.map((tab, i) => {
    const a = hashUnit(tab.id, 1)
    const b = hashUnit(tab.id, 2)
    const c = hashUnit(tab.id, 3)

    // Golden-angle placement keeps the field evenly dense without the visible
    // rows a grid would produce, then the hash nudges each chip off its ideal
    // spot so the result reads as scatter rather than a spiral.
    const angle = i * 2.39996
    // Exponent 0.38, not the 0.5 of a true sunflower spiral. sqrt spreads
    // points with uniform *area* density, which puts the mean chip at ~0.67 of
    // the radius and leaves the frame looking half empty; a smaller exponent
    // pushes the population outward so the field reads full — without raising
    // the maximum, which is what clips chips against the frame edge.
    const radius = Math.pow((i + 0.6) / tabs.length, 0.38)

    // Depth. A scatter where every chip is the same size reads as a pattern
    // printed on one plane; giving each a position on a near/far axis and
    // fading the far ones makes the same chips read as objects in a volume,
    // which is the whole claim this page is making about tabs. Derived from
    // the hash, so depth is stable and the z-order below agrees with it.
    const depth = a
    return {
      tab,
      // Capped so an outermost chip plus its jitter still clears the frame: a
      // chip is ~150px on a ~1220px stage, so its centre cannot exceed ~44% of
      // the half-width before the card itself is clipped.
      x: roundLayout(Math.cos(angle) * radius * 40 + (a - 0.5) * 6),
      y: roundLayout(Math.sin(angle) * radius * 40 + (b - 0.5) * 8),
      rotate: roundLayout((c - 0.5) * 11),
      scale: roundLayout(0.82 + depth * 0.34),
      // Far chips sit back rather than blurring: a real blur would force a
      // separate composited layer for every one of them, and this reads the
      // same at a fraction of the cost.
      opacity: roundLayout(0.5 + depth * 0.5),
      z: Math.round(depth * 20),
      enterDelay: Math.round(b * 420),
      // Chips further from the centre leave later, so the field collapses
      // inward rather than every chip starting at once.
      dumpDelay: Math.round(radius * 340 + c * 90),
    }
  })
}

function chipStyle(chip: ChipLayout, stage: Stage): CSSProperties {
  const scattered = stage === "idle"
  const base: CSSProperties = {
    position: "absolute",
    left: "50%",
    top: "50%",
    zIndex: chip.z,
    willChange: "transform, opacity",
  }

  if (scattered) {
    return {
      ...base,
      opacity: chip.opacity,
      transform: `translate(calc(-50% + ${chip.x}cqw), calc(-50% + ${chip.y}cqh)) rotate(${chip.rotate}deg) scale(${chip.scale})`,
      transition: `transform 620ms var(--m-spring) ${chip.enterDelay}ms, opacity 420ms var(--m-ease) ${chip.enterDelay}ms`,
    }
  }

  // Everything past "idle": collapsed into the funnel and gone. Held here
  // (rather than unmounted) through the whole sequence so returning to idle
  // animates back out instead of popping.
  return {
    ...base,
    opacity: 0,
    transform: "translate(-50%, -50%) rotate(0deg) scale(0.22)",
    transition: `transform 700ms var(--m-spring) ${chip.dumpDelay}ms, opacity 460ms var(--m-ease) ${chip.dumpDelay + 160}ms`,
  }
}

function ChaosChip({ chip, stage }: { chip: ChipLayout; stage: Stage }) {
  return (
    <div style={chipStyle(chip, stage)}>
      {/* Below `lg` the chip drops to its favicon alone. The stage shrinks with
          the viewport but a titled chip does not, and two dozen 150px chips on
          a narrow stage stop reading as a field of tabs and start reading as
          a stack of bars — measured at 768px, where titled chips overlapped
          badly. The favicons alone still say "these are pages". */}
      <div className="flex max-w-[15ch] items-center gap-1.5 rounded-md border border-subtle bg-card p-1.5 shadow-[0_6px_20px_-12px_rgba(0,0,0,0.9)] lg:px-2">
        <DemoFavicon domain={chip.tab.domain} size={13} />
        <span className="hidden truncate text-[0.6875rem] leading-4 text-muted-foreground lg:block">{chip.tab.title}</span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Processing readout
 * ---------------------------------------------------------------------- */

function ProcessingStep({ label, done }: { label: string; done: boolean }) {
  return (
    <li
      className="flex items-center gap-2.5 text-body-sm transition-[opacity,transform] duration-500 ease-(--ease-standard)"
      style={{ opacity: done ? 1 : 0, transform: done ? "none" : "translateY(6px)" }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--success),transparent_72%)]">
        <Check className="size-2.5 text-success" strokeWidth={3} />
      </span>
      <span className="text-muted-foreground">{label}</span>
    </li>
  )
}

/* -------------------------------------------------------------------------
 * Organized workspace
 * ---------------------------------------------------------------------- */

/**
 * Three columns, each a section of the corpus with its first few tabs.
 *
 * Eight rather than four: the payoff has to look like a workspace that is
 * actually full. The panels stretch to the stage height, so too few rows
 * leaves the demo's most important frame looking like an empty shell.
 */
const COLUMNS = DEMO_SECTIONS.slice(0, 3).map((section) => ({
  section,
  tabs: DEMO_UNIQUE_TABS.filter((t) => t.section === section.name).slice(0, 8),
}))

function OrganizedWorkspace({ active }: { active: boolean }) {
  return (
    <div
      // `items-stretch` (the grid default) rather than `content-start`: the
      // columns fill the stage, which is what makes the finished workspace
      // read as full rather than as three cards floating at the top of a void.
      className="absolute inset-0 grid grid-cols-1 grid-rows-3 gap-3 overflow-hidden p-3 sm:grid-cols-3 sm:grid-rows-1 sm:gap-3.5 sm:p-4"
      style={{
        opacity: active ? 1 : 0,
        // Not display:none — the column cards animate in individually, and a
        // hidden subtree would skip straight to its end state on reveal.
        pointerEvents: active ? "auto" : "none",
        transition: "opacity 420ms var(--m-ease)",
      }}
      aria-hidden={!active}
    >
      {COLUMNS.map((col, ci) => (
        <div
          key={col.section.name}
          className="m-panel flex min-h-0 min-w-0 flex-col gap-1.5 overflow-hidden p-2.5"
          style={
            active
              ? ({
                  "--m-from-y": "16px",
                  animation: `m-settle-in 380ms var(--m-spring) ${ci * 90}ms both`,
                } as CSSProperties)
              : { opacity: 0 }
          }
        >
          <div className="flex items-center gap-2 px-0.5 pb-1">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: `var(${CATEGORIES[col.section.category].accentColor})` }}
            />
            <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-foreground">
              {col.section.name}
            </span>
            <span className="m-num shrink-0 text-[0.6875rem] text-tertiary">
              {col.section.children.reduce((n, c) => n + c.count, 0)}
            </span>
          </div>

          {col.tabs.map((tab, ti) => (
            <div
              key={tab.id}
              className={cn(
                "shrink-0 items-center gap-2 rounded-md border border-subtle bg-card/70 px-2 py-1.5",
                // The stage keeps a fixed height at each breakpoint, and three
                // stacked sections of eight rows does not fit a phone. Two rows
                // per section still shows the shape; the count in the header
                // above stays truthful about the rest.
                ti < 2 ? "flex" : "hidden sm:flex"
              )}
              style={
                active
                  ? ({
                      "--m-from-y": "14px",
                      "--m-from-x": `${(hashUnit(tab.id, 4) - 0.5) * 10}px`,
                      animation: `m-settle-in 400ms var(--m-spring) ${ci * 90 + 140 + ti * 70}ms both`,
                    } as CSSProperties)
                  : { opacity: 0 }
              }
            >
              <DemoFavicon domain={tab.domain} size={14} />
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] leading-4 text-muted-foreground">{tab.title}</span>
            </div>
          ))}

          {/* Pinned to the bottom of a stretched column, so the subsection
              list reads as the column's footer at any stage height. */}
          <div
            className="mt-auto shrink-0 truncate px-0.5 pt-1.5 text-meta text-tertiary"
            style={
              active
                ? { animation: `m-settle-in 320ms var(--m-ease) ${ci * 90 + 480}ms both` }
                : { opacity: 0 }
            }
          >
            {col.section.children.map((c) => c.name).join(" · ")}
          </div>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * The demo
 * ---------------------------------------------------------------------- */

export function HeroDumpDemo() {
  const [stage, setStage] = useState<Stage>("idle")
  const [steps, setSteps] = useState(0)
  const reduced = useReducedMotion()
  const { run, clear } = useSequence()

  const chips = useMemo(() => buildChips(DEMO_TABS.slice(0, CHIP_COUNT)), [])

  const uniqueCount = HERO_TAB_COUNT - DEMO_DUPLICATE_COUNT
  const stepLabels = [
    `Read ${HERO_TAB_COUNT} tabs`,
    "Resolved missing titles",
    `Removed ${DEMO_DUPLICATE_COUNT} duplicates`,
    `Built ${DEMO_SECTIONS.length} sections, ${DEMO_SECTIONS.reduce((n, s) => n + s.children.length, 0)} subsections`,
  ]

  function dump() {
    if (stage !== "idle") return
    if (reduced) {
      // No choreography to watch: land on the payoff directly, with the
      // readout already complete, so the demo still *says* what happened.
      setStage("organized")
      setSteps(stepLabels.length)
      return
    }
    setStage("dumping")
    setSteps(0)
    run([
      { at: SEQUENCE.processing, do: () => setStage("processing") },
      ...SEQUENCE.steps.map((at, i) => ({ at, do: () => setSteps(i + 1) })),
      { at: SEQUENCE.organized, do: () => setStage("organized") },
    ])
  }

  function reset() {
    clear()
    setSteps(0)
    setStage("idle")
  }

  const processingVisible = stage === "processing"

  return (
    <div>
      <DemoWindow
        chrome="bare"
        label="Interactive demonstration: a browser full of tabs becoming a TabDump workspace"
        className="w-full"
      >
        {/* Title bar. Cross-fades browser chrome → TabDump chrome as the same
            container changes what it is. */}
        <div className="relative flex h-10 items-center gap-3 border-b border-subtle px-3.5">
          <div
            className="flex items-center gap-3 transition-opacity duration-500 ease-(--ease-standard)"
            style={{ opacity: stage === "organized" ? 0 : 1 }}
          >
            <div className="flex shrink-0 gap-1.5" aria-hidden>
              <span className="size-2.5 rounded-full bg-white/12" />
              <span className="size-2.5 rounded-full bg-white/12" />
              <span className="size-2.5 rounded-full bg-white/12" />
            </div>
            <span className="text-meta text-tertiary">
              <span className="m-num">{HERO_TAB_COUNT}</span> open tabs
            </span>
          </div>

          <div
            className="absolute left-3.5 flex items-center gap-2 transition-opacity duration-500 ease-(--ease-standard)"
            style={{ opacity: stage === "organized" ? 1 : 0 }}
            aria-hidden={stage !== "organized"}
          >
            <span className="text-meta text-muted-foreground">Thesis</span>
            <span className="text-meta text-tertiary">
              · <span className="m-num">{uniqueCount}</span> tabs · {DEMO_SECTIONS.length} sections
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {stage === "organized" ? (
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-subtle px-2.5 text-[0.6875rem] text-muted-foreground transition-colors duration-(--duration-fast) hover:border-strong hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <RotateCcw className="size-3" />
                Replay
              </button>
            ) : (
              <span className="text-meta text-tertiary">
                {stage === "idle" ? "chrome" : "dumping…"}
              </span>
            )}
          </div>
        </div>

        {/* Stage. Fixed aspect ratio so nothing reflows between states, and a
            size container so chip offsets can be written in cqw/cqh. */}
        <div
          className="relative isolate aspect-[5/6] w-full overflow-hidden sm:aspect-[2.5/1]"
          style={{ containerType: "size" }}
        >
          <div aria-hidden className="m-grid absolute inset-0 opacity-40" />

          {/* Chaos field */}
          <div className="absolute inset-0" aria-hidden>
            {chips.map((chip) => (
              <ChaosChip key={chip.tab.id} chip={chip} stage={stage} />
            ))}
          </div>

          {/* The funnel the chips collapse into — only present while they are
              actually travelling, so it never reads as decoration. */}
          <div
            aria-hidden
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              opacity: stage === "dumping" || processingVisible ? 1 : 0,
              transition: "opacity 400ms var(--m-ease)",
            }}
          >
            <span
              className="absolute inset-0 -z-10 rounded-full border border-[color-mix(in_oklch,var(--primary),transparent_60%)]"
              style={{ animation: stage === "dumping" ? "m-pulse-ring 1.1s ease-out infinite" : "none" }}
            />
          </div>

          {/* Processing readout */}
          <div
            className="absolute inset-0 flex items-center justify-center p-4"
            style={{
              opacity: processingVisible ? 1 : 0,
              pointerEvents: "none",
              transition: "opacity 340ms var(--m-ease)",
            }}
          >
            <div className="m-panel relative w-full max-w-sm overflow-hidden bg-popover/80 p-4 backdrop-blur-sm">
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-px"
                style={{
                  background: "linear-gradient(90deg, transparent, var(--accent-text), transparent)",
                  width: "33%",
                  animation: processingVisible ? "m-sweep 1.5s linear infinite" : "none",
                }}
              />
              <p className="text-body-sm text-foreground">Organizing your dump</p>
              <ul className="mt-3 flex flex-col gap-2">
                {stepLabels.map((label, i) => (
                  <ProcessingStep key={label} label={label} done={i < steps} />
                ))}
              </ul>
            </div>
          </div>

          {/* Payoff */}
          <OrganizedWorkspace active={stage === "organized"} />
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-3 border-t border-subtle px-3.5 py-3">
          {stage === "organized" ? (
            <>
              <p className="text-body-sm text-muted-foreground">
                <span className="m-num text-foreground">{uniqueCount}</span> tabs, sorted into{" "}
                <span className="text-foreground">{DEMO_SECTIONS.length} sections</span> — nothing lost, nothing
                duplicated.
              </p>
              <MButton variant="secondary" onClick={reset} className="ml-auto">
                <RotateCcw />
                Run it again
              </MButton>
            </>
          ) : (
            <>
              <MButton onClick={dump} disabled={stage !== "idle"}>
                {stage === "idle" ? `Dump ${HERO_TAB_COUNT} tabs` : "Dumping…"}
              </MButton>
              <p className="text-body-sm text-tertiary">
                {stage === "idle"
                  ? "A real session, rendered live. Press it."
                  : "Reading, deduplicating, categorizing…"}
              </p>
            </>
          )}
        </div>
      </DemoWindow>
    </div>
  )
}
/**
 * The dump's outcome, derived once here so the prose around the demo quotes
 * the same numbers the demo itself computes.
 */
export const HERO_RESULT = {
  unique: HERO_TAB_COUNT - DEMO_DUPLICATE_COUNT,
  duplicates: DEMO_DUPLICATE_COUNT,
  sections: DEMO_SECTIONS.length,
  subsections: DEMO_SECTIONS.reduce((n, s) => n + s.children.length, 0),
}
