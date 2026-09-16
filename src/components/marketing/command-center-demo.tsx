"use client"

import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import { RotateCcw } from "lucide-react"
import { getAgentRunSummary } from "@/lib/agents/intelligence/run-summary"
import type { AgentRunStatus } from "@/lib/agents/types"
import { cn } from "@/lib/utils"
import {
  AgentIdentity,
  RunCounts,
  RunStatusPill,
  WorkItemRow,
  WorkProgress,
} from "./agent-primitives"
import {
  DEMO_AGENT_INDEX,
  DEMO_ARTIFACT_SEEDS,
  DEMO_CONTEXT_TABS,
  DEMO_RUN_ID,
  DEMO_WORKSPACE_NAME,
  DEMO_WORK_ITEMS,
} from "./agent-data"
import { DEMO_UNIQUE_TABS } from "./data"
import { useElementSize, useInView, useReducedMotion, useSequence } from "./hooks"
import { DemoFavicon, DemoWindow, mButtonClass } from "./primitives"

/**
 * The hero: a miniature TabDump command center, coming alive.
 *
 * ## What it is arguing
 *
 * Not "here is a screenshot of an app". The sequence below *is* the product's
 * architecture, played at a speed a person can follow: an agent appears in a
 * workspace, starts a run, takes tabs as context, works through a plan, touches
 * files, and then stops and waits for you. Someone who reads none of the copy
 * on this page should still come away knowing that TabDump shows them what an
 * agent is doing and what it touched.
 *
 * ## What it is not
 *
 * Nothing here observes anything. The state it walks through is the fixture in
 * ./agent-data, and the numbers beside it come from the product's own
 * `getAgentRunSummary`. A visitor with no local Claude Code session sees the
 * identical sequence to one who has it running — which is the only honest way
 * to build a marketing demo of a feature that reads local state.
 */

/* -------------------------------------------------------------------------
 * The sequence
 * ---------------------------------------------------------------------- */

/**
 * The stages, in order. A stage is a number so comparisons read as "have we
 * reached X yet" rather than as a chain of string equality checks — every
 * element below is visible from its own stage onward, not only during it.
 */
const Stage = {
  /** A workspace with tabs in it, and nothing else. */
  Tabs: 0,
  /** An agent joins the workspace. */
  Agent: 1,
  /** It starts a run: status working. */
  Running: 2,
  /** The plan appears — the work items it is tracking. */
  Plan: 3,
  /** Two items complete; progress moves. */
  Progress: 4,
  /** Files it touched appear, and the relationships draw. */
  Artifacts: 5,
  /** The tabs it used as context light up. */
  Context: 6,
  /** It stops, waiting on something only a person can give it. */
  Settled: 7,
} as const

type StageValue = (typeof Stage)[keyof typeof Stage]

/** Milliseconds from the start of the sequence to each stage. */
const SCHEDULE: { at: number; stage: StageValue }[] = [
  { at: 360, stage: Stage.Agent },
  { at: 900, stage: Stage.Running },
  { at: 1500, stage: Stage.Plan },
  { at: 2500, stage: Stage.Progress },
  { at: 3300, stage: Stage.Artifacts },
  { at: 4300, stage: Stage.Context },
  { at: 5300, stage: Stage.Settled },
]

/** The run's status at each stage — the same six-value vocabulary the domain uses. */
function statusAt(stage: StageValue): AgentRunStatus | null {
  if (stage < Stage.Running) return null
  return stage >= Stage.Settled ? "waiting" : "working"
}

/**
 * The plan, as it looks at a given stage.
 *
 * Before `Progress` every item is still `pending`, because at that point in
 * the story nothing has been finished yet. From `Progress` on, the items carry
 * the statuses the fixture actually gives them. Rewriting status this way —
 * rather than hiding rows — is what lets the progress bar move for a reason a
 * viewer can see.
 */
function planAt(stage: StageValue) {
  if (stage < Stage.Plan) return []
  if (stage < Stage.Progress) {
    return DEMO_WORK_ITEMS.map((item) => ({ ...item, status: "pending" as const }))
  }
  if (stage < Stage.Settled) {
    // Mid-run: the blocked item has not hit its wall yet.
    return DEMO_WORK_ITEMS.map((item) =>
      item.status === "blocked" ? { ...item, status: "pending" as const } : item
    )
  }
  return DEMO_WORK_ITEMS
}

