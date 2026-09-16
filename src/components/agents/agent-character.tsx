"use client"

import { memo } from "react"
import { useAgentMotion } from "@/hooks/use-agent-motion"
import { animationStyle } from "@/lib/agents/visual/animation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { DEFAULT_WORLD_CHARACTER } from "@/lib/agents/visual/registry"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"
import { markColor } from "./agent-tone"
import type { WorldAnimationIntensity } from "@/lib/agents/visual/animation"
import type { AgentVisualState, WorldCharacterConfig } from "@/lib/agents/visual/types"
import type { WorldAgentStyle } from "@/lib/agents/world/settings"

/**
 * An agent, as a figure.
 *
 * One parametric drawing rather than five sprite sheets. A character is
 * described by two independent choices:
 *
 *   - its **silhouette**, which belongs to the provider's identity and does
 *     not change (see `WorldCharacterConfig`);
 *   - its **style**, which belongs to the user and applies to every agent at
 *     once (Settings → Agent World → Agent style).
 *
 * Crossing the two is what makes five styles affordable: each style decides
 * how a shape is *drawn* — pixel-aligned rectangles, soft rounded forms,
 * angular outlines — and each silhouette decides what shape the head is. A
 * new provider picks a silhouette and inherits all five styles; a new style
 * is written once and applies to every provider.
 *
 * ## Why it is SVG and not canvas
 *
 * Every figure is a handful of vector nodes in a 40×48 viewBox, positioned by
 * a transform on its wrapper. That makes the world real DOM: a character is
 * focusable, has an accessible name, can be reached by Tab, and is announced
 * by a screen reader — all of which a canvas would have had to reimplement
 * from nothing, and most canvas visualisations never do.
 */

export type AgentCharacterProps = {
  connector: string
  state: AgentVisualState
  /** Overrides the identity's own silhouette. Rarely needed; the settings preview uses it. */
  config?: WorldCharacterConfig
  style?: WorldAgentStyle
  /** Rendered height in pixels. Width follows the viewBox ratio. */
  size?: number
  /** The world's animation intensity, so a character obeys the same policy as everything else. */
  intensity?: WorldAnimationIntensity
  /** False to draw the figure without its state animation (Settings → Effects → Status animation). */
  animate?: boolean
  className?: string
}

/** The drawing grid. Everything below is expressed in these units. */
const VIEW_WIDTH = 40
const VIEW_HEIGHT = 48

/**
 * Head geometry per silhouette.
 *
 * Each returns a single path so every style can render it with its own
 * stroke, fill and corner treatment without knowing which shape it is.
 */
function headPath(silhouette: WorldCharacterConfig["silhouette"], sharp: boolean): string {
  // All four fit a 13-unit box between x 13.5 and 26.5, narrower than the
  // 16-unit body below. The first pass had it the other way round and every
  // figure read as a bobblehead; a head that sits inside its shoulders is
  // what makes these read as workers rather than as toys.
  switch (silhouette) {
    case "beacon":
      // A tower with a peak — reads as "signal" at any size.
      return sharp
        ? "M20 4 L26.5 10 L26.5 20 L13.5 20 L13.5 10 Z"
        : "M20 4.2 C23 6 26 8.5 26.5 11 L26.5 18 Q26.5 20 24.5 20 L15.5 20 Q13.5 20 13.5 18 L13.5 11 C14 8.5 17 6 20 4.2 Z"
    case "prism":
      // A hexagon on its point.
      return "M20 4 L26.5 8.5 L26.5 15.5 L20 20 L13.5 15.5 L13.5 8.5 Z"
    case "chevron":
      // A wedge leaning forward.
      return sharp
        ? "M13.5 20 L13.5 10 L20 4.5 L26.5 10 L26.5 20 L20 16.8 Z"
        : "M13.8 19.6 Q13.5 11 20 4.8 Q26.5 11 26.2 19.6 Q20 17 13.8 19.6 Z"
    case "orb":
    default:
      return sharp
        ? "M13.5 5 L26.5 5 L26.5 20 L13.5 20 Z"
        : "M20 5.2 A6.6 6.6 0 1 1 19.99 5.2 Z"
  }
}

/**
 * The tool a character holds while it is working.
 *
 * Drawn only in the states that mean work is happening, so picking one up is
 * itself a signal. A character at rest is empty-handed.
 */
function Accessory({ kind }: { kind: WorldCharacterConfig["accessory"] }) {
  switch (kind) {
    case "terminal":
      return <rect x={29} y={26} width={8} height={7} rx={1.4} />
    case "lens":
      return (
        <>
          <circle cx={32.5} cy={28.5} r={3.4} />
          <path d="M35 31 L37.5 33.5" />
        </>
      )
    case "quill":
      return <path d="M30 33 L36 25 L37 27.5 L32 33.5 Z" />
    case "spark":
      return <path d="M32.5 24.5 L34 28 L37.5 29.5 L34 31 L32.5 34.5 L31 31 L27.5 29.5 L31 28 Z" />
    case "none":
    default:
      return null
  }
}

