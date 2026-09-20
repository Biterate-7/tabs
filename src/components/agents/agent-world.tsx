"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bot, Crosshair, Locate, Minus, Plus } from "lucide-react"
import { useAgentMotion } from "@/hooks/use-agent-motion"
import { travelDurationMs } from "@/lib/agents/world/layout"
import {
  CHARACTER_HEIGHT_UNITS,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  contentBoxFor,
} from "@/lib/agents/world/projection"
import { roomById } from "@/lib/agents/world/themes"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AgentCharacter } from "./agent-character"
import { AgentWorldDetail } from "./agent-world-detail"
import { AgentWorldRoomDetail } from "./agent-world-room-detail"
import { WorldSky } from "./agent-world-scenery"
import { AgentWorldStage } from "./agent-world-stage"
import type { WorldCharacterDetail } from "./agent-world-detail"
import type { StageContentBox } from "@/lib/agents/world/projection"
import type { AgentWorldSettings, WorldDensity } from "@/lib/agents/world/settings"
import type { WorldCharacter, WorldScene } from "@/lib/agents/world/types"

/**
 * The Agent World.
 *
 * A place, with the agents that are actually working in it. Everything the
 * world shows is derived from observed state: a figure exists because a run
 * exists, it stands in the room it stands in because of what that run has
 * said and touched, and the lines between figures are transfers the domain
 * recorded. Nothing is decorative except the building.
 *
 * ## It is DOM, and that is the accessibility story
 *
 * Every agent is a `<button>` with a complete accessible name — who, what
 * state, what task, which room. Every room is a button too. Tab reaches them
 * in layout order, Enter opens the detail card, Escape closes it. A screen
 * reader user gets the same information a sighted one does, in the same
 * order, without the layout having to mean anything to them. That is the main
 * reason this is not a canvas.
 *
 * It is also the one constraint the isometric redesign had to work around
 * rather than through: a DOM figure always paints over the SVG behind it, so
 * nothing in the scenery may be both tall enough to hide somebody and nearer
 * the camera than they are. The themes are authored so it never happens and
 * `themes.test.ts` fails the build if one stops being.
 *
 * ## The camera
 *
 * `settings.camera` chooses the **default** framing — the whole world, the
 * active agents, everybody, or wherever you left it. On top of that, dragging,
 * the wheel, a pinch and the arrow keys all work in every mode, and taking
 * hold of the camera that way parks the automatic framing until Reset view
 * hands it back. A control called "Static" that refused to be nudged would be
 * a preference masquerading as a lock.
 */

export type AgentWorldProps = {
  scene: WorldScene
  settings: AgentWorldSettings
  /** What this world is called. Falls back to the theme's own name. */
  worldName?: string | null
  /** The scene's clock, for elapsed times. */
  now: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /**
   * Per-character detail, supplied by the host.
   *
   * A function rather than a prepared map so the host computes detail for the
   * one character that is open rather than for all of them. Callers should
   * memoise it; the world calls it during render for the selected character
   * only.
   */
  details?: (characterId: string) => WorldCharacterDetail | null
  /** Controls for the header — a customise button, a close button. */
  actions?: React.ReactNode
  /**
   * Takes the user to the connectors page, from the idle copy and from an
   * unconnected agent's detail card.
   *
   * Optional throughout. The world is rendered by surfaces that have no
   * navigation of their own, and every affordance that depends on this one
   * simply does not appear without it.
   */
  onOpenConnectors?: () => void
  /** Opens a drawn run's durable session. Threaded to the detail card. */
  onOpenSession?: (runId: string) => void
  /**
   * The shape of the stage box.
   *
   * The dedicated view gives the world the rest of the screen; the panel over
   * the graph canvas gives it a fixed ratio. The world does not care which —
   * it measures whatever box it is in and fits itself to it — so this is a
   * class rather than a mode.
   */
  stageClassName?: string
  className?: string
}

