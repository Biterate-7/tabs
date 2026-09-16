"use client"

import { memo } from "react"
import { CHARACTER_FOOTPRINT } from "@/lib/agents/world/layout"
import { cn } from "@/lib/utils"
import type { AgentWorldSettings } from "@/lib/agents/world/settings"
import type { WorldCharacter, WorldDecor, WorldHandoff, WorldScene } from "@/lib/agents/world/types"

/**
 * The backdrop: scenery, station labels, and the lines between agents.
 *
 * One SVG behind the characters, drawn in a fixed user space so that shapes
 * keep their proportions at every stage size. Normalised 0..1 coordinates
 * from the layout engine are multiplied up into that space here, and nowhere
 * else — everything upstream stays resolution-free.
 *
 * Nothing in this file is interactive. The scenery is `aria-hidden` in its
 * entirety, because a screen reader announcing "bench, bench, plant, rack"
 * would be noise standing between someone and the agents they came for. The
 * agents themselves are real buttons, rendered above this by `AgentWorld`.
 */

/** The SVG user space. 5:3, which is the shape a sidebar panel and a phone both tolerate. */
export const STAGE_WIDTH = 1000
export const STAGE_HEIGHT = 600

export function toStageX(x: number): number {
  return x * STAGE_WIDTH
}

export function toStageY(y: number): number {
  return y * STAGE_HEIGHT
}

/**
 * One piece of scenery.
 *
 * Every kind is drawn from the same two primitives — a rounded rectangle and
 * a line — because scenery that competed for attention with the agents would
 * defeat the purpose of drawing agents. Colour comes entirely from theme
 * tokens, so the world re-skins with the user's theme without a per-theme
 * palette of its own.
 */
function Decor({ item, ambient }: { item: WorldDecor; ambient: boolean }) {
  const x = toStageX(item.x)
  const y = toStageY(item.y)
  const width = toStageX(item.width)
  const height = toStageY(item.height)

  const radius = item.kind === "tower" || item.kind === "block" ? 6 : item.kind === "panel" ? 18 : 4

  return (
    <g
      className={cn(item.ambient && ambient && "agent-world-ambient")}
      opacity={item.kind === "panel" ? 0.3 : 0.45}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={radius}
        fill="var(--background-tertiary)"
        stroke="var(--border-subtle)"
        strokeWidth={1.5}
      />
      {/* A single interior line gives a shape its character — shelves on a
          rack, a sill on a window, a screen's bezel — without adding a second
          drawing per kind. */}
      {(item.kind === "rack" || item.kind === "window" || item.kind === "screen") && (
        <line
          x1={x + width * 0.12}
          y1={y + height * 0.55}
          x2={x + width * 0.88}
          y2={y + height * 0.55}
          stroke="var(--border-subtle)"
          strokeWidth={1.5}
        />
      )}
      {item.kind === "plant" && (
        <line
          x1={x + width / 2}
          y1={y}
          x2={x + width / 2}
          y2={y + height}
          stroke="var(--border-subtle)"
          strokeWidth={1.5}
        />
      )}
    </g>
  )
}

/**
 * A line between two agents that shared work.
 *
 * Drawn faintly by default and brightly when either end is selected — the
 * same emphasis rule the graph canvas already follows, so a world with a
 * dozen connections stays legible while one neighbourhood is in focus.
 *
 * The travelling dot is the "packet" §11 asks for, and it appears only when
 * particles are on. It moves between two explicit points supplied as custom
 * properties, so one keyframe rule in globals.css serves every link.
 */
function HandoffLink({
  handoff,
  from,
  to,
  emphasized,
  particles,
  animate,
}: {
  handoff: WorldHandoff
  from: WorldCharacter
  to: WorldCharacter
  emphasized: boolean
  particles: boolean
  animate: boolean
}) {
  const x1 = toStageX(from.x)
  // Lines meet the figures at chest height rather than at their feet, which
  // is where the layout coordinate sits.
  const y1 = toStageY(from.y) - 26
  const x2 = toStageX(to.x)
  const y2 = toStageY(to.y) - 26

  return (
    <g data-agent-handoff={handoff.id} opacity={emphasized ? 0.9 : 0.3}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="var(--graph-edge)"
        strokeWidth={emphasized ? 2 : 1.5}
        strokeDasharray="6 6"
        className={cn(animate && "agent-world-flow")}
      />
      {particles && animate && (
        <circle
          r={4}
          fill="var(--graph-edge)"
          className="agent-world-packet"
          style={
            {
              "--packet-x1": `${x1}px`,
              "--packet-y1": `${y1}px`,
              "--packet-x2": `${x2}px`,
              "--packet-y2": `${y2}px`,
            } as React.CSSProperties
          }
        >
          {/* The relationship in words, for anything that reads the SVG. The
              same sentence appears in the selected agent's detail card, which
              is where a keyboard user actually encounters it. */}
          <title>{`${from.agentName} ${handoff.label} with ${to.agentName}`}</title>
        </circle>
      )}
    </g>
  )
}

export type AgentWorldStageProps = {
  scene: WorldScene
  settings: AgentWorldSettings
  /** The selected character, so its connections can be emphasised. */
  selectedId: string | null
  /** False when the resolved motion policy is `none`. */
  animate: boolean
}

function AgentWorldStageImpl({ scene, settings, selectedId, animate }: AgentWorldStageProps) {
  const { theme, characters, handoffs } = scene
  const byId = new Map(characters.map((character) => [character.id, character]))

  // Station labels are detail, and detail is what `density` controls. At
  // `minimal` the world is figures on an empty floor, which is the right
  // amount of information for a strip at the bottom of a sidebar.
  const showLabels = settings.density === "detailed"
  const occupied = new Set(scene.occupiedStationIds)

  return (
    <svg
      viewBox={`0 0 ${STAGE_WIDTH} ${STAGE_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 h-full w-full"
      // Scenery is decoration. Everything a screen reader needs is on the
      // character buttons above it.
      aria-hidden
      focusable={false}
    >
      {settings.effects.scenery &&
        theme.decor.map((item) => (
          <Decor key={item.id} item={item} ambient={animate && settings.effects.ambientLife} />
        ))}

      {settings.effects.handoffTrails &&
        handoffs.map((handoff) => {
          const from = byId.get(handoff.fromCharacterId)
          const to = byId.get(handoff.toCharacterId)
          if (!from || !to) return null

          return (
            <HandoffLink
              key={handoff.id}
              handoff={handoff}
              from={from}
              to={to}
              emphasized={
                selectedId === handoff.fromCharacterId || selectedId === handoff.toCharacterId
              }
              particles={settings.effects.particles}
              animate={animate}
            />
          )
        })}

      {/*
        Labels sit ABOVE the station, clear of its occupants' heads.

        Below was the obvious place and was wrong: rows grow downward from a
        station's line, so a busy desk drew its own label through the second
        row of figures. Above is bounded — `TOP_MARGIN` guarantees no station
        sits within a character height of the stage top, which leaves exactly
        the room a caption needs.
      */}
      {showLabels &&
        theme.stations
          .filter((station) => occupied.has(station.id))
          .map((station) => (
            <text
              key={station.id}
              x={toStageX(station.x)}
              y={toStageY(station.y - CHARACTER_FOOTPRINT.height) - 8}
              textAnchor="middle"
              fill="var(--text-tertiary)"
              fontSize={14}
              fontFamily="var(--tabdump-font-mono)"
            >
              {station.label}
            </text>
          ))}
    </svg>
  )
}

export const AgentWorldStage = memo(AgentWorldStageImpl)
AgentWorldStage.displayName = "AgentWorldStage"