/** Only ever counts what is on screen, so the bar and the rows can never disagree. */
function progressAt(stage: StageValue) {
  const items = planAt(stage)
  if (!items.length) return undefined
  const total = items.filter((i) => i.status !== "cancelled").length
  const completed = items.filter((i) => i.status === "completed").length
  return total === 0 ? undefined : { completed, total }
}

/* -------------------------------------------------------------------------
 * Canvas geometry
 *
 * Fixed percentages, authored rather than generated. The canvas is small and
 * every object in it has a job — three context tabs on the left that the run
 * will claim, three ambient tabs that it will not, and three files on the
 * right — so scattering them from a hash would only make the composition
 * worse. Percentages (not pixels) keep the arrangement intact as the frame
 * narrows.
 * ---------------------------------------------------------------------- */

type Point = { x: number; y: number }

const AGENT_AT: Point = { x: 50, y: 50 }

/** Left column: the workspace's tabs. The first three are the run's context. */
const CONTEXT_AT: Point[] = [
  { x: 11, y: 20 },
  { x: 9, y: 50 },
  { x: 16, y: 79 },
]

const AMBIENT_AT: Point[] = [
  { x: 27, y: 33 },
  { x: 25, y: 66 },
  { x: 30, y: 8 },
  { x: 33, y: 92 },
]

/**
 * Right column: the files the run touched — one position per artifact in the
 * fixture, so the canvas shows exactly the number the panel beside it reports.
 * Three chips under a panel reading "5 files" is a discrepancy a careful
 * reader will find, and this page cannot afford one.
 */
const ARTIFACT_AT: Point[] = [
  { x: 82, y: 14 },
  { x: 90, y: 33 },
  { x: 86, y: 52 },
  { x: 90, y: 71 },
  { x: 79, y: 89 },
]

/**
 * How much of the canvas is drawn, by frame width.
 *
 * Below ~520px the full arrangement stops being a diagram and becomes a
 * collision: nine objects plus their labels do not fit beside each other, and
 * the file chips run off the right edge. So the narrow canvas draws fewer
 * objects rather than smaller ones — the story it tells (tabs in, agent in the
 * middle, files out) survives at two of each, and the panel underneath still
 * reports the real totals.
 *
 * Keyed off the measured width rather than a CSS breakpoint because the canvas
 * is a column inside a grid: at 1024 the viewport is wide while this element is
 * not, and a viewport media query would get that case exactly backwards.
 */
const COMPACT_BELOW = 520

type CanvasLayout = {
  agent: Point
  context: Point[]
  ambient: Point[]
  artifacts: Point[]
  /** Chip width cap, in rem. Narrower where there is less room beside it. */
  chipRem: number
}

const WIDE_LAYOUT: CanvasLayout = {
  agent: AGENT_AT,
  context: CONTEXT_AT,
  ambient: AMBIENT_AT,
  artifacts: ARTIFACT_AT,
  chipRem: 9,
}

const COMPACT_LAYOUT: CanvasLayout = {
  agent: { x: 46, y: 50 },
  context: [
    { x: 13, y: 24 },
    { x: 13, y: 74 },
  ],
  ambient: [
    { x: 27, y: 12 },
    { x: 26, y: 88 },
  ],
  // Pulled well inside the right edge: these carry text, and a centred chip at
  // x=90 hangs half its width past the frame.
  artifacts: [
    { x: 76, y: 24 },
    { x: 76, y: 74 },
  ],
  chipRem: 6.5,
}

function layoutFor(size: { width: number } | null): CanvasLayout {
  return size && size.width < COMPACT_BELOW ? COMPACT_LAYOUT : WIDE_LAYOUT
}

/** Tabs that are not this run's context — drawn from the shared corpus. */
const AMBIENT_TABS = DEMO_UNIQUE_TABS.filter(
  (t) => t.section === "Development" && !DEMO_CONTEXT_TABS.some((c) => c.id === t.id)
).slice(0, AMBIENT_AT.length)