/**
 * How big to draw a figure, in pixels.
 *
 * The argument is the scale that maps one stage unit to one pixel for this
 * box, so a figure is drawn at exactly the height the projection reserved for
 * it. The layout engine's separation guarantee is stated in the same units,
 * which is what makes it hold at any stage size rather than only at the one
 * the constants were eyeballed against.
 *
 * The camera's zoom is deliberately *not* applied here: it scales the whole
 * world, figures included, so zooming in makes everyone bigger — which is
 * what zooming in is supposed to do.
 *
 * Clamped at both ends. Below about 14px a figure stops being readable as a
 * figure; above about 64px it starts to dominate a room it is supposed to be
 * standing in.
 */
export function characterPixelSize(fit: number): number {
  if (!Number.isFinite(fit) || fit <= 0) return 30
  return Math.round(Math.min(64, Math.max(14, CHARACTER_HEIGHT_UNITS * fit)))
}

/** Where the camera is looking: a point in world fractions, and how far in. */
type CameraView = { fx: number; fy: number; scale: number }

/** The middle of the world, at whatever zoom this box needs to stay legible. */
function centeredIn(fit: StageFit | null): CameraView {
  return { fx: 0.5, fy: 0.5, scale: fit?.baseZoom ?? 1 }
}

const MAX_ZOOM = 3.2

/** States that count as "active" for the follow-active camera. */
const ACTIVE_STATES = new Set(["working", "thinking", "communicating", "starting"])

/**
 * The smallest a figure may be drawn before the world stops being worth
 * looking at, in pixels.
 *
 * Below this a character is a coloured smudge: you can tell somebody is there
 * and not who, what state they are in, or which desk they are at. It is the
 * number that decides whether a given box shows the whole world or a part of
 * it — see `fitFor`.
 */
const MIN_FIGURE_PX = 22

/**
 * How the container maps onto the world.
 *
 * The world is always drawn at the size that **fits** the container, and the
 * camera's baseline zoom decides how much of it you see. The two together
 * settle a question every isometric view has to answer and most answer badly:
 * a box that is much wider than the world either letterboxes it or crops it,
 * and which is right depends entirely on how big that leaves the people in it.
 *
 * So the rule is stated in those terms. If fitting the whole world still
 * leaves a figure readable, the whole world is shown — nothing is hidden from
 * someone who has the room for it. If it does not, the view starts zoomed in
 * far enough to be legible and the rest is a drag away, which is what makes
 * the phone case a window into a headquarters rather than a photograph of one
 * taken from too far off.
 */
type StageFit = {
  /** Stage units to pixels, before the camera's zoom. */
  scale: number
  width: number
  height: number
  /** The zoom the camera starts at: 1 for the whole world, more to stay legible. */
  baseZoom: number
  container: { width: number; height: number }
  /**
   * A character's normalised stage `y`, as a fraction of the *drawn* box.
   *
   * The two differ because an interior world is cropped to the part of the
   * stage it uses (see `STAGE_CONTENT_BOX`). Everything upstream stays in
   * full-stage terms; this is the single place the crop is applied, and both
   * the camera and the figures go through it so they cannot disagree.
   */
  toFy: (y: number) => number
}

function fitFor(
  container: { width: number; height: number },
  box: StageContentBox
): StageFit | null {
  if (container.width <= 0 || container.height <= 0) return null

  const fit = Math.min(container.width / STAGE_WIDTH, container.height / box.height)
  const fill = Math.max(container.width / STAGE_WIDTH, container.height / box.height)
  const figure = fit * CHARACTER_HEIGHT_UNITS

  const baseZoom =
    figure >= MIN_FIGURE_PX
      ? 1
      : Math.min(MAX_ZOOM, Math.max(fill / fit, MIN_FIGURE_PX / Math.max(figure, 1)))

  return {
    scale: fit,
    width: STAGE_WIDTH * fit,
    height: box.height * fit,
    baseZoom,
    container,
    toFy: (y: number) => (y * STAGE_HEIGHT - box.y) / box.height,
  }
}

/**
 * Keeps the camera over the world.
 *
 * The visible half-width in world fractions is whatever the container covers
 * at this zoom, so the centre can travel exactly as far as the edges allow and
 * no further. At zoom 1 on a wide screen that interval collapses to a point,
 * which is the correct behaviour: there is nothing off-screen to pan to.
 */
