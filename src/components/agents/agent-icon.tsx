"use client"

import { memo } from "react"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { AGENT_ICON_PIXELS } from "@/lib/agents/visual/types"
import { cn } from "@/lib/utils"
import { markColor } from "./agent-tone"
import type { AgentIconSize, AgentVisualState } from "@/lib/agents/visual/types"

/**
 * One agent's mark, in one state.
 *
 * The primitive the whole feature is built from, and the only component in
 * the product that knows how a provider is drawn. Everything else — the
 * sidebar strip, the activity list, the settings page, the search results —
 * renders this and passes a provider string and a state.
 *
 *     <AgentIcon connector="claude-code" state="working" size="sm" />
 *
 * Callers never import a mark and never look up an identity. That is what
 * makes adding a provider a change to one catalogue entry instead of a sweep
 * through the UI.
 *
 * ## What it guarantees
 *
 * - **It always renders.** An unknown provider gets the fallback identity
 *   (see registry.ts). There is no path here that throws, and none that
 *   returns null.
 * - **It does not move.** The mark is a static drawing. State is carried by
 *   tone and by the words beside it, never by motion — which is what the
 *   command centre wants and what a dense list can afford to repeat a
 *   hundred times.
 * - **It is never the only carrier of state.** The mark is decorative by
 *   default; a caller that shows the icon *without* an adjacent status word
 *   passes `label`, and the icon then announces both who and what. See
 *   `AgentStatus` for the paired form.
 */

export type AgentIconProps = {
  /** Provider id. A string, not a union — the domain stores it opaquely, and unknown values fall back. */
  connector: string
  /** Defaults to `idle`, which is what an agent with nothing to report is. */
  state?: AgentVisualState
  size?: AgentIconSize
  /**
   * An accessible name for the mark.
   *
   * Absent by default, and absent is right whenever the agent's name is
   * already beside it — a screen reader announcing "Claude Code, Claude
   * Code" is worse than one announcing it once. Pass it when the icon stands
   * alone.
   */
  label?: string
  className?: string
  /**
   * Draw the mark in the provider's identity colour. Off by default: in the
   * product a mark identifies who, in the surrounding ink, and state is
   * carried by the status glyph and its words — a row of five brand colours
   * is exactly the noise the interface is built to avoid. A failure still
   * turns the mark destructive, because that is information.
   */
  colored?: boolean
}

function AgentIconImpl({
  connector,
  state = "idle",
  size = "sm",
  label,
  className,
  colored = false,
}: AgentIconProps) {
  const identity = agentVisualIdentity(connector)
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[state]
  const pixels = AGENT_ICON_PIXELS[size]

  // The richer drawing only where there is room for it. An identity without
  // one renders its single mark at every size rather than a gap.
  const Mark = size === "lg" && identity.detailedIcon ? identity.detailedIcon : identity.icon

  return (
    <span
      // Kept as attributes rather than classes so that a stylesheet or a
      // test can select on "this provider" or "this state" without the
      // component having to enumerate the cross-product as class names.
      data-agent-state={state}
      data-agent-provider={connector}
      className={cn("agent-mark inline-flex shrink-0 items-center justify-center", className)}
      style={{
        color: colored
          ? markColor(identity.accentColor, presentation.tone)
          : presentation.tone === "bad"
            ? "var(--destructive)"
            : "currentColor",
      }}
      {...(label ? {} : { "aria-hidden": true })}
    >
      <Mark size={pixels} title={label} />
    </span>
  )
}

/**
 * Memoised, and it matters.
 *
 * A workspace with twenty live agents renders this several times per agent —
 * once in the strip, once in the activity list, once in the session header.
 * The props are all primitives, so the default shallow comparison is exactly
 * right, and a poll that changes one run's status re-renders one icon rather
 * than all sixty.
 */
export const AgentIcon = memo(AgentIconImpl)
AgentIcon.displayName = "AgentIcon"
