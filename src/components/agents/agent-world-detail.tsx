"use client"

import { memo } from "react"
import {
  AGENT_VISUAL_STATE_PRESENTATION,
  visualStateForWorkItem,
} from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AgentAvatar, AgentStatus } from "./agent-identity"
import { AGENT_TONE_TEXT_CLASS } from "./agent-tone"
import type { AgentRunArtifactRole, AgentWorkItemStatus } from "@/lib/agents/types"
import type { WorldCharacter } from "@/lib/agents/world/types"

/**
 * What one agent is doing, in full.
 *
 * The world is a navigation surface as well as a picture (§17), and this is
 * the second half of that: selecting a character opens this, and everything
 * the figure expresses through position and motion is restated here as text.
 *
 * It is also the **accessibility fallback**, in the same sense
 * `GraphAgentPanel` is for the canvas. A person who cannot see the room can
 * reach every character by keyboard, and what they find when they get there
 * is this — a complete, linear account that never depends on having
 * interpreted a layout.
 *
 * Strictly read-only. There is no control here that changes a run, and no
 * prop that would let one be added without changing this file's signature.
 */

/**
 * The parts of a run the world cannot derive on its own.
 *
 * Supplied by the host rather than fetched here, so this component reads no
 * store and the world stays renderable from a plain scene. Everything in it
 * is already-sanitised domain state.
 */
export type WorldCharacterDetail = {
  /** Newest first. The run's activity log, capped by the domain at 200. */
  events: readonly { id: string; summary: string; timestamp: number }[]
  files: readonly { artifactId: string; relativePath: string; role: AgentRunArtifactRole }[]
  workItems: readonly { id: string; title: string; status: AgentWorkItemStatus }[]
  /** Observed transfers involving this run, as phrases. */
  handoffs: readonly { id: string; label: string; withName: string; direction: "to" | "from" }[]
}

/**
 * A duration in words.
 *
 * Deliberately coarse. The clock this is measured against is the newest
 * timestamp the domain holds, not the wall clock, so it is accurate to the
 * last observation rather than to this instant — and rendering seconds would
 * imply a precision the measurement does not have.
 */