function clampView(view: CameraView, fit: StageFit): CameraView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, view.scale))
  const halfX = Math.min(0.5, fit.container.width / (2 * scale * fit.width))
  const halfY = Math.min(0.5, fit.container.height / (2 * scale * fit.height))

  return {
    scale,
    fx: Math.min(1 - halfX, Math.max(halfX, view.fx)),
    fy: Math.min(1 - halfY, Math.max(halfY, view.fy)),
  }
}

/**
 * Frames a set of characters.
 *
 * Returns the centred view for an empty set rather than a degenerate one — a
 * camera asked to frame nothing should show the world, not divide by zero.
 */
function frame(
  characters: readonly WorldCharacter[],
  maxScale: number,
  fit: StageFit | null
): CameraView {
  if (characters.length === 0 || !fit) return centeredIn(fit)

  let minX = 1
  let maxX = 0
  let minY = 1
  let maxY = 0
  for (const character of characters) {
    if (character.x < minX) minX = character.x
    if (character.x > maxX) maxX = character.x
    const fy = fit.toFy(character.y)
    if (fy < minY) minY = fy
    if (fy > maxY) maxY = fy
  }

  // A margin wide enough that a framed figure is never flush against the
  // edge, plus a floor on the span so a single character does not zoom to
  // absurdity.
  const spanX = Math.max(maxX - minX, 0.16) + 0.14
  const spanY = Math.max(maxY - minY, 0.16) + 0.18

  const scale = Math.min(
    maxScale,
    Math.max(
      1,
      Math.min(
        fit.container.width / (spanX * fit.width),
        fit.container.height / (spanY * fit.height)
      )
    )
  )

  return clampView({ fx: (minX + maxX) / 2, fy: (minY + maxY) / 2, scale }, fit)
}

/**
 * How much of the environment this box can carry.
 *
 * §14 asks that a phone not be a shrunken desktop, and this is the mechanism:
 * the same world, drawn with less furniture and with the camera already
 * closer, rather than the same drawing at a third of the size. The user's own
 * visual-detail setting is a ceiling, never a floor — asking for Minimal on a
 * desktop still gets Minimal.
 */
function densityForBox(preferred: WorldDensity, width: number): WorldDensity {
  if (width <= 0) return preferred
  if (width < 520) return "minimal"
  if (width < 880) return preferred === "detailed" ? "balanced" : preferred
  return preferred
}

