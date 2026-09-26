"use client"

import { memo } from "react"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"
import { AGENT_TONE_TEXT_CLASS } from "./agent-tone"
import type { AgentIconSize, AgentVisualState } from "@/lib/agents/visual/types"

/**
 * The presence primitives.
 *
 * Three small components that between them cover every way an agent is
 * mentioned in this product: as a name, as a state, and as a mark. They exist
 * so that "show who is acting" is one import rather than a pattern each
 * surface re-implements — which is what the sidebar, the settings page and
 * the canvas were each doing differently before this phase.
 *
 * All three are presentational. None of them reads a store, subscribes to
 * anything, or holds state; everything they need arrives as props, and every
 * one is memoised because the surfaces that use them re-render on every poll.
 */

/**
 * An agent's mark and name together.
 *
 *     <AgentIdentity connector="claude-code" />
 *
 * The name comes from the visual identity, which reads it from the connector
 * descriptor — so this cannot disagree with the settings page about what an
 * agent is called. A caller that already has a name (a persisted `Agent.name`
 * from a build that knew a provider this one does not) passes it as `name`
 * and it wins, because the user's own history is more authoritative than this
 * build's catalogue.
 */
export type AgentIdentityProps = {
  connector: string
  state?: AgentVisualState
  size?: AgentIconSize
  /** Overrides the catalogue name. Used where the domain holds a name of its own. */
  name?: string
  /** Hides the name, leaving the mark. The mark then carries the accessible name itself. */
  iconOnly?: boolean
  className?: string
}

function AgentIdentityImpl({
  connector,
  state = "idle",
  size = "sm",
  name,
  iconOnly = false,
  className,
}: AgentIdentityProps) {
  const displayName = name ?? agentVisualIdentity(connector).displayName

  if (iconOnly) {
    return <AgentIcon connector={connector} state={state} size={size} label={displayName} className={className} />
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <AgentIcon connector={connector} state={state} size={size} />
      <span className="truncate">{displayName}</span>
    </span>
  )
}

export const AgentIdentity = memo(AgentIdentityImpl)
AgentIdentity.displayName = "AgentIdentity"

/**
 * An agent's state, in words.
 *
 * The accessibility backbone of the whole feature. Every animated mark in the
 * product has one of these within reach, because the rule this codebase
 * already follows — a glyph *and* a word, never colour alone — extends
 * naturally to motion: a state that could only be perceived as movement would
 * be invisible to anyone who has asked movement to stop.
 *
 * `srOnlyGlyph` is on by default: the glyph is decoration next to the word it
 * duplicates, and announcing "circle Working" helps nobody.
 */
export type AgentStatusProps = {
  /** Optional. When given, the agent's mark leads the status. */
  connector?: string
  state: AgentVisualState
  size?: AgentIconSize
  /** Extra detail after the state word — a task title, an activity line. */
  detail?: string
  className?: string
}

function AgentStatusImpl({ connector, state, size = "xs", detail, className }: AgentStatusProps) {
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[state]

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {connector !== undefined && <AgentIcon connector={connector} state={state} size={size} />}
      <span className={cn("inline-flex min-w-0 items-baseline gap-1", AGENT_TONE_TEXT_CLASS[presentation.tone])}>
        <span aria-hidden>{presentation.glyph}</span>
        <span className="truncate">
          {presentation.label}
          {detail ? <span className="text-tertiary"> · {detail}</span> : null}
        </span>
      </span>
    </span>
  )
}

export const AgentStatus = memo(AgentStatusImpl)
AgentStatus.displayName = "AgentStatus"

/**
 * An agent's mark on a tinted chip.
 *
 * For lists and rows where the mark needs a body of its own to sit in — the
 * activity feed, the world's detail card — rather than floating against the
 * page. The tint is the identity's accent at low opacity, which is why it is
 * applied as a `color-mix` against the surface rather than as a flat alpha: a
 * translucent chip over a themed background picks up whatever is behind it,
 * and in the graph sidebar that is a blurred canvas.
 */
export type AgentAvatarProps = {
  connector: string
  state?: AgentVisualState
  size?: AgentIconSize
  /** An accessible name, when the avatar stands alone. */
  label?: string
  className?: string
}

const AVATAR_BOX: Record<AgentIconSize, string> = {
  xs: "size-6",
  sm: "size-7",
  md: "size-9",
  lg: "size-11",
}

function AgentAvatarImpl({ connector, state = "idle", size = "sm", label, className }: AgentAvatarProps) {
  const identity = agentVisualIdentity(connector)

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border border-border",
        AVATAR_BOX[size],
        className
      )}
      style={{ backgroundColor: `color-mix(in oklch, ${identity.accentColor} 14%, transparent)` }}
    >
      <AgentIcon connector={connector} state={state} size={size} label={label} />
    </span>
  )
}

export const AgentAvatar = memo(AgentAvatarImpl)
AgentAvatar.displayName = "AgentAvatar"
