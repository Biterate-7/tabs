"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bot } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { useAgentMotion } from "@/hooks/use-agent-motion"
import { CHARACTER_FOOTPRINT, travelDurationMs } from "@/lib/agents/world/layout"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AgentCharacter } from "./agent-character"
import { AgentWorldDetail } from "./agent-world-detail"
import { AgentWorldStage } from "./agent-world-stage"
import type { WorldCharacterDetail } from "./agent-world-detail"
import type { AgentWorldSettings } from "@/lib/agents/world/settings"
import type { WorldCharacter, WorldScene } from "@/lib/agents/world/types"

/**
 * The Agent World.
 *
 * A room, with the agents that are actually working in it. Everything the
 * room shows is derived from observed state: a figure exists because a run
 * exists, it stands where it stands because of that run's status, and the
 * lines between figures are transfers the domain recorded. Nothing is
 * decorative except the furniture.
 *
 * ## It is DOM, and that is the accessibility story
 *
 * Every agent is a `<button>` with a complete accessible name — who, what
 * state, what task, where. Tab reaches them in layout order, Enter opens the
 * detail card, Escape closes it. A screen reader user gets the same
 * information a sighted one does, in the same order, without the layout
 * having to mean anything to them. That is the main reason this is not a
 * canvas: a canvas would have needed all of it rebuilt from nothing.
 *
 * ## The caption bar, and why it is not a floating tooltip
 *
 * Hovering or focusing an agent fills a fixed strip beneath the stage rather
 * than popping a card at the cursor. Three reasons, in order of weight: a
 * floating card near the top edge of a short stage has nowhere to go; the
 * same strip serves hover and keyboard focus identically, so there is one
 * behaviour rather than two; and a caption that always appears in the same
 * place is read faster than one that appears wherever the pointer happens to
 * be. It is instant and it never moves.
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
  className?: string
}

/**
 * How big to draw a figure, given the stage it stands on.
 *
 * The layout engine reserves `CHARACTER_FOOTPRINT` of the stage per
 * character and guarantees its slots clear that much. This is the other half
 * of that contract: draw a figure at the size the reservation assumed, so the
 * guarantee holds at any stage size rather than only at the one the constants
 * were eyeballed against.
 *
 * Clamped at both ends. Below about 20px a figure stops being readable as a
 * figure; above about 44px it starts to dominate a panel that also has to
 * hold a caption and a detail card.
 */
export function characterPixelSize(stageHeight: number): number {
  if (!Number.isFinite(stageHeight) || stageHeight <= 0) return 36;
  return Math.round(Math.min(44, Math.max(20, stageHeight * CHARACTER_FOOTPRINT.height)));
}

/** Where the camera is looking, in normalised stage coordinates. */
type CameraView = { cx: number; cy: number; scale: number }

const STATIC_VIEW: CameraView = { cx: 0.5, cy: 0.5, scale: 1 }

/** States that count as "active" for the follow-active camera. */
const ACTIVE_STATES = new Set(["working", "thinking", "communicating", "starting"])

/**
 * Frames a set of characters.
 *
 * Returns the static view for an empty set rather than a degenerate one — a
 * camera asked to frame nothing should show the room, not divide by zero.
 */
