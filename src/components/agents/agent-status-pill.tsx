import { AGENT_TONE_TEXT_CLASS } from "./agent-tone"
import { cn } from "@/lib/utils"
import type { AgentVisualTone } from "@/lib/agents/visual/types"

/**
 * A status, drawn the way the landing page draws one: a coloured dot and a
 * word in a hairline pill.
 *
 * ## Why this exists
 *
 * Every state on /welcome is rendered this way — `● Working` beside an
 * agent, beside a work item, in the run list. It is the page's single most
 * repeated product-UI device. The product was printing the same facts as
 * bare text ("Not connected", "Idle", a status word in a table cell), so
 * the one visual element a visitor would recognise immediately on opening
 * the app was missing from it.
 *
 * ## Why it takes a tone rather than a colour
 *
 * `AgentVisualTone` already exists and already has exactly one answer to
 * "what colour is a working agent / a finished one / a broken one", shared
 * by the world, the canvas and the panels (see agent-tone.ts). Taking a
 * tone keeps this inside that system instead of starting a second one, and
 * means a pill can never disagree with the figure it sits next to.
 *
 * ## The dot
 *
 * Non-negotiable as a *second* carrier: `accessibility.md` asks that
 * nothing be conveyed by colour alone, and the label beside the dot is
 * what satisfies that. The dot's job is to make state scannable down a
 * column, not to carry it.
 *
 * Only the `live` tone animates, and only then. That is the landing page's
 * own rule — its single looping animation attaches to a working run and
 * nothing else, because "an idle page should be still" — and `motion.md`
 * says the same thing more generally. A pulsing dot on a finished run
 * would be motion asserting something untrue.
 */
export function AgentStatusPill({
  tone,
  label,
  className,
  /** Set for a status with no matching visual state, e.g. a connector that is merely not connected. */
  quiet = false,
}: {
  tone: AgentVisualTone
  label: string
  className?: string
  quiet?: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-meta whitespace-nowrap",
        quiet ? "bg-transparent" : "bg-surface-hover",
        AGENT_TONE_TEXT_CLASS[tone],
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          // `agent-pulse` is the existing "live, in progress" keyframe —
          // an opacity fade, so a row of pills never reflows while one is
          // running. globals.css collapses its duration under reduced
          // motion, which leaves the dot simply present.
          tone === "live" && "animate-[agent-pulse_2s_var(--ease-standard)_infinite]"
        )}
      />
      {label}
    </span>
  )
}
