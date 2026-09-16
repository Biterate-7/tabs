"use client"

import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import { RotateCcw } from "lucide-react"
import type { AgentEventKind } from "@/lib/agents/types"
import { cn } from "@/lib/utils"
import { DEMO_EVENTS, demoClock } from "./agent-data"
import { useInView, useReducedMotion, useSequence } from "./hooks"
import { DemoWindow, mButtonClass } from "./primitives"

/**
 * The activity log, arriving.
 *
 * Every row is an `AgentEvent` from the fixture, in the domain's closed
 * five-value vocabulary — `started`, `status`, `activity`, `link`, `ended`. An
 * open `kind` string is exactly how provider detail leaks into a log one value
 * at a time, so the product does not have one and neither does this.
 *
 * What a row can say is bounded too. `summary` is a short, already-safe line
 * that the adapter produced — "Created src/lib/auth/session.ts" — and the
 * domain has no field at all for a prompt, a command, a tool result or a
 * model's reasoning. That is why this timeline shows none: not restraint in
 * the marketing copy, an absence in the type.
 */

/** Per-kind mark. A word, not only a shape — the log is read, not scanned for colour. */
const KIND_LABEL: Record<AgentEventKind, string> = {
  started: "Started",
  status: "Status",
  activity: "Activity",
  link: "Linked",
  ended: "Ended",
}

const KIND_TONE: Record<AgentEventKind, string> = {
  started: "var(--m-agent-live)",
  status: "var(--m-agent-idle)",
  activity: "var(--text-secondary)",
  link: "var(--accent-text)",
  ended: "var(--m-agent-good)",
}

/** One row lands every 520ms — slow enough to read, quick enough that five take under three seconds. */
const STEP_MS = 520

export function TimelineDemo() {
  const reduced = useReducedMotion()
  const { ref, shown } = useInView<HTMLDivElement>()
  const { run, clear } = useSequence()
  // Starts complete: the honest server-rendered state, and where a visitor
  // with reduced motion stays.
  const [visible, setVisible] = useState(DEMO_EVENTS.length)
  const [playing, setPlaying] = useState(false)

  /**
   * Starts the log replaying.
   *
   * Every state change is scheduled rather than written directly, including the
   * reset to zero rows: this runs from an effect on first scroll into view, and
   * a synchronous setState there is a cascading render. Same shape as the hero's
   * sequence, for the same reason.
   */
  function play() {
    if (reduced) {
      run([{ at: 0, do: () => setVisible(DEMO_EVENTS.length) }])
      return
    }
    run([
      {
        at: 0,
        do: () => {
          setPlaying(true)
          setVisible(0)
        },
      },
      ...DEMO_EVENTS.map((_, i) => ({ at: (i + 1) * STEP_MS, do: () => setVisible(i + 1) })),
      { at: DEMO_EVENTS.length * STEP_MS + 300, do: () => setPlaying(false) },
    ])
  }

  useEffect(() => {
    if (!shown || reduced) return
    play()
    return clear
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reduced])

  return (
    <div ref={ref}>
      <DemoWindow
        chrome="app"
        title="Activity — Implement account sign-in"
        label="An agent run's activity log"
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
        {/* Height reserved for the full log. Rows arrive into space that is
            already there, so the section below never moves while it plays. */}
        <ol className="relative flex min-h-[15.5rem] flex-col gap-0 p-4 sm:p-5">
          {/* The spine. Sits behind the marks and stops short of the last row
              so the log reads as ending rather than as continuing off-frame. */}
          <span
            aria-hidden
            className="absolute top-6 bottom-9 left-[calc(1rem+3.5rem)] w-px bg-[var(--border)] sm:left-[calc(1.25rem+3.5rem)]"
          />
          {DEMO_EVENTS.map((event, i) => (
            <li
              key={event.id}
              className={cn(
                "relative flex items-start gap-3 py-2",
                i < visible ? "m-enter" : "invisible"
              )}
              style={{ "--m-enter-delay": "0ms" } as CSSProperties}
            >
              <span className="m-num w-14 shrink-0 pt-px text-[0.75rem] text-tertiary">
                {demoClock(event.timestamp)}
              </span>
              <span
                aria-hidden
                className="relative z-10 mt-1.5 size-1.5 shrink-0 rounded-full ring-3 ring-[var(--card)]"
                style={{ backgroundColor: KIND_TONE[event.kind] }}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-body-sm text-foreground">{event.summary}</span>
                <span
                  className="m-num mt-0.5 block text-[0.625rem] tracking-[0.04em] uppercase"
                  style={{ color: KIND_TONE[event.kind] }}
                >
                  {KIND_LABEL[event.kind]}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </DemoWindow>
    </div>
  )
}