export function AgentWorld({
  scene,
  settings,
  worldName,
  now,
  selectedId,
  onSelect,
  details,
  actions,
  onOpenConnectors,
  onOpenSession,
  stageClassName,
  className,
}: AgentWorldProps) {
  const policy = useAgentMotion(settings.animation)
  const animate = policy !== "none"

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  /**
   * The stage's pixel size.
   *
   * Measured so the world can be drawn at a size that covers it and
   * characters can be positioned with `transform: translate3d`, which is what
   * lets the browser interpolate a walk between two rooms on the compositor
   * instead of animating `left`/`top` and relaying out the scene every frame.
   *
   * It starts at zero — on the server, and on the first client render, there
   * is no layout — and the renderer falls back to percentage offsets until a
   * measurement arrives. That fallback places everybody correctly; the only
   * thing it lacks is the transition, which there is nothing to animate from
   * on a first paint anyway.
   */
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = stageRef.current
    if (!element || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setStageSize({ width: box.width, height: box.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fit = useMemo(
    () => fitFor(stageSize, contentBoxFor(scene.theme.setting)),
    [stageSize, scene.theme.setting]
  )
  const density = densityForBox(settings.density, stageSize.width)

  /**
   * The camera the user has taken hold of, or null for "follow the setting".
   *
   * Reset by the control below, and reset in render when the mode changes,
   * which is React's own answer to "derive state from a prop": the alternative
   * is an effect that fires after a paint showing the old framing.
   */
  const [manualView, setManualView] = useState<CameraView | null>(null)
  const [mode, setMode] = useState(settings.camera)
  const [dragging, setDragging] = useState(false)

  if (mode !== settings.camera) {
    setMode(settings.camera)
    setManualView(null)
  }

  const autoView = useMemo<CameraView>(() => {
    switch (settings.camera) {
      case "follow-active":
        return frame(
          scene.characters.filter((character) => ACTIVE_STATES.has(character.state)),
          2.4,
          fit
        )
      case "follow-workflow":
        return frame(scene.characters, 2, fit)
      case "free":
      case "static":
      default:
        return centeredIn(fit)
    }
  }, [settings.camera, scene.characters, fit])

  const view = useMemo(
    () => (fit ? clampView(manualView ?? autoView, fit) : (manualView ?? autoView)),
    [manualView, autoView, fit]
  )

  const selected = useMemo(
    () => scene.characters.find((character) => character.id === selectedId) ?? null,
    [scene.characters, selectedId]
  )

  const selectedRoom = useMemo(
    () => (selectedRoomId ? roomById(scene.theme, selectedRoomId) : null),
    [scene.theme, selectedRoomId]
  )

  const roomOccupants = useMemo(
    () =>
      selectedRoomId
        ? scene.characters.filter((character) => character.roomId === selectedRoomId)
        : [],
    [scene.characters, selectedRoomId]
  )

  const captioned = useMemo(() => {
    const id = hoveredId ?? selectedId
    return scene.characters.find((character) => character.id === id) ?? null
  }, [scene.characters, hoveredId, selectedId])

  const captionedRoom = useMemo(
    () => (hoveredRoomId ? roomById(scene.theme, hoveredRoomId) : null),
    [scene.theme, hoveredRoomId]
  )

  /** Selecting a figure and selecting a room are mutually exclusive. */
  const selectCharacter = useCallback(
    (id: string | null) => {
      setSelectedRoomId(null)
      onSelect(id)
    },
    [onSelect]
  )

  const selectRoom = useCallback(
    (roomId: string | null) => {
      if (roomId) onSelect(null)
      setSelectedRoomId(roomId)
    },
    [onSelect]
  )

  // ---- Camera gestures ----------------------------------------------------

  const nudge = useCallback(
    (change: (view: CameraView) => CameraView) => {
      setManualView((current) => {
        const base = current ?? autoView
        const next = change(base)
        return fit ? clampView(next, fit) : next
      })
    },
    [autoView, fit]
  )

  const zoomBy = useCallback(
    (factor: number, at?: { fx: number; fy: number }) => {
      nudge((current) => {
        const scale = Math.min(MAX_ZOOM, Math.max(1, current.scale * factor))
        if (!at || scale === current.scale) return { ...current, scale }
        // Keep the world point under the pointer where it is: the camera
        // centre moves towards it in proportion to how much closer we got.
        const ratio = current.scale / scale
        return {
          scale,
          fx: at.fx - ratio * (at.fx - current.fx),
          fy: at.fy - ratio * (at.fy - current.fy),
        }
      })
    },
    [nudge]
  )

  /**
   * The world point under a client coordinate, in world fractions.
   *
   * Needed for zoom-at-pointer, which is the difference between a wheel that
   * magnifies what you are looking at and one that magnifies the middle of
   * the room while you chase it with the mouse.
   */
  const worldPointAt = useCallback(
    (clientX: number, clientY: number): { fx: number; fy: number } | null => {
      const element = stageRef.current
      if (!element || !fit) return null
      const box = element.getBoundingClientRect()
      const offsetX = (clientX - box.left) / box.width - 0.5
      const offsetY = (clientY - box.top) / box.height - 0.5
      return {
        fx: view.fx + (offsetX * fit.container.width) / (view.scale * fit.width),
        fy: view.fy + (offsetY * fit.container.height) / (view.scale * fit.height),
      }
    },
    [fit, view]
  )

  /**
   * Pointers currently down on the stage.
   *
   * One is a drag, two is a pinch. Held in a ref rather than in state because
   * every frame of a gesture would otherwise be a React render, and the thing
   * being updated is a transform that does not need one.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number } | null>(null)

  /**
   * Whether the pointer travelled far enough for this to have been a drag.
   *
   * The rooms cover almost the whole floor, so refusing to start a drag on one
   * would mean the camera could only be dragged from the gaps between them.
   * Instead the drag starts anywhere, and a gesture that actually moved
   * swallows the click it would otherwise have produced — which is what every
   * map does, and what anyone who has just dragged a world around expects.
   */
  const dragged = useRef(false)

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragged.current = false
    // A press on a figure or a control is a click on that thing. Rooms are
    // deliberately not in this list: see `dragged`.
    if ((event.target as HTMLElement).closest?.("button")) return

    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (pointers.current.size === 1) setDragging(true)
  }, [])

  /** Swallows the click at the end of a drag, before it reaches a room. */
  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!dragged.current) return
    dragged.current = false
    event.stopPropagation()
  }, [])

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const previous = pointers.current.get(event.pointerId)
      if (!previous || !fit) return
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

      const points = [...pointers.current.values()]

      if (points.length >= 2) {
        // Pinch: the ratio of the two touches' separation is the zoom, and
        // their midpoint is what stays still.
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
        const last = pinch.current
        pinch.current = { distance }
        if (last && last.distance > 0) {
          const midpoint = worldPointAt(
            (points[0].x + points[1].x) / 2,
            (points[0].y + points[1].y) / 2
          )
          zoomBy(distance / last.distance, midpoint ?? undefined)
        }
        return
      }

      const dx = event.clientX - previous.x
      const dy = event.clientY - previous.y
      // Four pixels of slop, so a click with an unsteady hand is still a
      // click.
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged.current = true

      // Divided by the zoom so a drag moves the world by the distance under
      // the pointer rather than by one that shrinks as you zoom in.
      nudge((current) => ({
        ...current,
        fx: current.fx - dx / (current.scale * fit.width),
        fy: current.fy - dy / (current.scale * fit.height),
      }))
    },
    [fit, nudge, worldPointAt, zoomBy]
  )

  const endPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) setDragging(false)
  }, [])

  /**
   * The wheel, attached by hand.
   *
   * React's `onWheel` is registered passively, so it cannot stop the page
   * scrolling behind a zoom. One non-passive listener on the stage can, and
   * it is the only listener in this component that is not JSX.
   */
  useEffect(() => {
    const element = stageRef.current
    if (!element) return

    function onWheel(event: WheelEvent) {
      event.preventDefault()
      // A trackpad's two-finger pan arrives as a mostly-horizontal wheel, and
      // treating that as zoom makes the world lurch sideways under the
      // fingers. Everything else — a mouse wheel, a pinch, which the platform
      // reports as ctrl+wheel — is a zoom, as §7 asks.
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        if (!fit) return
        nudge((current) => ({
          ...current,
          fx: current.fx + event.deltaX / (current.scale * fit.width),
        }))
        return
      }
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, worldPointAt(event.clientX, event.clientY) ?? undefined)
    }

    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [fit, nudge, zoomBy, worldPointAt])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (selectedRoomId) {
          setSelectedRoomId(null)
          return
        }
        if (selectedId) {
          onSelect(null)
          return
        }
        return
      }

      // Keyboard panning and zooming, so the camera is not a pointer-only
      // control. Step sizes are a twentieth of the world, which is roughly
      // one room.
      const step = 0.05
      if (event.key === "ArrowLeft") nudge((v) => ({ ...v, fx: v.fx - step / v.scale }))
      else if (event.key === "ArrowRight") nudge((v) => ({ ...v, fx: v.fx + step / v.scale }))
      else if (event.key === "ArrowUp") nudge((v) => ({ ...v, fy: v.fy - step / v.scale }))
      else if (event.key === "ArrowDown") nudge((v) => ({ ...v, fy: v.fy + step / v.scale }))
      else if (event.key === "+" || event.key === "=") zoomBy(1.2)
      else if (event.key === "-") zoomBy(1 / 1.2)
      else if (event.key === "0") setManualView(null)
      else return

      event.preventDefault()
    },
    [selectedId, selectedRoomId, onSelect, nudge, zoomBy]
  )

  const focusActive = useCallback(() => {
    const active = scene.characters.filter((character) => ACTIVE_STATES.has(character.state))
    setManualView(frame(active.length > 0 ? active : scene.characters, 2.4, fit))
  }, [scene.characters, fit])

  // ---- Drawing ------------------------------------------------------------

  const travel = travelDurationMs(policy)
  const hasAnyone = scene.characters.length > 0
  const size = fit ? characterPixelSize(fit.scale) : 30

  /**
   * Whether anything in the room is actually a run.
   *
   * The distinction the idle experience turns on. A world holding five
   * stand-ins is not empty — there is a place to look at and identities to
   * explore — but nothing is happening in it, and saying "5 agents" without
   * saying "idle" would read as five agents at work.
   */
  const workingCount = scene.characters.reduce(
    (total, character) => total + (character.runId ? 1 : 0),
    0
  )
  const idleOnly = hasAnyone && workingCount === 0

  const cameraMoved = manualView !== null

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-2", className)}
      style={
        {
          // One variable slows every agent animation at once. A denser world
          // is a calmer one: with twenty figures the same amplitude at the
          // same tempo reads as agitation rather than as activity.
          "--agent-anim-scale": settings.density === "detailed" ? 1.25 : 1,
          "--agent-travel-duration": `${travel}ms`,
        } as React.CSSProperties
      }
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-label text-tertiary">
          {(worldName ?? scene.theme.name).toUpperCase()}
        </p>
        {actions}
      </div>

      <div
        ref={stageRef}
        data-world-setting={scene.theme.setting}
        data-world-theme={scene.theme.id}
        className={cn(
          "agent-world-stage w-full overflow-hidden rounded-xl border border-subtle",
          dragging ? "cursor-grabbing" : "cursor-grab",
          stageClassName ?? "aspect-[3/4] sm:aspect-[10/7]"
        )}
        // A group rather than an application: the characters inside are
        // ordinary buttons and browse mode works on them normally. It is
        // focusable in every camera mode, because panning and zooming are
        // available in every camera mode.
        role="group"
        aria-label={`Agent ${scene.theme.spaceLabel}${
          hasAnyone
            ? `, ${scene.characters.length} agent${scene.characters.length === 1 ? "" : "s"}${
                idleOnly ? ", none working" : ""
              }`
            : ", empty"
        }`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClickCapture={onClickCapture}
        style={{ touchAction: "none" }}
      >
        {/* Behind the camera, and deliberately not inside it: a sky that
            panned with the floor would read as a painted backdrop being
            dragged about. It also fills the space around a world that does
            not fill its box. */}
        <WorldSky setting={scene.theme.setting} />

        <div
          className="agent-world-camera"
          style={
            fit
              ? {
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: `${fit.width}px`,
                  height: `${fit.height}px`,
                  transform: `translate(-50%, -50%) translate(${
                    -view.scale * (view.fx - 0.5) * fit.width
                  }px, ${-view.scale * (view.fy - 0.5) * fit.height}px) scale(${view.scale})`,
                  transition:
                    animate && !dragging
                      ? "transform var(--duration-slow) var(--ease-standard)"
                      : undefined,
                }
              : { position: "absolute", inset: 0 }
          }
        >
          {/*
            The agents come first in the DOM and last in the paint.

            First in the DOM because Tab follows document order, and a
            keyboard user who opened the Agent World came for the agents — not
            for eleven rooms they have to pass through to reach one. Last in
            the paint because every figure carries a z-index and the scenery
            carries none, so the stacking context resolves them above it
            whatever order they were written in.
          */}
          {scene.characters.map((character) => (
            <CharacterButton
              key={character.id}
              character={character}
              settings={settings}
              fit={fit}
              size={size}
              selected={character.id === selectedId}
              hovered={character.id === hoveredId}
              onSelect={selectCharacter}
              onHover={setHoveredId}
              animate={animate}
            />
          ))}

          <AgentWorldStage
            scene={scene}
            settings={settings}
            density={density}
            selectedId={selectedId}
            selectedRoomId={selectedRoomId}
            hoveredRoomId={hoveredRoomId}
            onSelectRoom={selectRoom}
            onHoverRoom={setHoveredRoomId}
            animate={animate}
          />
        </div>

        {/*
          The empty world, which is a different thing from an idle one.

          `pointer-events-none` is the deliberate part: the copy sits over the
          scenery rather than replacing it, so someone arriving at a world
          with nothing in it still sees what the world *is* — and can still
          drag the camera around it — instead of reading a card on a blank
          panel. Only the button inside takes the pointer back.
        */}
        {!hasAnyone && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto max-w-xs rounded-xl border border-subtle bg-popover/80 px-4 py-3 text-center backdrop-blur-sm">
              <Bot className="mx-auto size-5 text-tertiary" aria-hidden />
              <p className="mt-1.5 text-body-sm font-medium text-foreground">
                Your agents will appear here as they work
              </p>
              <p className="mt-0.5 text-meta text-tertiary">
                Connect an AI agent and this {scene.theme.spaceLabel} fills with the sessions
                running in this workspace.
              </p>
              {onOpenConnectors && (
                <button
                  type="button"
                  onClick={onOpenConnectors}
                  className="mt-2 rounded-md border border-subtle px-2 py-0.5 text-meta text-muted-foreground transition-colors duration-(--duration-fast) hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  AI connectors
                </button>
              )}
            </div>
          </div>
        )}

        <CameraControls
          zoom={view.scale}
          moved={cameraMoved}
          onZoomIn={() => zoomBy(1.25)}
          onZoomOut={() => zoomBy(1 / 1.25)}
          onFocusActive={focusActive}
          onReset={() => setManualView(null)}
        />
      </div>

      {/* The caption bar. Always present so the layout does not jump when
          something is hovered, and empty rather than hidden so a screen
          reader's live region has somewhere stable to live. */}
      <p className="min-h-5 truncate text-meta text-tertiary" aria-live="polite">
        {captioned
          ? `${captioned.agentName} · ${AGENT_VISUAL_STATE_PRESENTATION[captioned.state].label}${
              captioned.activity ? ` · ${captioned.activity}` : ""
            }${captioned.roomName ? ` · ${captioned.roomName}` : ""}`
          : captionedRoom
            ? `${captionedRoom.name} · ${captionedRoom.purpose}`
            : ""}
      </p>

      {/*
        A world with agents in it and no work happening says so in words.

        Not an overlay, because there is something to look at: the figures are
        real identities standing in a real environment, and covering them to
        explain that nothing is happening would hide the very thing that makes
        the feature legible on first open.
      */}
      {idleOnly && (
        <p className="text-meta text-tertiary">
          Your agents will appear here as they work. Nothing is running in this workspace yet.
        </p>
      )}

      {/* Never a silent omission: a world that could not draw everybody says
          how many it left out. */}
      {scene.hiddenCharacterCount > 0 && (
        <p className="text-meta text-tertiary">
          {scene.hiddenCharacterCount} more agent
          {scene.hiddenCharacterCount === 1 ? "" : "s"} not shown at this density.
        </p>
      )}

      {selected && (
        <AgentWorldDetail
          character={selected}
          detail={details?.(selected.id) ?? null}
          now={now}
          onClose={() => onSelect(null)}
          onOpenConnectors={onOpenConnectors}
          onOpenSession={onOpenSession}
        />
      )}

      {selectedRoom && (
        <AgentWorldRoomDetail
          room={selectedRoom}
          occupants={roomOccupants}
          onSelectCharacter={selectCharacter}
          onClose={() => setSelectedRoomId(null)}
        />
      )}
    </div>
  )
}