/** States in which a character is holding its tool. */
const WORKING_STATES: readonly AgentVisualState[] = ["working", "thinking", "communicating"]

function AgentCharacterImpl({
  connector,
  state,
  config,
  style = "character",
  size = 48,
  intensity,
  animate = true,
  className,
}: AgentCharacterProps) {
  const identity = agentVisualIdentity(connector)
  const character = config ?? identity.character ?? DEFAULT_WORLD_CHARACTER
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[state]
  const policy = useAgentMotion(intensity)
  const color = markColor(identity.accentColor, presentation.tone)

  // The minimal style is not a figure at all — it is the provider's mark, at
  // character size. Someone who chose it wants the world's arrangement
  // without the anthropomorphism, and drawing a small body anyway would be
  // ignoring the setting.
  if (style === "minimal") {
    return (
      <AgentIcon
        connector={connector}
        state={state}
        size="lg"
        intensity={intensity}
        className={className}
      />
    )
  }

  const sharp = style === "pixel" || style === "futuristic"
  const width = (size * VIEW_WIDTH) / VIEW_HEIGHT

  return (
    <span
      className={cn("agent-mark inline-block", className)}
      data-agent-state={state}
      data-agent-provider={connector}
      style={{
        color,
        // Scale is the identity's own, multiplied by nothing here — the
        // world's own agent-scale setting is applied to the wrapper, so this
        // component stays a pure drawing at whatever size it is given.
        ...(animate ? animationStyle(identity, state, policy) : {}),
      }}
      aria-hidden
    >
      <svg
        width={width * character.scale}
        height={size * character.scale}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={sharp ? 1.8 : 1.6}
        strokeLinecap={sharp ? "butt" : "round"}
        strokeLinejoin={sharp ? "miter" : "round"}
        focusable={false}
      >
        {/* Ground shadow. Anchors the figure to the floor so a character
            standing at a station does not read as floating over it. Absent in
            the pixel style, which has no soft shapes at all. */}
        {style !== "pixel" && (
          <ellipse
            cx={20}
            cy={45}
            rx={11}
            ry={2.6}
            fill="currentColor"
            stroke="none"
            opacity={0.16}
          />
        )}

        {/* Body. Wider than the head, with shoulders that taper in at the top. */}
        {style === "pixel" ? (
          <rect x={12} y={22} width={16} height={20} fill="currentColor" opacity={0.2} stroke="currentColor" />
        ) : (
          <path
            d={
              style === "futuristic"
                ? "M12 42 L12 27 L20 22 L28 27 L28 42 Z"
                : "M12 42 L12 28 Q12 22 20 22 Q28 22 28 28 L28 42 Z"
            }
            fill="currentColor"
            fillOpacity={style === "illustrated" ? 0.22 : 0.14}
          />
        )}

        {/* Head. */}
        <path
          d={headPath(character.silhouette, sharp)}
          fill="currentColor"
          fillOpacity={style === "illustrated" ? 0.3 : style === "pixel" ? 0.24 : 0.18}
        />

        {/* The face. A level visor rather than eyes or a mouth: these are
            programs, and two dots would push the whole thing toward a cartoon
            — which §24 asks it not to be. Level, too, because the first pass
            curved it and every idle agent looked glum. */}
        <path
          d="M16.5 12.6 L23.5 12.6"
          strokeWidth={style === "futuristic" ? 2.4 : 1.8}
        />

        {/* Illustrated gets one highlight: a soft edge along the head's upper
            left. It is the only piece of shading in the whole system, and it
            is what makes that style read as drawn rather than as diagrammed. */}
        {style === "illustrated" && (
          <path d="M15 10 Q16.5 6.5 20 5.4" strokeWidth={1.4} opacity={0.6} />
        )}

        {/* Futuristic gets a base glow bar instead — same job, opposite
            vocabulary. */}
        {style === "futuristic" && (
          <path d="M13.5 42.5 L26.5 42.5" strokeWidth={2.2} opacity={0.75} />
        )}

        {/* The tool, only while working. */}
        {(WORKING_STATES as readonly string[]).includes(state) && (
          <g data-agent-orbit>
            <Accessory kind={character.accessory} />
          </g>
        )}
      </svg>
    </span>
  )
}

/**
 * Memoised, and necessarily.
 *
 * The world re-renders whenever any run changes, and a scene of twenty
 * characters would otherwise redraw twenty SVGs because one of them moved.
 * Every prop is a primitive except `config`, which comes from the identity
 * registry and is therefore referentially stable.
 */
export const AgentCharacter = memo(AgentCharacterImpl)
AgentCharacter.displayName = "AgentCharacter"
