"use client"

import { memo } from "react"
import {
  FIXTURE_RENDER,
  FIXTURE_TIER,
  ROOM_WALL_HEIGHT,
  byDepth,
  fixtureHeight,
} from "@/lib/agents/world/architecture"
import {
  HALF_HEIGHT,
  HALF_WIDTH,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  boxFaces,
  projectPlan,
  rectPoints,
} from "@/lib/agents/world/projection"
import { cn } from "@/lib/utils"
import type { WorldFixture, WorldRoom } from "@/lib/agents/world/architecture"
import type { WorldDensity } from "@/lib/agents/world/settings"
import type { WorldTheme } from "@/lib/agents/world/types"

/**
 * The world itself: floor, rooms, furniture and sky.
 *
 * Everything here is scenery. It is `aria-hidden` in its entirety — a screen
 * reader announcing "desk, desk, plant, rack" would stand between someone and
 * the agents they came for — and nothing in it is interactive. The clickable
 * rooms are a separate, much thinner layer above this one
 * (`RoomLayer`, in agent-world-stage.tsx), which is what lets this be memoised on
 * four values that change once a session while occupancy changes every poll.
 *
 * ## Six primitives, and why not more
 *
 * A theme places a `server-rack` or a `plant`; this file knows only how to
 * draw a box, a flat polygon, a standing panel, a post, a plant and a
 * travelling box. Everything recognisable about a room comes from the
 * arrangement and the palette rather than from a bespoke drawing, which is
 * what keeps a fifth environment a data change. It is also what keeps the
 * node count honest: a full office floor is roughly 250 SVG nodes, painted
 * once and then left alone.
 *
 * ## Depth is the paint order, and nothing else
 *
 * There is no z-buffer and no sorting inside a shape. Rooms and fixtures are
 * drawn furthest-first, and because the projection's vertical axis *is* its
 * depth axis (see projection.ts), "further away" and "higher up the stage"
 * are the same statement. That is the whole of the 3D bookkeeping.
 */

/** Colour, as a world palette variable. The values live in globals.css. */
const TONE_FILL = {
  structure: {
    top: "var(--world-structure-top)",
    right: "var(--world-structure-right)",
    left: "var(--world-structure-left)",
  },
  surface: {
    top: "var(--world-surface-top)",
    right: "var(--world-surface-right)",
    left: "var(--world-surface-left)",
  },
  accent: {
    top: "var(--world-accent-top)",
    right: "var(--world-accent-right)",
    left: "var(--world-accent-left)",
  },
  glass: {
    top: "var(--world-glass-top)",
    right: "var(--world-glass-right)",
    left: "var(--world-glass-left)",
  },
  foliage: {
    top: "var(--world-foliage)",
    right: "var(--world-foliage)",
    left: "var(--world-foliage-dark)",
  },
} as const

const DETAIL_TIER: Record<WorldDensity, 0 | 1 | 2> = {
  minimal: 0,
  balanced: 1,
  detailed: 2,
}

/**
 * The stars.
 *
 * Generated once at module scope from a fixed seed rather than at render, for
 * the reason every other position in this feature is deterministic: a sky
 * that reshuffled on each poll would be the one part of the world that moved
 * for no reason. A linear congruential generator is plenty — nobody is going
 * to audit the distribution of a backdrop.
 */
const STARS = (() => {
  let seed = 0x5eed
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  return Array.from({ length: 70 }, () => ({
    x: Math.round(next() * STAGE_WIDTH),
    y: Math.round(next() * STAGE_HEIGHT * 0.72),
    r: Math.round((0.6 + next() * 1.6) * 10) / 10,
    o: Math.round((0.18 + next() * 0.5) * 100) / 100,
  }))
})()

/** How far the deck's underside hangs below the floor, in stage units. */
const DECK_DEPTH = 34

/**
 * The two visible faces of the slab under the floor.
 *
 * Drawn downward rather than upward, which `boxFaces` cannot express because
 * every other box in the world stands *on* the floor. It is four points twice
 * and not worth generalising the projection for.
 */
function deckSkirt(depth: number): { right: string; left: string } {
  const xCorner = projectPlan(1, 0)
  const near = projectPlan(1, 1)
  const yCorner = projectPlan(0, 1)

  return {
    right: [
      `${xCorner.x},${xCorner.y}`,
      `${near.x},${near.y}`,
      `${near.x},${near.y + depth}`,
      `${xCorner.x},${xCorner.y + depth}`,
    ].join(" "),
    left: [
      `${yCorner.x},${yCorner.y}`,
      `${near.x},${near.y}`,
      `${near.x},${near.y + depth}`,
      `${yCorner.x},${yCorner.y + depth}`,
    ].join(" "),
  }
}

