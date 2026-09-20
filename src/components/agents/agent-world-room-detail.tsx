"use client"

import { memo } from "react"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"
import type { WorldRoom } from "@/lib/agents/world/architecture"
import type { WorldCharacter } from "@/lib/agents/world/types"

/**
 * One room, in full.
 *
 * The other half of §6: the environment is clickable, and what a click
 * produces is this — what the place is called, what it is for, who is in it
 * and what they are doing. It is also how a keyboard user reads the
 * architecture, since the room buttons it belongs to are reachable by Tab and
 * this is what opening one shows.
 *
 * Everything in it is derived from the same scene the figures come from.
 * There is no per-room state, no room-specific copy beyond the theme's own
 * `purpose`, and no way for the card to claim an occupant the world is not
 * drawing.
 *
 * ## An empty room says it is empty
 *
 * Nine of the eleven rooms hold a station and can therefore hold agents; one
 * is infrastructure and never will. Both cases end up here, and both are
 * stated plainly rather than padded — "no agents here right now" and "no
 * agent works in here" are different facts, and the second is a property of
 * the room rather than of the moment.
 */

export type AgentWorldRoomDetailProps = {
  room: WorldRoom
  /** The characters standing in this room, already filtered by the caller. */
  occupants: readonly WorldCharacter[]
  /** Selects one of the occupants, so the room card leads to the agent card. */
  onSelectCharacter?: (characterId: string) => void
  onClose?: () => void
  className?: string
}

function AgentWorldRoomDetailImpl({
  room,
  occupants,
  onSelectCharacter,
  onClose,
  className,
}: AgentWorldRoomDetailProps) {
  // A room with no stations cannot hold anybody, whatever is happening. The
  // distinction matters for the copy below and is a property of the theme
  // rather than of this moment's scene.
  const staffed = room.stationIds.length > 0

  // Only real work counts as a task. A stand-in figure is present, not busy,
  // and listing "Idle" under a heading called TASKS would be the world
  // inventing activity out of presence.
  const tasks = occupants.filter((occupant) => occupant.runId && occupant.activity)

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border border-subtle bg-popover/95 p-3 shadow-lg backdrop-blur-sm",
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 size-3 shrink-0 rounded-[3px]"
          style={{ backgroundColor: `var(--world-accent-${room.accent})` }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-sm font-medium text-foreground">{room.name}</p>
          <p className="text-meta text-tertiary">{room.purpose}</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-meta text-tertiary transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Close
          </button>
        )}
      </div>

      {occupants.length > 0 ? (
        <div className="space-y-1">
          <p className="text-label text-tertiary">
            {occupants.length === 1 ? "1 AGENT HERE" : `${occupants.length} AGENTS HERE`}
          </p>
          <ul className="space-y-0.5">
            {occupants.map((occupant) => {
              const presentation = AGENT_VISUAL_STATE_PRESENTATION[occupant.state]
              return (
                <li key={occupant.id}>
                  <button
                    type="button"
                    disabled={!onSelectCharacter}
                    onClick={() => onSelectCharacter?.(occupant.id)}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors duration-(--duration-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      onSelectCharacter && "hover:bg-accent"
                    )}
                  >
                    <AgentIcon connector={occupant.provider} state={occupant.state} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                      {occupant.agentName}
                    </span>
                    <span className="shrink-0 text-meta text-tertiary">{presentation.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <p className="text-meta text-tertiary">
          {staffed
            ? "No agents here right now."
            : "Infrastructure. No agent works in here."}
        </p>
      )}

      {tasks.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-eyebrow text-tertiary">ACTIVE TASKS</p>
          <ul className="space-y-0.5">
            {tasks.slice(0, 5).map((occupant) => (
              <li key={`${occupant.id}-task`} className="truncate text-meta text-tertiary">
                {occupant.agentName} · {occupant.activity}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export const AgentWorldRoomDetail = memo(AgentWorldRoomDetailImpl)
AgentWorldRoomDetail.displayName = "AgentWorldRoomDetail"