/* -------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------- */

export function CommandCenterDemo() {
  const reduced = useReducedMotion()
  const { ref, shown } = useInView<HTMLDivElement>()
  const { run, clear } = useSequence()
  // Starts settled. Two reasons: the server has no way to know whether the
  // sequence will ever play, so the honest first paint is the finished state;
  // and a visitor who lands with reduced motion on never leaves it.
  const [stage, setStage] = useState<StageValue>(Stage.Settled)
  const [playing, setPlaying] = useState(false)

  /**
   * Starts the sequence.
   *
   * Every state change goes through `run`, including the reset to the first
   * stage — so nothing here writes state synchronously. That matters because
   * this is called from an effect on first scroll into view, and a synchronous
   * setState there is a cascading render (and the lint rule that says so is
   * right). Scheduling the reset at 0ms costs a frame nobody can perceive and
   * keeps the whole sequence in one place.
   */
  function play() {
    if (reduced) {
      run([{ at: 0, do: () => setStage(Stage.Settled) }])
      return
    }
    run([
      {
        at: 0,
        do: () => {
          setPlaying(true)
          setStage(Stage.Tabs)
        },
      },
      ...SCHEDULE.map((step) => ({ at: step.at, do: () => setStage(step.stage) })),
      { at: SCHEDULE[SCHEDULE.length - 1].at + 400, do: () => setPlaying(false) },
    ])
  }

  // Plays once, when the frame first reaches the viewport — not on mount. In
  // the hero those are usually the same moment; they stop being the same the
  // instant someone arrives at a deep link further down the page.
  useEffect(() => {
    if (!shown || reduced) return
    play()
    return clear
    // `play` is recreated every render and depends only on values read at call
    // time; adding it here would restart the sequence on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reduced])

  const status = statusAt(stage)
  const plan = planAt(stage)
  const progress = progressAt(stage)
  // The counts come from the product's own selector rather than from the
  // arrays above, so "5 files · 3 context tabs" on this page is computed the
  // way it is computed in the app.
  const summary = getAgentRunSummary(DEMO_AGENT_INDEX, DEMO_RUN_ID)

  return (
    <div ref={ref}>
      <DemoWindow
        chrome="app"
        title={`${DEMO_WORKSPACE_NAME} — command center`}
        label="A TabDump workspace with an agent working inside it"
        toolbar={
          <button
            type="button"
            onClick={play}
            disabled={playing}
            className={cn(mButtonClass("ghost"), "h-7 px-2.5 text-[0.75rem]")}
          >
            <RotateCcw />
            Replay
          </button>
        }
      >
        {/* Canvas and inspector, exactly as the app pairs them: the spatial
            view on the left and the run's own panel on the right. Stacks on
            narrow screens with the canvas first — the map is the thing that
            makes the panel mean something. */}
        <div className="grid lg:grid-cols-[minmax(0,1fr)_19rem]">
          <Canvas stage={stage} />
          <Inspector
            status={status}
            plan={plan}
            progress={progress}
            artifactCount={stage >= Stage.Artifacts ? (summary?.artifactCount ?? 0) : 0}
            contextTabCount={stage >= Stage.Context ? (summary?.contextTabCount ?? 0) : 0}
            producedTabCount={stage >= Stage.Context ? (summary?.producedTabCount ?? 0) : 0}
          />
        </div>
      </DemoWindow>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Canvas
 * ---------------------------------------------------------------------- */

function Canvas({ stage }: { stage: StageValue }) {
  const agentIn = stage >= Stage.Agent
  const artifactsIn = stage >= Stage.Artifacts
  const contextIn = stage >= Stage.Context
  // Measured rather than assumed, for two reasons: the lines below are drawn in
  // pixel space so the canvas's aspect ratio cannot skew them, and how many
  // objects fit depends on this element's width rather than the viewport's.
  const { ref, size } = useElementSize<HTMLDivElement>()
  const layout = layoutFor(size)

  /** A percentage position, in the measured pixel space. */
  function px(p: Point) {
    return size ? { x: (p.x / 100) * size.width, y: (p.y / 100) * size.height } : null
  }

  return (
    <div
      ref={ref}
      className="relative h-[16rem] overflow-hidden border-b border-subtle sm:h-[19rem] lg:h-[21rem] lg:border-r lg:border-b-0"
    >
      <div aria-hidden className="m-grid absolute inset-0 opacity-40" />

      {/* Relationships. Drawn under every node so a line never crosses over a
          card, and pointer-events-none so the layer cannot swallow a hover.

          The viewBox is the canvas's own measured pixel size, so nothing is
          scaled: strokes stay the width they say they are, and `pathLength`
          normalisation behaves. Rendered only once measured — before that there
          is no honest geometry to draw. */}
      {size && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full"
          viewBox={`0 0 ${size.width} ${size.height}`}
        >
          {contextIn &&
            layout.context.map((p, i) => (
              <Edge key={`ctx-${i}`} from={px(layout.agent)} to={px(p)} kind="context" delay={i * 90} />
            ))}
          {artifactsIn &&
            layout.artifacts.map((p, i) => (
              <Edge
                key={`art-${i}`}
                from={px(layout.agent)}
                to={px(p)}
                // A file this run only read gets the thinner, dimmer line:
                // inspecting is the least committal thing a run does to a file.
                kind={DEMO_ARTIFACT_SEEDS[i]?.roles.includes("inspected") ? "inspected" : "edited"}
                delay={i * 90}
              />
            ))}
        </svg>
      )}

      {/* Tabs */}
      {layout.ambient.map((at, i) => {
        const tab = AMBIENT_TABS[i]
        return tab ? (
          <TabDot key={tab.id} at={at} domain={tab.domain} title={tab.title} />
        ) : null
      })}
      {layout.context.map((at, i) => {
        const tab = DEMO_CONTEXT_TABS[i]
        return tab ? (
          <TabDot
            key={tab.id}
            at={at}
            domain={tab.domain}
            title={tab.title}
            highlighted={contextIn}
          />
        ) : null
      })}

      {/* Files. Iterated over the fixture, not over the positions, so the
          canvas is driven by what the run actually touched — the wide layout
          has a position for every one, and the compact layout deliberately
          runs out, which is what drops the extras on a narrow frame. */}
      {DEMO_ARTIFACT_SEEDS.map((seed, i) => {
        const at = layout.artifacts[i]
        return at ? (
          <FileChip
            key={seed.id}
            at={at}
            path={seed.path}
            maxRem={layout.chipRem}
            visible={artifactsIn}
            delay={i * 110}
          />
        ) : null
      })}

      {/* The agent */}
      <AgentNode at={layout.agent} visible={agentIn} status={statusAt(stage)} />
    </div>
  )
}

/**
 * One relationship line.
 *
 * `kind` picks the stroke weight and the colour family, mirroring the canvas
 * renderer's rule that a relationship must be distinguishable by more than
 * colour: `inspected` is the thinnest and dimmest because reading a file is
 * the least committal thing a run can do to it.
 *
 * Coordinates arrive in pixels and may be null before the canvas has been
 * measured, in which case there is no line to draw yet.
 */
function Edge({
  from,
  to,
  kind,
  delay,
}: {
  from: Point | null
  to: Point | null
  kind: "context" | "inspected" | "edited"
  delay: number
}) {
  if (!from || !to) return null

  return (
    <line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      // Declares the path as one unit long, so the draw animation's dash
      // fractions in marketing.css are independent of how far the line reaches
      // and every relationship takes the same time to arrive.
      pathLength={1}
      className="m-draw"
      stroke={kind === "context" ? "var(--text-tertiary)" : "var(--m-agent-live)"}
      strokeWidth={kind === "edited" ? 1.4 : 1}
      strokeLinecap="round"
      opacity={kind === "context" ? 0.5 : 0.75}
      style={{ "--m-draw-delay": `${delay}ms` } as CSSProperties}
    />
  )
}

/** A tab on the canvas: favicon only, the way the real canvas draws one when it is small. */
function TabDot({
  at,
  domain,
  title,
  highlighted = false,
}: {
  at: Point
  domain: string
  title: string
  highlighted?: boolean
}) {
  return (
    <span
      className={cn(
        "absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg border",
        "transition-[border-color,background-color,opacity,box-shadow] duration-500 ease-(--m-ease)",
        highlighted
          ? "border-[color-mix(in_oklch,var(--primary),transparent_40%)] bg-accent-subtle"
          : "border-subtle bg-card/80 opacity-60"
      )}
      style={{ left: `${at.x}%`, top: `${at.y}%` }}
      title={title}
    >
      <DemoFavicon domain={domain} size={15} />
    </span>
  )
}

/** A file the run touched, as a small card on the canvas. */
function FileChip({
  at,
  path,
  maxRem,
  visible,
  delay,
}: {
  at: Point
  path: string
  /** Width cap. The chip is centred on `at`, so half of any overflow hangs off the frame. */
  maxRem: number
  visible: boolean
  delay: number
}) {
  const file = path.slice(path.lastIndexOf("/") + 1)
  return (
    <span
      className={cn(
        "m-num absolute -translate-x-1/2 -translate-y-1/2 truncate rounded-md border border-subtle bg-card/90 px-1.5 py-1 text-[0.625rem] text-muted-foreground",
        visible ? "m-enter" : "invisible"
      )}
      style={
        {
          left: `${at.x}%`,
          top: `${at.y}%`,
          maxWidth: `${maxRem}rem`,
          "--m-enter-delay": `${delay}ms`,
        } as CSSProperties
      }
    >
      {file}
    </span>
  )
}

/**
 * The agent, at the centre of its own relationships.
 *
 * Square-cornered where a tab is rounded, and carrying a status — the two
 * things that make it read as a different kind of object in the same space
 * rather than as one more tab.
 */
function AgentNode({
  at,
  visible,
  status,
}: {
  at: Point
  visible: boolean
  status: AgentRunStatus | null
}) {
  return (
    <div
      className={cn(
        "absolute -translate-x-1/2 -translate-y-1/2",
        visible ? "m-enter" : "invisible"
      )}
      style={{ left: `${at.x}%`, top: `${at.y}%` }}
    >
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-strong/50 bg-[#12121a] px-3 py-2.5 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.95)]">
        <span className="text-[0.8125rem] font-medium whitespace-nowrap text-foreground">
          Claude Code
        </span>
        {status ? (
          <RunStatusPill status={status} size="sm" />
        ) : (
          // A placeholder of the same height, so the card does not grow the
          // instant the run starts and shove the lines attached to it.
          <span className="h-[1.375rem]" aria-hidden />
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Inspector
 * ---------------------------------------------------------------------- */

function Inspector({
  status,
  plan,
  progress,
  artifactCount,
  contextTabCount,
  producedTabCount,
}: {
  status: AgentRunStatus | null
  plan: ReturnType<typeof planAt>
  progress?: { completed: number; total: number }
  artifactCount: number
  contextTabCount: number
  producedTabCount: number
}) {
  return (
    // A fixed minimum height, so the panel does not grow row by row and push
    // the whole hero down the page while the sequence plays. This is the CLS
    // the previous landing measured to zero; a demo that reflows the fold is
    // the most expensive animation on a page.
    <div className="flex min-h-[14rem] min-w-0 flex-col gap-3.5 p-4 lg:min-h-[21rem]">
      <AgentIdentity name="Claude Code" provider="claude-code" size="sm" />

      {status ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-body-sm text-foreground">
              Implement account sign-in
            </span>
            <RunStatusPill status={status} size="sm" />
          </div>
          <WorkProgress progress={progress} />
        </>
      ) : (
        <p className="text-body-sm text-tertiary">No run yet.</p>
      )}

      <div className="flex flex-col gap-1.5">
        {plan.map((item, i) => (
          <WorkItemRow
            key={item.id}
            title={item.title}
            status={item.status}
            wrap
            className="m-enter"
            style={{ "--m-enter-delay": `${i * 70}ms` } as CSSProperties}
          />
        ))}
      </div>

      <RunCounts
        className="mt-auto text-[0.6875rem]"
        artifactCount={artifactCount}
        contextTabCount={contextTabCount}
        producedTabCount={producedTabCount}
      />
    </div>
  )
}