/** One extruded box: the top face and the two the camera can see. */
function IsoBox({
  fixture,
  tone,
  glow,
  animate,
}: {
  fixture: WorldFixture
  tone: keyof typeof TONE_FILL
  glow: boolean
  animate: boolean
}) {
  const height = fixtureHeight(fixture)
  const faces = boxFaces(fixture.planX, fixture.planY, fixture.width, fixture.depth, height)
  const fill = TONE_FILL[tone]

  return (
    <g className={cn(fixture.ambient && animate && "agent-world-ambient")}>
      <polygon points={faces.left} fill={fill.left} />
      <polygon points={faces.right} fill={fill.right} />
      <polygon points={faces.top} fill={fill.top} stroke="var(--world-edge)" strokeWidth={0.75} />
      {/* A lit strip along the top of anything that glows. It is what makes a
          server rack read as powered and a tower as occupied, at one polygon
          rather than a window grid. */}
      {glow && (
        <polygon
          points={faces.right}
          fill="var(--world-glow)"
          opacity={0.22}
          className={cn(fixture.ambient && animate && "agent-world-screen")}
        />
      )}
    </g>
  )
}

/** A vertical panel standing on a rectangle's far edge: screens, boards, partitions. */
function IsoPanel({
  fixture,
  tone,
  glow,
  animate,
}: {
  fixture: WorldFixture
  tone: keyof typeof TONE_FILL
  glow: boolean
  animate: boolean
}) {
  const height = fixtureHeight(fixture)
  // A panel is a box with no depth to speak of, so it reuses the box faces
  // and simply does not draw the top: one code path, and a whiteboard that
  // sits in the same relation to its wall as a rack does.
  const faces = boxFaces(fixture.planX, fixture.planY, fixture.width, fixture.depth, height)
  const fill = TONE_FILL[tone]

  return (
    <g className={cn(fixture.ambient && animate && "agent-world-ambient")}>
      <polygon points={faces.left} fill={fill.left} />
      <polygon points={faces.right} fill={fill.right} stroke="var(--world-edge)" strokeWidth={0.6} />
      {glow && (
        <polygon
          points={faces.right}
          fill="var(--world-glow)"
          opacity={0.3}
          className={cn(animate && "agent-world-screen")}
        />
      )}
    </g>
  )
}

/** A plant: a pot, and a canopy over it. */
function IsoPlant({ fixture }: { fixture: WorldFixture }) {
  const base = projectPlan(
    fixture.planX + fixture.width / 2,
    fixture.planY + fixture.depth / 2
  )
  const height = fixtureHeight(fixture)
  const potWidth = Math.max(6, fixture.width * HALF_WIDTH * 0.7)

  return (
    <g>
      <ellipse
        cx={base.x}
        cy={base.y}
        rx={potWidth * 0.55}
        ry={potWidth * 0.28}
        fill="var(--world-structure-left)"
      />
      <ellipse
        cx={base.x}
        cy={base.y - height * 0.62}
        rx={potWidth * 0.82}
        ry={potWidth * 0.66}
        fill="var(--world-foliage)"
        opacity={0.85}
      />
      <ellipse
        cx={base.x - potWidth * 0.3}
        cy={base.y - height * 0.82}
        rx={potWidth * 0.45}
        ry={potWidth * 0.38}
        fill="var(--world-foliage-dark)"
        opacity={0.7}
      />
    </g>
  )
}

/** A thin upright: lamps, antennas, pillars. */
function IsoPost({
  fixture,
  glow,
  animate,
}: {
  fixture: WorldFixture
  glow: boolean
  animate: boolean
}) {
  const base = projectPlan(
    fixture.planX + fixture.width / 2,
    fixture.planY + fixture.depth / 2
  )
  const height = fixtureHeight(fixture)
  const width = Math.max(2.5, fixture.width * HALF_WIDTH * 0.35)

  return (
    <g className={cn(fixture.ambient && animate && "agent-world-ambient")}>
      <rect
        x={base.x - width / 2}
        y={base.y - height}
        width={width}
        height={height}
        fill="var(--world-structure-right)"
      />
      {glow && (
        <circle
          cx={base.x}
          cy={base.y - height}
          r={width * 1.5}
          fill="var(--world-glow)"
          opacity={0.5}
          className={cn(animate && "agent-world-screen")}
        />
      )}
    </g>
  )
}

/**
 * A small box that runs along a plan vector and back.
 *
 * The ambient life requirement, done the same way the handoff packet is: the
 * two endpoints are handed to one CSS keyframe as custom properties, so any
 * number of vehicles cost one composited transform each and not one timer
 * each. A vehicle with no `travel` simply parks, which is what a theme that
 * forgot the vector deserves and is still a perfectly good-looking crate.
 */
