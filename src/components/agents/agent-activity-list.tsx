"use client"

import { memo } from "react"
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"
import { AGENT_TONE_TEXT_CLASS } from "./agent-tone"
import type { AgentVisualState } from "@/lib/agents/visual/types"

/**
 * Who is working, and on what.
 *
 * The compact form of the whole feature, and the one that appears in the
 * workspace sidebar whether or not the world is open:
 *
 *     ▶ Claude Code
 *       Researching competitor architecture          3/7
 *
 * Each row is one live run with its agent's mark animating according to that
 * run's real state. The animation is not a loading indicator — a row for a
 * waiting run holds still, and a row for a finished one does too, so movement
 * on this list always means work is happening right now.
 *
 * Deliberately independent of the Agent World. Someone who has the world
 * turned off still gets this, because "who is working" is the question the
 * sidebar exists to answer and it should not depend on an optional
 * visualisation.
 */

export type AgentActivityItem = {
  /** Stable id — the run's spatial or character id. Used as the key and for selection. */
  id: string
  /** Opaque provider key, for the visual identity. */
  provider: string
  /** The agent's name, as the domain recorded it. */
  agentName: string
  state: AgentVisualState
  /** What it is doing. Already-sanitised domain text; never raw provider output. */
  activity?: string
  /** Derived from real work items, or absent. Never a fabricated ratio. */
  progress?: { completed: number; total: number }
}

export type AgentActivityListProps = {
  items: readonly AgentActivityItem[]
  /** Selects a row. Omitted for a read-only list. */
  onSelect?: (id: string) => void
  selectedId?: string | null
  /** An accessible name for the list. */
  label?: string
  className?: string
}

function ActivityRow({
  item,
  onSelect,
  selected,
}: {
  item: AgentActivityItem
  onSelect?: (id: string) => void
  selected: boolean
}) {
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[item.state]
  const progress = item.progress
    ? `${item.progress.completed}/${item.progress.total}`
    : null

  const body = (
    <>
      <span className="mt-0.5 shrink-0">
        <AgentIcon connector={item.provider} state={item.state} size="sm" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
            {item.agentName}
          </span>
          {/* Progress is only ever a count of real work items, and is absent
              far more often than it is present. A percentage here would be a
              measurement nobody took. */}
          {progress && <span className="shrink-0 text-meta text-tertiary">{progress}</span>}
        </span>

        <span className="block truncate text-meta">
          {/* The state in words, beside the mark that animates it. This is the
              form the state takes for anyone who has animation off — which is
              why it is never optional. */}
          <span className={AGENT_TONE_TEXT_CLASS[presentation.tone]}>
            <span aria-hidden>{presentation.glyph} </span>
            {presentation.label}
          </span>
          {item.activity ? <span className="text-tertiary"> · {item.activity}</span> : null}
        </span>
      </span>
    </>
  )

  if (!onSelect) {
    return <li className="flex items-start gap-2 px-1.5 py-1">{body}</li>
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-pressed={selected}
        // The accessible name carries state and task in words, so the row
        // never depends on the mark, its colour or its motion being
        // perceived.
        aria-label={[item.agentName, presentation.label, item.activity].filter(Boolean).join(" — ")}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          selected && "bg-surface-selected"
        )}
      >
        {body}
      </button>
    </li>
  )
}

function AgentActivityListImpl({
  items,
  onSelect,
  selectedId,
  label = "Agent activity",
  className,
}: AgentActivityListProps) {
  // Renders nothing at all when nothing is happening. The surrounding panel
  // owns the empty state, because "no agents connected", "nothing running"
  // and "nothing matches this filter" are three different messages and this
  // component cannot tell them apart.
  if (items.length === 0) return null

  return (
    <ul aria-label={label} className={cn("space-y-0.5", className)}>
      {items.map((item) => (
        <ActivityRow
          key={item.id}
          item={item}
          onSelect={onSelect}
          selected={selectedId === item.id}
        />
      ))}
    </ul>
  )
}

export const AgentActivityList = memo(AgentActivityListImpl)
AgentActivityList.displayName = "AgentActivityList"

/**
 * A loading state that says who is loading.
 *
 * §27's replacement for a bare "Loading…": the agent's own mark, in its
 * `starting` state, beside a sentence naming it. Used while a connector is
 * establishing observation — which is a real state with a real duration, not
 * a spinner standing in for one.
 */
export function AgentLoadingState({
  connector,
  name,
  message,
}: {
  connector: string
  name: string
  message?: string
}) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-2">
      <AgentIcon connector={connector} state="starting" size="md" />
      <p className="min-w-0 truncate text-body-sm text-muted-foreground">
        {message ?? `${name} is getting ready…`}
      </p>
    </div>
  )
}