function frame(characters: readonly WorldCharacter[], maxScale: number): CameraView {
  if (characters.length === 0) return STATIC_VIEW

  let minX = 1
  let maxX = 0
  let minY = 1
  let maxY = 0
  for (const character of characters) {
    if (character.x < minX) minX = character.x
    if (character.x > maxX) maxX = character.x
    if (character.y < minY) minY = character.y
    if (character.y > maxY) maxY = character.y
  }

  // A margin wide enough that a framed figure is never flush against the
  // edge, plus a floor on the span so a single character does not zoom to
  // absurdity.
  const spanX = Math.max(maxX - minX, 0.28) + 0.18
  const spanY = Math.max(maxY - minY, 0.28) + 0.22

  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    scale: Math.min(maxScale, Math.max(1, Math.min(1 / spanX, 1 / spanY))),
  }
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
  className,
}: AgentWorldProps) {
  const policy = useAgentMotion(settings.animation)
  const animate = policy !== "none"

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [freeView, setFreeView] = useState<CameraView>(STATIC_VIEW)
  const stageRef = useRef<HTMLDivElement>(null)

  /**
   * The stage's pixel size.
   *
   * Measured so characters can be positioned with `transform: translate3d`,
   * which is what lets the browser interpolate a walk between two stations on
   * the compositor instead of animating `left`/`top` and relaying out the
   * scene every frame.
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

  const view = useMemo<CameraView>(() => {
    switch (settings.camera) {
      case "follow-active":
        return frame(
          scene.characters.filter((character) => ACTIVE_STATES.has(character.state)),
          2.1
        )
      case "follow-workflow":
        return frame(scene.characters, 1.8)
      case "free":
        return freeView
      case "static":
      default:
        return STATIC_VIEW
    }
  }, [settings.camera, scene.characters, freeView])

  const selected = useMemo(
    () => scene.characters.find((character) => character.id === selectedId) ?? null,
    [scene.characters, selectedId]
  )

  const captioned = useMemo(() => {
    const id = hoveredId ?? selectedId
    return scene.characters.find((character) => character.id === id) ?? null
  }, [scene.characters, hoveredId, selectedId])

  /**
   * Dragging and wheeling the free camera.
   *
   * A control called "Free" that only answered the keyboard would be a
   * setting that does not do what it is named. The keyboard path below stays
   * — it is the one a keyboard user has — and this is the one everyone else
   * reaches for first.
   *
   * A drag that starts on an agent is left alone: that is a click on a
   * button, and stealing it would make the figures unselectable in exactly
   * the camera mode where someone is most likely to be exploring.
   */
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (settings.camera !== "free") return
      if ((event.target as HTMLElement).closest("button")) return

      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [settings.camera]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (stageSize.width <= 0 || stageSize.height <= 0) return

      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      dragRef.current = { ...drag, x: event.clientX, y: event.clientY }

      // Divided by the scale so a drag moves the world by the distance under
      // the pointer rather than by a distance that shrinks as you zoom in.
      setFreeView((view) => ({
        ...view,
        cx: clamp01(view.cx - dx / (stageSize.width * view.scale)),
        cy: clamp01(view.cy - dy / (stageSize.height * view.scale)),
      }))
    },
    [stageSize.width, stageSize.height]
  )

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (settings.camera !== "free") return
      setFreeView(zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12))
    },
    [settings.camera]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape" && selectedId) {
        onSelect(null)
        return
      }
      if (settings.camera !== "free") return

      // Keyboard panning and zooming, so the free camera is not a
      // pointer-only control. Step sizes are a twentieth of the stage, which
      // is roughly one character's width.
      const step = 0.05
      if (event.key === "ArrowLeft") setFreeView((v) => ({ ...v, cx: clamp01(v.cx - step) }))
      else if (event.key === "ArrowRight") setFreeView((v) => ({ ...v, cx: clamp01(v.cx + step) }))
      else if (event.key === "ArrowUp") setFreeView((v) => ({ ...v, cy: clamp01(v.cy - step) }))
      else if (event.key === "ArrowDown") setFreeView((v) => ({ ...v, cy: clamp01(v.cy + step) }))
      else if (event.key === "+" || event.key === "=") setFreeView(zoomBy(1.2))
      else if (event.key === "-") setFreeView(zoomBy(1 / 1.2))
      else return

      event.preventDefault()
    },
    [selectedId, onSelect, settings.camera]
  )

  const travel = travelDurationMs(policy)

  const hasAnyone = scene.characters.length > 0

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
        className="agent-world-stage w-full overflow-hidden rounded-xl border border-subtle bg-background-secondary"
        // A group rather than an application: the characters inside are
        // ordinary buttons and browse mode works on them normally.
        role="group"
        aria-label={`Agent ${scene.theme.spaceLabel}${
          hasAnyone
            ? `, ${scene.characters.length} agent${scene.characters.length === 1 ? "" : "s"}`
            : ", empty"
        }`}
        tabIndex={settings.camera === "free" ? 0 : -1}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        style={
          settings.camera === "free"
            ? { aspectRatio: "5 / 3", cursor: "grab", touchAction: "none" }
            : { aspectRatio: "5 / 3" }
        }
      >
        <div
          className="absolute inset-0"
          style={{
            transformOrigin: "center",
            transform: `scale(${view.scale}) translate(${(0.5 - view.cx) * 100}%, ${(0.5 - view.cy) * 100}%)`,
            transition: animate ? `transform var(--duration-slow) var(--ease-standard)` : undefined,
          }}
        >
          <AgentWorldStage
            scene={scene}
            settings={settings}
            selectedId={selectedId}
            animate={animate}
          />

          {scene.characters.map((character) => (
            <CharacterButton
              key={character.id}
              character={character}
              settings={settings}
              stageSize={stageSize}
              selected={character.id === selectedId}
              hovered={character.id === hoveredId}
              onSelect={onSelect}
              onHover={setHoveredId}
              animate={animate}
            />
          ))}
        </div>

        {!hasAnyone && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <EmptyState
              icon={Bot}
              title="No agents at work here"
              description="Agents appear in this world when a connected agent starts working in this workspace."
            />
          </div>
        )}
      </div>

      {/* The caption bar. Always present so the layout does not jump when
          something is hovered, and empty rather than hidden so a screen
          reader's live region has somewhere stable to live. */}
      <p className="min-h-5 truncate text-meta text-tertiary" aria-live="polite">
        {captioned
          ? `${captioned.agentName} · ${AGENT_VISUAL_STATE_PRESENTATION[captioned.state].label}${
              captioned.activity ? ` · ${captioned.activity}` : ""
            }`
          : ""}
      </p>

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
        />
      )}
    </div>
  )
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function zoomBy(factor: number): (view: CameraView) => CameraView {
  return (view) => ({ ...view, scale: Math.min(2.4, Math.max(1, view.scale * factor)) })
}

