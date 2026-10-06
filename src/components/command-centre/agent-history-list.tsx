"use client"

import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { SessionListRow } from "./session-list"
import { historySessionStatus } from "@/lib/agents/activity/history"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { formatClockTime, formatDayLabel, formatFullTimestamp } from "@/lib/time-format"
import type { AgentHistoryListState } from "@/hooks/use-agent-history"
import type { AgentHistorySession } from "@/lib/agents/activity/history"

/**
 * Agent history: the workspace's past agent sessions, below the live ones.
 *
 *     HISTORY
 *     Today
 *       ● Organise pricing                       18:42
 *         Completed · Claude Code · Research
 *     Yesterday
 *       ● Codex                                  21:13
 *         Disconnected · Codex · Research
 *
 * The same row the live list draws (`SessionListRow`) — the same glyph, the
 * same status words, the same line of agent and workspace — so a session
 * looks the same before and after its runtime is gone. Grouped by day,
 * newest first, because a person looks for a past session by when.
 *
 * A session still held by the runtime is in the live list above and is not
 * repeated here (`hiddenSessionIds`). Its status is read for *now*: one that
 * was running when its runtime stopped says "Disconnected", never "Running"
 * (`historySessionStatus`).
 *
 * Unavailable, empty and failed are three different sentences, never one
 * blank space: "Agent history unavailable" is about this Hubble, "No agent
 * activity yet." is about this workspace, and a failed read can be retried.
 */


function Message({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="px-3.5 py-2">
      <p className="text-body-sm text-tertiary">{title}</p>
      {detail && <p className="mt-0.5 text-meta text-tertiary">{detail}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}

export function AgentHistoryList({
  state,
  selectedSessionId,
  onSelect,
  workspaceName,
  now,
  hiddenSessionIds,
  onLoadMore,
  onRetry,
}: {
  state: AgentHistoryListState
  selectedSessionId: string | null
  onSelect: (session: AgentHistorySession) => void
  /** The workspace whose history this is, by its live name. */
  workspaceName?: string
  /** Supplied by the caller, so day labels need no impure render. */
  now: number
  /** Sessions the live list already shows. */
  hiddenSessionIds?: ReadonlySet<string>
  onLoadMore?: () => void
  onRetry?: () => void
}) {
  const days = useMemo(() => {
    if (state.kind !== "ready") return []
    const groups: { label: string; sessions: AgentHistorySession[] }[] = []
    for (const session of state.sessions) {
      if (hiddenSessionIds?.has(session.sessionId)) continue
      const label = formatDayLabel(session.lastActivityAt, now)
      const last = groups[groups.length - 1]
      if (last?.label === label) last.sessions.push(session)
      else groups.push({ label, sessions: [session] })
    }
    return groups
  }, [state, hiddenSessionIds, now])

  if (state.kind === "idle") return null

  return (
    <section aria-label="Agent history">
      <h3 className="px-3 pt-4 pb-1 text-eyebrow text-muted-foreground">History</h3>

      {state.kind === "loading" && <Message title="Loading agent history…" />}

      {state.kind === "unavailable" && (
        <Message title="Agent history unavailable" detail="This Hubble doesn't keep past agent sessions. Live sessions still work." />
      )}

      {state.kind === "disconnected" && (
        <Message title="Agent history unavailable" detail="Hubble can't reach the agent runtime right now. Past sessions show again once it's back." />
      )}

      {state.kind === "failed" && (
        <Message
          title="Couldn't load agent history"
          {...(onRetry
            ? {
                action: (
                  <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
                    Try again
                  </Button>
                ),
              }
            : {})}
        />
      )}

      {state.kind === "ready" && days.length === 0 && <Message title="No agent activity yet." />}

      {days.map((day) => (
        <div key={day.label}>
          <p className="px-3.5 pt-2 pb-0.5 text-meta text-tertiary">{day.label}</p>
          <ul className="flex flex-col">
            {day.sessions.map((session) => {
              const status = historySessionStatus(session.status)
              const agentName = agentDisplayName(session.provider)
              const at = session.endedAt ?? session.lastActivityAt
              return (
                <SessionListRow
                  key={session.sessionId}
                  status={status}
                  title={session.title ?? agentName}
                  agentName={agentName}
                  {...(workspaceName ? { workspaceName } : {})}
                  time={formatClockTime(at)}
                  timeLabel={formatFullTimestamp(at)}
                  {...(session.handoff ? { handoff: session.handoff } : {})}
                  selected={session.sessionId === selectedSessionId}
                  onSelect={() => onSelect(session)}
                />
              )
            })}
          </ul>
        </div>
      ))}

      {state.kind === "ready" && state.hasMore && onLoadMore && (
        <div className="px-2 pt-1">
          <Button type="button" size="xs" variant="ghost" disabled={state.loadingMore} onClick={onLoadMore}>
            {state.loadingMore ? "Loading…" : "Show older sessions"}
          </Button>
        </div>
      )}
    </section>
  )
}