function IsoVehicle({ fixture, animate }: { fixture: WorldFixture; animate: boolean }) {
  const travel = fixture.travel
  const dx = travel ? (travel.dx - travel.dy) * HALF_WIDTH : 0
  const dy = travel ? (travel.dx + travel.dy) * HALF_HEIGHT : 0

  return (
    <g
      className={cn(animate && travel && "agent-world-vehicle")}
      style={
        travel
          ? ({
              "--vehicle-dx": `${Math.round(dx)}px`,
              "--vehicle-dy": `${Math.round(dy)}px`,
              "--vehicle-duration": `${travel.seconds}s`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <IsoBox fixture={fixture} tone="accent" glow animate={false} />
    </g>
  )
}

function Fixture({ fixture, animate }: { fixture: WorldFixture; animate: boolean }) {
  const render = FIXTURE_RENDER[fixture.kind]

  switch (render.shape) {
    case "flat":
      return (
        <polygon
          points={rectPoints(fixture.planX, fixture.planY, fixture.width, fixture.depth)}
          fill={TONE_FILL[render.tone].top}
          opacity={0.6}
          className={cn(fixture.ambient && animate && "agent-world-ambient")}
        />
      )
    case "screen":
      return (
        <IsoPanel
          fixture={fixture}
          tone={render.tone}
          glow={Boolean(render.glow)}
          animate={animate}
        />
      )
    case "post":
      return <IsoPost fixture={fixture} glow={Boolean(render.glow)} animate={animate} />
    case "plant":
      return <IsoPlant fixture={fixture} />
    case "vehicle":
      return <IsoVehicle fixture={fixture} animate={animate} />
    case "box":
    default:
      return (
        <IsoBox
          fixture={fixture}
          tone={render.tone}
          glow={Boolean(render.glow)}
          animate={animate}
        />
      )
  }
}

/** One room: its floor plate, its two back walls, and everything in it. */
function Room({
  room,
  tier,
  animate,
  ambient,
}: {
  room: WorldRoom
  tier: 0 | 1 | 2
  animate: boolean
  ambient: boolean
}) {
  const walls = room.walls
    ? boxFaces(room.planX, room.planY, room.width, room.depth, ROOM_WALL_HEIGHT)
    : null

  return (
    <g data-world-room={room.id}>
      {/*
        Three passes over one polygon, and each does a different job.

        A plate, so a room reads as a floor laid on the deck rather than as a
        tint printed on it. Then the accent, faint enough that eleven rooms
        read as one building rather than as a colour chart. Then an edge,
        which is what actually makes the rooms countable at a glance — the
        fill alone disappears at a distance and the line does not.
      */}
      <polygon
        points={rectPoints(room.planX, room.planY, room.width, room.depth)}
        fill="var(--world-room-plate)"
      />
      <polygon
        points={rectPoints(room.planX, room.planY, room.width, room.depth)}
        fill={`var(--world-accent-${room.accent})`}
        opacity={0.16}
      />
      <polygon
        points={rectPoints(room.planX, room.planY, room.width, room.depth)}
        fill="none"
        stroke={`var(--world-accent-${room.accent})`}
        strokeWidth={1.5}
        opacity={0.55}
      />

      {walls && (
        <>
          {/* Only the two far edges, so the room is cut away towards the
              camera and you can see who is in it. */}
          <polygon
            points={wallAlongY(room)}
            fill="var(--world-wall)"
            stroke="var(--world-edge)"
            strokeWidth={0.6}
          />
          <polygon
            points={wallAlongX(room)}
            fill="var(--world-wall-shade)"
            stroke="var(--world-edge)"
            strokeWidth={0.6}
          />
        </>
      )}

      {room.fixtures
        .filter((fixture) => FIXTURE_TIER[fixture.kind] <= tier)
        .filter((fixture) => (fixture.kind === "vehicle" ? ambient : true))
        .slice()
        .sort(byDepth)
        .map((fixture) => (
          <Fixture key={fixture.id} fixture={fixture} animate={animate && ambient} />
        ))}
    </g>
  )
}

/** The wall standing on a room's low-y edge, seen from inside. */
function wallAlongX(room: WorldRoom): string {
  const a = projectPlan(room.planX, room.planY)
  const b = projectPlan(room.planX + room.width, room.planY)
  return [
    `${a.x},${a.y - ROOM_WALL_HEIGHT}`,
    `${b.x},${b.y - ROOM_WALL_HEIGHT}`,
    `${b.x},${b.y}`,
    `${a.x},${a.y}`,
  ].join(" ")
}

/** The wall standing on a room's low-x edge. */
function wallAlongY(room: WorldRoom): string {
  const a = projectPlan(room.planX, room.planY)
  const b = projectPlan(room.planX, room.planY + room.depth)
  return [
    `${a.x},${a.y - ROOM_WALL_HEIGHT}`,
    `${b.x},${b.y - ROOM_WALL_HEIGHT}`,
    `${b.x},${b.y}`,
    `${a.x},${a.y}`,
  ].join(" ")
}

export type AgentWorldSceneryProps = {
  theme: WorldTheme
  density: WorldDensity
  /** False when the user has turned scenery off: only the floor is drawn. */
  scenery: boolean
  /** False when ambient life is off: nothing moves, and nothing travels. */
  ambient: boolean
  /** False when the resolved motion policy is `none`. */
  animate: boolean
}

function AgentWorldSceneryImpl({
  theme,
  density,
  scenery,
  ambient,
  animate,
}: AgentWorldSceneryProps) {
  const tier = DETAIL_TIER[density]
  const skirt = deckSkirt(DECK_DEPTH)

  return (
    <g aria-hidden>
      {/* ---- The deck ------------------------------------------------------ */}
      <g>
        <polygon points={skirt.left} fill="var(--world-deck-left)" />
        <polygon points={skirt.right} fill="var(--world-deck-right)" />
        <polygon
          points={rectPoints(0, 0, 1, 1)}
          fill="var(--world-floor)"
          stroke="var(--world-rim)"
          strokeWidth={1.5}
        />
        {tier >= 1 && (
          <g stroke="var(--world-floor-line)" strokeWidth={0.8} opacity={0.85}>
            {Array.from({ length: 9 }, (_, index) => {
              const t = (index + 1) / 10
              const a = projectPlan(t, 0)
              const b = projectPlan(t, 1)
              const c = projectPlan(0, t)
              const d = projectPlan(1, t)
              return (
                <g key={t}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  <line x1={c.x} y1={c.y} x2={d.x} y2={d.y} />
                </g>
              )
            })}
          </g>
        )}
      </g>

      {scenery && (
        <>
          {/* ---- Behind everything: skyline, trusses, corridor props ------- */}
          <g>
            {theme.backdrop
              .filter((fixture) => FIXTURE_TIER[fixture.kind] <= tier)
              .filter((fixture) => (fixture.kind === "vehicle" ? ambient : true))
              .slice()
              .sort(byDepth)
              .map((fixture) => (
                <Fixture key={fixture.id} fixture={fixture} animate={animate && ambient} />
              ))}
          </g>

          {/* ---- The rooms, furthest first -------------------------------- */}
          {theme.rooms
            .slice()
            .sort(byDepth)
            .map((room) => (
              <Room
                key={room.id}
                room={room}
                tier={tier}
                animate={animate}
                ambient={ambient}
              />
            ))}
        </>
      )}
    </g>
  )
}

/**
 * Memoised on five primitives.
 *
 * The point of the split: a poll that changes one run's status re-renders the
 * character layer and the room overlay, and does not touch the two hundred
 * nodes that make up the building. None of these five values changes unless
 * the user changes a setting.
 */
export const AgentWorldScenery = memo(AgentWorldSceneryImpl)
AgentWorldScenery.displayName = "AgentWorldScenery"

/**
 * What is behind the world, rather than in it.
 *
 * Drawn on the stage and **outside** the camera, which is the whole reason it
 * is a separate component: a sky that panned with the floor would read as a
 * painted backdrop being dragged around, and the stars would slide off the
 * edge of a world they are supposed to be behind. It also fills the space
 * around a world that does not fill its box, so a wide screen shows a
 * headquarters sitting in something rather than a model on a blank panel.
 *
 * The gradient itself is a CSS background on the stage. Only what the
 * gradient cannot do — stars, and a planet — is drawn here.
 */
function WorldSkyImpl({ setting }: { setting: "interior" | "exterior" }) {
  if (setting !== "exterior") return null

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${STAGE_WIDTH} ${STAGE_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable={false}
    >
      {STARS.map((star, index) => (
        <circle
          key={index}
          cx={star.x}
          cy={star.y}
          r={star.r}
          fill="var(--world-star)"
          opacity={star.o}
        />
      ))}
      {/*
        A gas giant behind the deck, cropped by the stage. Original geometry
        rather than anything copied: a circle, a ring, and the same palette
        the rest of the world uses.
      */}
      <g opacity={0.45}>
        <circle cx={930} cy={660} r={165} fill="var(--world-planet)" />
        <ellipse
          cx={930}
          cy={660}
          rx={250}
          ry={38}
          fill="none"
          stroke="var(--world-planet-ring)"
          strokeWidth={11}
          opacity={0.55}
          transform="rotate(-16 930 660)"
        />
      </g>
    </svg>
  )
}

export const WorldSky = memo(WorldSkyImpl)
WorldSky.displayName = "WorldSky"