/**
 * One agent, placed and focusable.
 *
 * Memoised on primitives so a poll that changes one run re-renders one
 * button. `stageSize` is a fresh object per resize only, which is the one
 * moment every character genuinely does need to move.
 */
function CharacterButton({
  character,
  settings,
  stageSize,
  selected,
  hovered,
  onSelect,
  onHover,
  animate,
}: {
  character: WorldCharacter
  settings: AgentWorldSettings
  stageSize: { width: number; height: number }
  selected: boolean
  hovered: boolean
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  animate: boolean
}) {
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[character.state]
  const measured = stageSize.width > 0 && stageSize.height > 0

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
  const position: React.CSSProperties = measured
    ? {
        transform: `translate3d(${character.x * stageSize.width}px, ${character.y * stageSize.height}px, 0) translate(-50%, -100%)`,
      }
    : {
        left: `${character.x * 100}%`,
        top: `${character.y * 100}%`,
        transform: "translate(-50%, -100%)",
      }

  // The accessible name says everything the figure expresses spatially: who,
  // what state, what task, and where. Someone who never sees the room loses
  // nothing but the picture.
  const label = [
    character.agentName,
    presentation.label,
    character.activity,
    `at ${character.stationLabel}`,
  ]
    .filter(Boolean)
    .join(" — ")

  return (
    <button
      type="button"
      className={cn(
        "agent-world-character rounded-lg outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
        selected && "ring-2 ring-ring/60",
        hovered && !selected && "ring-1 ring-border-strong"
      )}
      style={{ ...position, zIndex: selected ? 3 : 2 }}
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
          // Sized from the stage, not fixed: the layout reserved a share of
          // the stage per character, and drawing at any other size would
          // break the separation guarantee on a narrow panel. The user's own
          // scale multiplies it — deliberately, and reversibly.
          size={characterPixelSize(stageSize.height) * settings.agentScale}
        />
      </span>
    </button>
  )
}
