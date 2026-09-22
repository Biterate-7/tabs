"use client"

import { useMemo } from "react"
import { Plus } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { Button } from "@/components/ui/button"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
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

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        // `aria-current` rather than a class alone: the selected row is a
        // navigational fact, and the rail elsewhere in this app marks its
        // active destination the same way.
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          selected ? "bg-surface-selected" : "hover:bg-surface-hover"
        )}
      >
        <AgentIcon connector={view.provider} state={state} size="xs" />

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body-sm text-foreground">
            {view.title ?? SESSION_STATUS_LABEL[view.status]}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={cn("truncate text-label", AGENT_TONE_TEXT_CLASS[sessionStatusTone(view.status)])}
            >
              {SESSION_STATUS_LABEL[view.status]}
            </span>
            {projectName && (
              <span className="truncate text-label text-tertiary">· {projectName}</span>
            )}
          </span>
        </span>

        <span className="shrink-0 text-meta text-tertiary">
          {relativeTime(view.updatedAt, now)}
        </span>
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
}: {
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
    <div className="flex h-full min-h-0 w-64 shrink-0 flex-col border-r border-subtle">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-subtle px-3">
        <h2 className="text-eyebrow text-tertiary">Sessions</h2>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onNewSession}
          disabled={!canCreate}
          aria-label="New agent session"
        >
          <Plus />
          New
        </Button>
      </div>

      <nav aria-label="Agent sessions" className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-1 text-body-sm text-tertiary">No sessions yet.</p>
        ) : (
          <>
            {active.length > 0 && (
              <>
                <h3 className="px-2 pt-1 pb-1 text-eyebrow text-tertiary">
                  Active {active.length}
                </h3>
                <ul className="flex flex-col gap-0.5">
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
                <h3 className="px-2 pt-3 pb-1 text-eyebrow text-tertiary">Ended {ended.length}</h3>
                <ul className="flex flex-col gap-0.5">
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
