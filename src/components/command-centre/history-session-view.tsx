"use client"

import { X } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AgentStatusPill } from "@/components/agents/agent-status-pill"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { historyClock, historyDayLabel } from "./agent-history-list"
import { HISTORY_LIMITS, historySessionStatus } from "@/lib/agents/activity/history"
import { SESSION_STATUS_LABEL, SESSION_VISUAL_STATE, sessionStatusTone } from "@/lib/agents/command-centre/presentation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import type { AgentHistorySessionState } from "@/hooks/use-agent-history"
import type { AgentHistorySession } from "@/lib/agents/activity/history"

/**
 * A past agent session, opened from agent history: who, where, how it
 * ended — and its activity, drawn by the caller with the same `AgentActivity`
 * (timeline ⇄ action inspector) the live session uses.
 *
 *     [mark]  Organise pricing                                ● Completed   ✕
 *             Claude Code · Worked in Research · Today 18:42
 *
 *     ACTIVITY
 *     Context loaded · Read workspace · … · Created collection “Pricing”
 *
 * There is no conversation and no composer: history keeps what an agent did,
 * not what was said (lib/agents/activity/history.ts), and a session whose
 * runtime is gone cannot be written to. The header is built from the very
 * pieces `SessionHeader` is — the mark, the title, the status pill — so it
 * reads as the same session, ended.
 */
export function HistorySessionView({
  session,
  state,
  workspaceName,
  now,
  onClose,
  onRetry,
  children,
}: {
  /** The session as the list read it — enough for the header while its records load. */
  session: AgentHistorySession
  state: AgentHistorySessionState
  workspaceName?: string
  now: number
  onClose: () => void
  onRetry?: () => void
  /** The session's activity, rendered by the caller (components/agents/agent-activity.tsx). */
  children?: React.ReactNode
}) {
  const shown = state.kind === "ready" ? state.detail.session : session
  const status = historySessionStatus(shown.status)
  const identity = agentVisualIdentity(shown.provider)
  const at = shown.endedAt ?? shown.lastActivityAt

  return (
    <section aria-label="Past agent session" className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="text-muted-foreground">
          <AgentIcon connector={shown.provider} state={SESSION_VISUAL_STATE[status]} size="sm" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-h2 text-foreground">{shown.title ?? identity.displayName}</h1>
          {/* The agent is named here only when the title is not already its name, as SessionHeader does. */}
          <p className="truncate text-meta text-tertiary">
            {[
              shown.title ? identity.displayName : undefined,
              workspaceName ? `Worked in ${workspaceName}` : undefined,
              `${historyDayLabel(at, now)} ${historyClock(at)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="max-sm:hidden">
            <AgentStatusPill tone={sessionStatusTone(status)} label={SESSION_STATUS_LABEL[status]} />
          </span>
          <IconButton aria-label="Close past session" onClick={onClose}>
            <X />
          </IconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-4">
          <h2 className="text-eyebrow text-muted-foreground">Activity</h2>
          <p className="mt-1 text-meta text-tertiary">Hubble keeps what the agent did in this workspace, not the conversation.</p>
          <div className="mt-3">
            {state.kind === "loading" || state.kind === "idle" ? (
              <p className="text-body-sm text-tertiary">Loading this session…</p>
            ) : state.kind === "unavailable" ? (
              <p className="text-body-sm text-tertiary">Agent history unavailable</p>
            ) : state.kind === "missing" ? (
              <p className="text-body-sm text-tertiary">This session isn&apos;t in this workspace&apos;s history any more.</p>
            ) : state.kind === "failed" ? (
              <div>
                <p className="text-body-sm text-tertiary">Couldn&apos;t load this session.</p>
                {onRetry && (
                  <Button type="button" size="xs" variant="ghost" className="mt-1.5" onClick={onRetry}>
                    Try again
                  </Button>
                )}
              </div>
            ) : (
              <>
                {children}
                {state.detail.session.truncated && (
                  <p className="mt-3 text-meta text-tertiary">
                    Only the first {HISTORY_LIMITS.eventsPerSession.toLocaleString()} events of this session were kept.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