/**
 * Zoom, focus and reset, as buttons.
 *
 * §7 asks for a camera that can be driven, and a gesture nobody can see is
 * not a control — on a touch screen especially, where there is no wheel and
 * no arrow keys. These are deliberately tertiary: small, translucent, in the
 * corner, and they never fit a room.
 */
function CameraControls({
  zoom,
  moved,
  onZoomIn,
  onZoomOut,
  onFocusActive,
  onReset,
}: {
  zoom: number
  moved: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFocusActive: () => void
  onReset: () => void
}) {
  const buttonClass =
    "flex size-7 items-center justify-center rounded-md border border-subtle bg-popover/80 text-tertiary backdrop-blur-sm transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"

  return (
    // Above every figure's own z-index, so an agent standing in the near
    // corner of the world cannot end up drawn over the zoom controls.
    <div className="absolute bottom-2 right-2 z-[500] flex flex-col gap-1">
      <button type="button" aria-label="Zoom in" className={buttonClass} onClick={onZoomIn}>
        <Plus className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        className={buttonClass}
        disabled={zoom <= 1}
        onClick={onZoomOut}
      >
        <Minus className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Focus active agents"
        className={buttonClass}
        onClick={onFocusActive}
      >
        <Locate className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Reset view"
        className={buttonClass}
        disabled={!moved}
        onClick={onReset}
      >
        <Crosshair className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

/**
 * One agent, placed and focusable.
 *
 * Memoised on primitives so a poll that changes one run re-renders one
 * button. `fit` is a fresh object per resize only, which is the one moment
 * every character genuinely does need to move.
 */
function CharacterButton({
  character,
  settings,
  fit,
  size,
  selected,
  hovered,
  onSelect,
  onHover,
  animate,
}: {
  character: WorldCharacter
  settings: AgentWorldSettings
  fit: StageFit | null
  size: number
  selected: boolean
  hovered: boolean
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  animate: boolean
}) {
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[character.state]

  // Two switches, and they gate different things. `statusEffects` is about
  // ongoing states — is this figure allowed to look busy. `completionEffects`
  // is about the one-shot flourish a run gets when it finishes, which is the
  // part someone is most likely to want off while leaving the rest on.
  const stateAnimated =
    animate &&
    settings.effects.statusEffects &&
    (character.state !== "success" || settings.effects.completionEffects)

  // Measured: a compositor-friendly transform, which the CSS transition on
  // `.agent-world-character` interpolates. Unmeasured (server, first paint,
  // jsdom): percentage offsets, which place everybody correctly with no
  // animation to run.
  const position: React.CSSProperties = fit
    ? {
        transform: `translate3d(${character.x * fit.width}px, ${
          fit.toFy(character.y) * fit.height
        }px, 0) translate(-50%, -100%)`,
      }
    : {
        left: `${character.x * 100}%`,
        top: `${character.y * 100}%`,
        transform: "translate(-50%, -100%)",
      }

  // The accessible name says everything the figure expresses spatially: who,
  // what state, what task, and where.
  const label = [
    character.agentName,
    presentation.label,
    // A stand-in that is not connected says so, in the connector layer's own
    // word. "Codex — Idle" and "Codex — Idle — Not connected" are different
    // facts, and the second is the one someone needs before they wonder why
    // it never does anything.
    character.presence === "available" ? character.statusLabel : undefined,
    character.activity,
    `in the ${character.roomName ?? character.stationLabel}`,
  ]
    .filter(Boolean)
    .join(" — ")

  return (
    <button
      type="button"
      // Marks the character layer apart from the room buttons and the camera
      // controls, which share the stage and the button role. Used by the
      // tests and by visual QA in a real browser; nothing in the app branches
      // on it.
      data-world-character={character.id}
      className={cn(
        "agent-world-character rounded-lg outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
        selected && "ring-2 ring-ring/60",
        hovered && !selected && "ring-1 ring-border-strong"
      )}
      style={{
        ...position,
        // Depth order. Further down the stage is nearer the camera, which is
        // exactly what the projection guarantees, so a figure in front of
        // another draws over it rather than under it.
        zIndex: selected ? 400 : 100 + Math.round(character.y * 200),
      }}
      aria-pressed={selected}
      aria-label={label}
      onClick={() => onSelect(selected ? null : character.id)}
      onPointerEnter={() => onHover(character.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(character.id)}
      onBlur={() => onHover(null)}
    >
      <span className="agent-world-body block">
        <AgentCharacter
          connector={character.provider}
          state={character.state}
          config={character.character}
          style={settings.agentStyle}
          intensity={settings.animation}
          animate={stateAnimated}
          // Sized from the world, not fixed: the layout reserved a share of
          // the stage per character, and drawing at any other size would
          // break the separation guarantee. The user's own scale multiplies
          // it — deliberately, and reversibly.
          size={size * settings.agentScale}
        />
      </span>
    </button>
  )
}
