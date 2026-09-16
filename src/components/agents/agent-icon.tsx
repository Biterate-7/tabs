"use client"

import { memo } from "react"
import { useAgentMotion } from "@/hooks/use-agent-motion"
import { animationStyle } from "@/lib/agents/visual/animation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { AGENT_ICON_PIXELS } from "@/lib/agents/visual/types"
import { cn } from "@/lib/utils"
import { markColor } from "./agent-tone"
import type { WorldAnimationIntensity } from "@/lib/agents/visual/animation"
import type { AgentIconSize, AgentVisualState } from "@/lib/agents/visual/types"

/**
 * One agent's mark, in one state.
 *
 * The primitive the whole feature is built from, and the only component in
 * the product that knows how a provider is drawn. Everything else — the
 * sidebar strip, the activity list, the world, the settings page, the search
 * results — renders this and passes a provider string and a state.
 *
 *     <AgentIcon connector="claude-code" state="working" size="sm" />
 *
 * Callers never import a mark, never look up an identity, and never decide
 * whether something should animate. That is what makes adding a provider a
 * change to one catalogue entry instead of a sweep through the UI.
 *
 * ## What it guarantees
 *
 * - **It always renders.** An unknown provider gets the fallback identity
 *   (see registry.ts). There is no path here that throws, and none that
 *   returns null.
 * - **It never animates when motion is off.** The policy is resolved once,
 *   through the same hook every agent surface uses, and a policy of `none`
 *   produces an element with no `animation-name` at all.
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
  /** The world's animation intensity, when this icon is inside the world. */
  intensity?: WorldAnimationIntensity
  className?: string
}

function AgentIconImpl({
  connector,
  state = "idle",
  size = "sm",
  label,
  intensity,
  className,
}: AgentIconProps) {
  const identity = agentVisualIdentity(connector)
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[state]
  const policy = useAgentMotion(intensity)
  const pixels = AGENT_ICON_PIXELS[size]

  // The richer drawing only where there is room for it. An identity without
  // one renders its single mark at every size rather than a gap.
  const Mark = size === "lg" && identity.detailedIcon ? identity.detailedIcon : identity.icon

  return (
    <span
      // Read by the CSS that animates the mark's inner `data-agent-orbit`
      // element. Keeping the state on an attribute rather than in a class
      // means one stylesheet rule per state instead of one per state per
      // provider.
      data-agent-state={state}
      data-agent-provider={connector}
      className={cn("agent-mark inline-flex shrink-0 items-center justify-center", className)}
      style={{
        color: markColor(identity.accentColor, presentation.tone),
        ...animationStyle(identity, state, policy),
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
 * once in the strip, once in the activity list, once in the world. The props
 * are all primitives, so the default shallow comparison is exactly right, and
 * a poll that changes one run's status re-renders one icon rather than all
 * sixty.
 */
export const AgentIcon = memo(AgentIconImpl)
AgentIcon.displayName = "AgentIcon"
