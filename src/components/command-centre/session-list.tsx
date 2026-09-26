"use client"

import { useMemo } from "react"
import { Plus } from "lucide-react"
import { AgentStatusGlyph } from "@/components/agents/agent-status-glyph"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import { platformProvider } from "@/lib/agents/platform/catalog"
import {
  SESSION_STATUS_LABEL,
  SESSION_VISUAL_STATE,
  isTerminalSession,
  sessionStatusTone,
} from "@/lib/agents/command-centre/presentation"
import { cn } from "@/lib/utils"
import type { CommandCentreSession } from "@/hooks/use-agent-sessions"

/**
 * The sessions this runtime is holding.
 *
 * ## Why it groups by liveness rather than by time
 *
 * A command centre is a place you come back to in order to answer "what is
 * happening" before "what happened". Sorting strictly by recency buries a run
 * that has been working for ten minutes under three that finished since. So
 * the list has two groups, Active and Ended, and sorts by recency *inside*
 * each — which is the arrangement the reference screenshots use for the same
 * reason.
 *
 * Both group headings are always computed, but an empty group renders nothing:
 * a permanent "Ended (0)" is a row that never says anything.
 */

function relativeTime(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsed / 60_000)

  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function SessionRow({
  session,
  selected,
  projectName,
  now,
  onSelect,
}: {
  session: CommandCentreSession
  selected: boolean
  projectName?: string
  now: number
  onSelect: () => void
}) {
  const { view } = session
  const state = SESSION_VISUAL_STATE[view.status]

  const agentName = platformProvider(view.provider)?.displayName ?? view.provider
  const title = view.title ?? SESSION_STATUS_LABEL[view.status]

  /*
    The reference's task row: a status glyph in a 16px gutter, the task on
    the first line at 12px, and a second 11px line saying where it stands —
    status first (so the row is readable without the glyph), then the agent
    and project. Full-bleed, no corner: the list is a column of rows, and
    the current one is marked by a tonal fill, not a card.
  */
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-2.5 py-2.5 pr-3 pl-3.5 text-left transition-colors duration-(--duration-fast) ease-(--ease-color)",
          "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
          selected ? "bg-surface-selected" : "hover:bg-surface-hover"
        )}
      >
        <span className="flex h-4 items-center">
          <AgentStatusGlyph state={state} label={SESSION_STATUS_LABEL[view.status]} />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-body-sm", selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
            {title}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-meta text-tertiary">
            <span className={cn("shrink-0", AGENT_TONE_TEXT_CLASS[sessionStatusTone(view.status)] === "text-destructive" && "text-destructive")}>
              {SESSION_STATUS_LABEL[view.status]}
            </span>
            <span className="truncate">
              · {agentName}
              {projectName ? ` · ${projectName}` : ""}
            </span>
          </span>
        </span>

        <span className="shrink-0 pt-px text-meta text-tertiary">{relativeTime(view.updatedAt, now)}</span>
      </button>
    </li>
  )
}

export function SessionList({
  sessions,
  selectedSessionId,
  projectNameOf,
  onSelect,
  onNewSession,
  canCreate,
  now,
  children,
  className,
}: {
  /** Rendered above the sessions — the connected-agents roster (Phase J). */
  children?: React.ReactNode
  /** Layout classes from the view — used to make the list full-width master on narrow screens. */
  className?: string
  sessions: readonly CommandCentreSession[]
  selectedSessionId: string | null
  /** Resolves a project id to its name. Ids are internal and never shown. */
  projectNameOf: (projectId: string | undefined) => string | undefined
  onSelect: (sessionId: string) => void
  onNewSession: () => void
  canCreate: boolean
  /** Supplied by the caller so relative times tick without an impure render. */
  now: number
}) {
  const { active, ended } = useMemo(() => {
    const byRecency = [...sessions].sort((a, b) => b.view.updatedAt - a.view.updatedAt)
    return {
      active: byRecency.filter((session) => !isTerminalSession(session.view.status)),
      ended: byRecency.filter((session) => isTerminalSession(session.view.status)),
    }
  }, [sessions])

  return (
    // Narrower where the centre needs the width; full size once the context
    // panel is affordable too. See context-panel.tsx for the column budget.
    <div className={cn("flex h-full min-h-0 w-60 shrink-0 flex-col border-r border-subtle bg-sidebar xl:w-64", className)}>
      <div className="shrink-0 p-2">
        <button
          type="button"
          onClick={onNewSession}
          disabled={!canCreate}
          aria-label="New agent session"
          className="flex h-[30px] w-full items-center gap-2 rounded-xs px-2 text-left text-body text-foreground transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-45"
        >
          <Plus className="size-4 text-muted-foreground" aria-hidden />
          New session
        </button>
      </div>

      {children}

      <nav aria-label="Agent sessions" className="min-h-0 flex-1 overflow-y-auto pb-2">
        {sessions.length === 0 ? (
          <p className="px-3.5 py-2 text-body-sm text-tertiary">No sessions yet.</p>
        ) : (
          <>
            {active.length > 0 && (
              <>
                <h3 className="px-3 pt-2 pb-1 text-eyebrow text-muted-foreground">
                  In progress <span className="text-tertiary">{active.length}</span>
                </h3>
                <ul className="flex flex-col">
                  {active.map((session) => (
                    <SessionRow
                      key={session.view.sessionId}
                      session={session}
                      selected={session.view.sessionId === selectedSessionId}
                      projectName={projectNameOf(session.view.projectId)}
                      now={now}
                      onSelect={() => onSelect(session.view.sessionId)}
                    />
                  ))}
                </ul>
              </>
            )}

            {ended.length > 0 && (
              <>
                <h3 className="px-3 pt-4 pb-1 text-eyebrow text-muted-foreground">
                  Ended <span className="text-tertiary">{ended.length}</span>
                </h3>
                <ul className="flex flex-col">
                  {ended.map((session) => (
                    <SessionRow
                      key={session.view.sessionId}
                      session={session}
                      selected={session.view.sessionId === selectedSessionId}
                      projectName={projectNameOf(session.view.projectId)}
                      now={now}
                      onSelect={() => onSelect(session.view.sessionId)}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </nav>
    </div>
  )
}
