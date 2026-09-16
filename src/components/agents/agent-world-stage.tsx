"use client"

import { memo } from "react"
import { byDepth } from "@/lib/agents/world/architecture"
import {
  STAGE_HEIGHT,
  STAGE_WIDTH,
  contentBoxFor,
  projectPlan,
  rectPoints,
} from "@/lib/agents/world/projection"
import { cn } from "@/lib/utils"
import { AgentWorldScenery } from "./agent-world-scenery"
import type { WorldRoom } from "@/lib/agents/world/architecture"
import type { AgentWorldSettings, WorldDensity } from "@/lib/agents/world/settings"
import type { WorldCharacter, WorldHandoff, WorldScene } from "@/lib/agents/world/types"

/**
 * The stage: the world, the rooms you can click, and the lines between agents.
 *
 * One SVG in a fixed user space, so shapes keep their proportions at every
 * stage size. Its box is sized by `AgentWorld` to the world's own aspect
 * ratio, so `preserveAspectRatio` has nothing to correct and the mapping from
 * a normalised character coordinate to a pixel is a single multiplication —
 * which is what lets the DOM character layer land exactly on the desks this
 * SVG drew.
 *
 * ## Three layers, and why they are separate components
 *
 * `AgentWorldScenery` is the building: two hundred nodes that change when a
 * setting changes and at no other time, memoised so a poll never touches
 * them. `RoomLayer` is eleven transparent polygons that know who is standing
 * in them. `HandoffLink` is one line per observed transfer. Splitting them is
 * the whole of the render-cost story: what moves every few seconds is small,
 * and what is large does not move.
 */

export { STAGE_WIDTH, STAGE_HEIGHT }

/** Stage user-space coordinates from a character's normalised position. */
export function toStageX(x: number): number {
  return x * STAGE_WIDTH
}

export function toStageY(y: number): number {
  return y * STAGE_HEIGHT
}

/** How far above its feet a figure's chest is, in stage units. Where lines meet it. */
const CHEST_OFFSET = 19

/**
 * A line between two agents that shared work.
 *
 * Drawn faintly by default and brightly when either end is selected — the
 * same emphasis rule the graph canvas already follows, so a world with a
 * dozen connections stays legible while one neighbourhood is in focus.
 *
 * The travelling dot is the data packet, and it appears only when data
 * streams are on. It moves between two explicit points supplied as custom
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
  const y1 = toStageY(from.y) - CHEST_OFFSET
  const x2 = toStageX(to.x)
  const y2 = toStageY(to.y) - CHEST_OFFSET

  return (
    <g data-agent-handoff={handoff.id} opacity={emphasized ? 0.95 : 0.4}>
      {/* A soft under-stroke, so a thin dashed line stays visible over a
          floor plate as well as over open deck. */}
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="var(--world-sky-outer)"
        strokeWidth={emphasized ? 5 : 4}
        opacity={0.5}
      />
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

/**
 * The rooms, as things you can point at.
 *
 * Eleven transparent polygons over the scenery, each a button with a complete
 * accessible name: what the room is called, what it is for, and how many
 * agents are in it. §6 asks for exactly this and also for its opposite — that
 * decorative objects *not* be clickable — and the way both are guaranteed is
 * that this layer knows only about rooms. A desk cannot become a click target
 * because there is nowhere to write one.
 *
 * Clicking a room selects it; clicking a figure standing in that room selects
 * the figure instead, because the figure is a DOM button layered above this.
 */