export function formatElapsed(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return "under a minute"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ${minutes % 60} min`
  return `${Math.floor(hours / 24)} days`
}

const ROLE_LABELS: Record<AgentRunArtifactRole, string> = {
  edited: "Edited",
  created: "Created",
  deleted: "Deleted",
  inspected: "Read",
}

/**
 * The domain's own word for a work item's status.
 *
 * Kept distinct from the visual state's label on purpose. A blocked work item
 * is coloured like anything that needs attention, but it must keep saying
 * "Blocked": a blocked item is waiting on something and may unblock on the
 * next observation, while a blocked *run* has stopped for good. The two
 * vocabularies agree about the colour and disagree about the word, which is
 * exactly right.
 */
const WORK_ITEM_WORDS: Record<AgentWorkItemStatus, string> = {
  pending: "Pending",
  active: "Active",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
}

export type AgentWorldDetailProps = {
  character: WorldCharacter
  detail?: WorldCharacterDetail | null
  /** The scene's clock, for elapsed time. */
  now: number
  onClose?: () => void
  /**
   * Takes the user to the connectors page.
   *
   * Optional, and the card degrades to a plain sentence without it: the world
   * renders inside surfaces that have no navigation of their own (the panel
   * over the graph canvas, and every test that renders a scene directly), and
   * a card that required a router would not be usable from them.
   */
  onOpenConnectors?: () => void
  /**
   * Opens this character's run in the Session View.
   *
   * Optional, and the card is unchanged without it - the world renders
   * inside surfaces that have no navigation of their own (the panel over
   * the graph canvas, and every test that renders a scene directly), and a
   * card that required one would not be usable from them.
   *
   * Only offered for a character that has a run. A stand-in figure is
   * present, not working, and has no session to open.
   */
  onOpenSession?: (runId: string) => void
  className?: string
}

function AgentWorldDetailImpl({
  character,
  detail,
  now,
  onClose,
  onOpenConnectors,
  onOpenSession,
  className,
}: AgentWorldDetailProps) {
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[character.state]
  const elapsed =
    character.startedAt !== undefined ? formatElapsed(now - character.startedAt) : null

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border border-subtle bg-popover/95 p-3 shadow-lg backdrop-blur-sm",
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <AgentAvatar connector={character.provider} state={character.state} size="md" />

        <div className="min-w-0 flex-1">
          <p className="truncate text-body-sm font-medium text-foreground">{character.title}</p>
          <p className="truncate text-meta text-tertiary">{character.agentName}</p>
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

      <div className="space-y-1">
        <AgentStatus state={character.state} className="text-body-sm" />
        {/* The state's own sentence, so "Thinking" is never left to be
            interpreted — it says what produced it. */}
        <p className="text-meta text-tertiary">{presentation.description}</p>
      </div>

      {character.activity && (
        <div className="space-y-0.5">
          <p className="text-eyebrow text-tertiary">DOING</p>
          <p className="text-body-sm text-foreground">{character.activity}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-tertiary">
        <span>At {character.stationLabel}</span>
        {elapsed && <span>Active for {elapsed}</span>}
        {/* Derived from real per-item statuses, never from elapsed time or
            event volume. Absent entirely when nothing was countable. */}
        {character.progress && (
          <span>
            {character.progress.completed} / {character.progress.total} done
          </span>
        )}
      </div>

      {detail?.workItems.length ? (
        <div className="space-y-0.5">
          <p className="text-eyebrow text-tertiary">WORK</p>
          <ul className="space-y-0.5">
            {detail.workItems.slice(0, 5).map((item) => (
              <li key={item.id} className="truncate text-body-sm text-foreground">
                {item.title}
                {/*
                  The item's own domain word, coloured by its visual state.
                  Both halves matter: a blocked item has to read as needing
                  attention, and it has to keep saying "blocked" rather than
                  borrowing the run vocabulary's "needs attention" — a blocked
                  item is waiting on something and may unblock on the next
                  observation, which a blocked *run* never does.
                */}
                <span
                  className={
                    AGENT_TONE_TEXT_CLASS[
                      AGENT_VISUAL_STATE_PRESENTATION[visualStateForWorkItem(item.status)].tone
                    ]
                  }
                >
                  {" · "}
                  {WORK_ITEM_WORDS[item.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail?.files.length ? (
        <div className="space-y-0.5">
          <p className="text-eyebrow text-tertiary">FILES</p>
          <ul className="space-y-0.5">
            {detail.files.slice(0, 5).map((file) => (
              <li key={file.artifactId} className="truncate text-meta text-tertiary">
                {ROLE_LABELS[file.role]} {file.relativePath}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail?.handoffs.length ? (
        <div className="space-y-0.5">
          <p className="text-eyebrow text-tertiary">SHARED WORK</p>
          <ul className="space-y-0.5">
            {detail.handoffs.slice(0, 4).map((handoff) => (
              <li key={handoff.id} className="truncate text-meta text-tertiary">
                {handoff.direction === "to" ? "→ " : "← "}
                {handoff.label} {handoff.direction === "to" ? "to" : "from"} {handoff.withName}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail?.events.length ? (
        <div className="space-y-0.5">
          <p className="text-eyebrow text-tertiary">RECENT ACTIVITY</p>
          <ul className="space-y-0.5">
            {detail.events.slice(0, 5).map((event) => (
              <li key={event.id} className="truncate text-meta text-tertiary">
                {event.summary}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* An agent with nothing to report says so once, rather than showing
          five empty headings. A provider that has observed nothing is a
          correct, stable state — not a gap to be filled.

          The two stand-ins say different things because they are different
          facts. "Connected" means the agent is here and idle. An available
          one is not connected at all, and saying it was would be the one
          piece of theatre this feature has been built to avoid — so it
          reports the connector layer's own status word and says what would
          bring it in. */}
      {/* The way from the spatial world to the durable record. The world
          will stop drawing this run in a few hours; the session it opens
          outlives that entirely. */}
      {character.runId && onOpenSession && (
        <button
          type="button"
          onClick={() => onOpenSession(character.runId as string)}
          className="rounded-md border border-subtle px-2 py-0.5 text-meta text-muted-foreground transition-colors duration-(--duration-fast) hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Open session
        </button>
      )}

      {!character.runId && (
        <div className="space-y-1">
          <p className="text-meta text-tertiary">
            {character.presence === "available"
              ? `${character.statusLabel ?? "Not connected"}. This agent ships with TabDump and is waiting to be connected.`
              : "Connected. No activity has been observed in this workspace yet."}
          </p>
          {character.presence === "available" && onOpenConnectors && (
            <button
              type="button"
              onClick={onOpenConnectors}
              className="rounded-md border border-subtle px-2 py-0.5 text-meta text-muted-foreground transition-colors duration-(--duration-fast) hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Connect in AI connectors
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export const AgentWorldDetail = memo(AgentWorldDetailImpl)
AgentWorldDetail.displayName = "AgentWorldDetail"