function RoomLayer({
  rooms,
  occupancy,
  selectedRoomId,
  hoveredRoomId,
  onSelectRoom,
  onHoverRoom,
  showLabels,
}: {
  rooms: readonly WorldRoom[]
  occupancy: ReadonlyMap<string, number>
  selectedRoomId: string | null
  hoveredRoomId: string | null
  onSelectRoom: (roomId: string | null) => void
  onHoverRoom: (roomId: string | null) => void
  showLabels: boolean
}) {
  return (
    <g>
      {rooms
        .slice()
        .sort(byDepth)
        .map((room) => {
          const count = occupancy.get(room.id) ?? 0
          const selected = room.id === selectedRoomId
          const hovered = room.id === hoveredRoomId
          // The purpose is already a sentence, so it is joined rather than
          // punctuated again — "…each other.. 0 agents here" is what happens
          // when a label builder assumes its parts are fragments.
          const label = `${room.name}. ${room.purpose} ${
            count === 1 ? "1 agent here." : `${count} agents here.`
          }`

          return (
            <g
              key={room.id}
              role="button"
              tabIndex={0}
              aria-label={label}
              aria-pressed={selected}
              className="agent-world-room"
              onClick={() => onSelectRoom(selected ? null : room.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                onSelectRoom(selected ? null : room.id)
              }}
              onPointerEnter={() => onHoverRoom(room.id)}
              onPointerLeave={() => onHoverRoom(null)}
              onFocus={() => onHoverRoom(room.id)}
              onBlur={() => onHoverRoom(null)}
            >
              <polygon
                points={rectPoints(room.planX, room.planY, room.width, room.depth)}
                fill="transparent"
              />
              {(selected || hovered) && (
                <polygon
                  points={rectPoints(room.planX, room.planY, room.width, room.depth)}
                  fill={`var(--world-accent-${room.accent})`}
                  fillOpacity={selected ? 0.2 : 0.12}
                  stroke={`var(--world-accent-${room.accent})`}
                  strokeWidth={selected ? 2.5 : 1.75}
                />
              )}
            </g>
          )
        })}

      {/*
        Labels sit above the room's far corner, clear of everybody's head.

        Only occupied rooms are named, and only at detailed density. A world
        that labelled all eleven rooms at once would be a map with a legend
        printed over it, and the point of the environment is that a room is
        recognisable from what is in it.
      */}
      {showLabels &&
        rooms
          .filter((room) => (occupancy.get(room.id) ?? 0) > 0)
          .map((room) => {
            const anchor = projectPlan(room.planX + room.width / 2, room.planY)
            return (
              <text
                key={`${room.id}-label`}
                x={anchor.x}
                y={anchor.y - 30}
                textAnchor="middle"
                fill="var(--world-label)"
                fontSize={15}
                fontFamily="var(--tabdump-font-mono)"
                pointerEvents="none"
              >
                {room.name}
              </text>
            )
          })}
    </g>
  )
}

export type AgentWorldStageProps = {
  scene: WorldScene
  settings: AgentWorldSettings
  /** The density actually drawn at, after any responsive reduction. */
  density: WorldDensity
  /** The selected character, so its connections can be emphasised. */
  selectedId: string | null
  selectedRoomId: string | null
  hoveredRoomId: string | null
  onSelectRoom: (roomId: string | null) => void
  onHoverRoom: (roomId: string | null) => void
  /** False when the resolved motion policy is `none`. */
  animate: boolean
}

function AgentWorldStageImpl({
  scene,
  settings,
  density,
  selectedId,
  selectedRoomId,
  hoveredRoomId,
  onSelectRoom,
  onHoverRoom,
  animate,
}: AgentWorldStageProps) {
  const { theme, characters, handoffs } = scene
  const byId = new Map(characters.map((character) => [character.id, character]))

  // Who is where, counted once. Both the room buttons' accessible names and
  // the room labels read it, so the two cannot disagree.
  const occupancy = new Map<string, number>()
  for (const character of characters) {
    if (!character.roomId) continue
    occupancy.set(character.roomId, (occupancy.get(character.roomId) ?? 0) + 1)
  }

  const box = contentBoxFor(theme.setting)

  return (
    <svg
      // Cropped to what this kind of world actually occupies — see
      // STAGE_CONTENT_BOX. The pixel mapping in AgentWorld reads the same
      // box, so the DOM figures land exactly on the desks drawn here.
      viewBox={`0 ${box.y} ${STAGE_WIDTH} ${box.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 h-full w-full"
      focusable={false}
    >
      <AgentWorldScenery
        theme={theme}
        density={density}
        scenery={settings.effects.scenery}
        ambient={settings.effects.ambientLife}
        animate={animate}
      />

      <RoomLayer
        rooms={theme.rooms}
        occupancy={occupancy}
        selectedRoomId={selectedRoomId}
        hoveredRoomId={hoveredRoomId}
        onSelectRoom={onSelectRoom}
        onHoverRoom={onHoverRoom}
        showLabels={density === "detailed"}
      />

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
    </svg>
  )
}

export const AgentWorldStage = memo(AgentWorldStageImpl)
AgentWorldStage.displayName = "AgentWorldStage"
