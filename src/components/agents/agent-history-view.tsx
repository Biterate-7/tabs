"use client"

import { useMemo, useState } from "react"
import { ChevronLeft, History } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { useAgentIntelligence } from "@/hooks/use-agent-intelligence"
import { buildAgentHistory } from "@/lib/agents/history/build"
import { AGENT_RUN_STATUSES } from "@/lib/agents/types"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"
import { NO_RUN_TITLE, RUN_STATUS_WORDS, formatTimeAgo } from "./agent-session-presentation"
import type { AgentStoreApi } from "@/hooks/use-agent-store"
import type { AgentHistoryEntry, AgentHistoryFilter, AgentHistoryView as HistoryModel } from "@/lib/agents/history/types"
import type { AgentRunStatus } from "@/lib/agents/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * Agent History: the durable way back to a session.
 *
 * ## Why this is not the Agent World
 *
 * The world answers "who is working now?" and is allowed to forget: it draws
 * live runs and ones that finished inside the last six hours, because a room
 * showing last week is not showing a room. This answers "what happened?",
 * and it reads `buildAgentHistory`, which never consults that window. A run
 * that has aged out of the canvas is an ordinary row here.
 *
 * That is the entire reason the surface exists, so it is worth being precise
 * about what was *not* done to achieve it: `RECENT_RUN_WINDOW_MS` is
 * unchanged, the canvas still shows only current work, and nothing in this
 * file imports the spatial or world layers.
 *
 * ## Read-only
 *
 * Every control here selects or filters. Nothing writes to the domain, and
 * there is no affordance to run, retry, resume or cancel anything - TabDump
 * records agent work and never performs it.
 */

/** Everything the history screen needs, with no store attached. Keeps it testable. */
export type AgentHistoryScreenProps = {
  history: HistoryModel
  filter: AgentHistoryFilter
  onFilterChange: (filter: AgentHistoryFilter) => void
  /** The clock used for relative times only. Never for deriving activity. */
  now: number
  onOpenSession: (runId: string) => void
  onClose: () => void
}

/**
 * One filter control.
 *
 * A native `<select>` rather than a custom menu: three exact-match filters
 * do not justify a popover, and the native control is keyboard- and
 * screen-reader-correct without any work. Each carries a visible label, so
 * the accessible name does not depend on placeholder text.
 */
function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-label text-tertiary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 rounded-md border border-subtle bg-background px-2 py-1 text-body-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * The counts line: "2 files · 3 tabs · 4 events".
 *
 * Only non-zero counts appear. A row reading "0 files · 0 tabs · 0 events"
 * says nothing three times, and its absence already says the run touched
 * nothing. Returns null rather than an empty element so the row collapses.
 */
function countsLabel(entry: AgentHistoryEntry): string | null {
  const parts: string[] = []
  if (entry.workItemCount > 0) {
    parts.push(`${entry.workItemCount} ${entry.workItemCount === 1 ? "task" : "tasks"}`)
  }
  if (entry.artifactCount > 0) {
    parts.push(`${entry.artifactCount} ${entry.artifactCount === 1 ? "file" : "files"}`)
  }
  if (entry.tabCount > 0) {
    parts.push(`${entry.tabCount} ${entry.tabCount === 1 ? "tab" : "tabs"}`)
  }
  if (entry.eventCount > 0) {
    parts.push(`${entry.eventCount} ${entry.eventCount === 1 ? "event" : "events"}`)
  }
  return parts.length === 0 ? null : parts.join(" · ")
}

/**
 * One session row.
 *
 * A single button, so the whole row is one tab stop and one target. Its
 * accessible name is composed in `aria-label` rather than left to the
 * concatenated text, because the visible content is five fragments and a
 * screen reader reading them in sequence would not say which is the agent
 * and which is the workspace.
 *
 * Status appears as a word, never as colour alone.
 */
function HistoryRow({
  entry,
  now,
  onOpen,
}: {
  entry: AgentHistoryEntry
  now: number
  onOpen: () => void
}) {
  const title = entry.title ?? NO_RUN_TITLE
  const statusWord = RUN_STATUS_WORDS[entry.status]
  const when = formatTimeAgo(entry.lastActivityAt ?? entry.updatedAt, now)
  const counts = countsLabel(entry)

  // "Unknown agent" is a statement about the record, not a stand-in identity.
  // Nothing here falls back to another agent's name or mark.
  const agentName = entry.agentName ?? "Unknown agent"

  const accessibleName = [
    agentName,
    entry.workspaceName ?? "Unknown workspace",
    statusWord,
    title,
    counts,
    when,
  ]
    .filter(Boolean)
    .join(", ")

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={accessibleName}
        className="flex w-full items-start gap-2.5 rounded-lg border border-subtle px-2.5 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {/* A run whose agent is gone gets the fallback mark, which is what
            the visual registry already returns for an unknown provider. */}
        <AgentIcon connector={entry.provider ?? ""} state="idle" size="sm" />

        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-body-sm font-medium text-foreground">{agentName}</span>
            {entry.workspaceName ? (
              <span className="text-meta text-tertiary">{entry.workspaceName}</span>
            ) : null}
            <span className="text-meta text-tertiary">{statusWord}</span>
          </span>

          <span
            className={cn(
              "block truncate text-body-sm",
              // A fallback line is muted so it never reads as a title the
              // agent actually wrote.
              entry.title ? "text-foreground" : "italic text-muted-foreground"
            )}
          >
            {title}
          </span>

          <span className="block truncate text-meta text-tertiary">
            {[counts, when].filter(Boolean).join(" · ")}
          </span>
        </span>
      </button>
    </li>
  )
}

export function AgentHistoryScreen({
  history,
  filter,
  onFilterChange,
  now,
  onOpenSession,
  onClose,
}: AgentHistoryScreenProps) {
  const filtered = history.entries.length
  const total = history.totalCount

  return (
    <div
      className="relative flex h-screen min-w-0 flex-1 flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <header className="flex items-center gap-2 border-b border-subtle px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-3">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-h2 text-foreground">Agent History</h1>
          <p className="truncate text-body-sm text-muted-foreground">
            Every agent session TabDump still holds, however long ago it ran.
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          {total > 0 ? (
            <section aria-labelledby="agent-history-filters-heading" className="space-y-1.5">
              <h2 id="agent-history-filters-heading" className="text-label text-tertiary">
                FILTER
              </h2>
              <div className="flex flex-wrap gap-2">
                <FilterSelect
                  id="agent-history-filter-agent"
                  label="Agent"
                  value={filter.agentId ?? ""}
                  onChange={(value) =>
                    onFilterChange({ ...filter, agentId: value === "" ? undefined : value })
                  }
                  options={[
                    { value: "", label: `All agents (${total})` },
                    ...history.agents.map((facet) => ({
                      value: facet.agentId,
                      label: `${facet.name ?? "Unknown agent"} (${facet.runCount})`,
                    })),
                  ]}
                />
                <FilterSelect
                  id="agent-history-filter-workspace"
                  label="Workspace"
                  value={filter.workspaceId ?? ""}
                  onChange={(value) =>
                    onFilterChange({ ...filter, workspaceId: value === "" ? undefined : value })
                  }
                  options={[
                    { value: "", label: "All workspaces" },
                    ...history.workspaces.map((facet) => ({
                      value: facet.workspaceId,
                      label: `${facet.name ?? "Unknown workspace"} (${facet.runCount})`,
                    })),
                  ]}
                />
                <FilterSelect
                  id="agent-history-filter-status"
                  label="Status"
                  value={filter.status ?? ""}
                  onChange={(value) =>
                    onFilterChange({
                      ...filter,
                      status: value === "" ? undefined : (value as AgentRunStatus),
                    })
                  }
                  options={[
                    { value: "", label: "Any status" },
                    ...AGENT_RUN_STATUSES.map((status) => ({
                      value: status,
                      label: RUN_STATUS_WORDS[status],
                    })),
                  ]}
                />
              </div>
            </section>
          ) : null}

          <section aria-labelledby="agent-history-sessions-heading" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="agent-history-sessions-heading" className="text-label text-tertiary">
                SESSIONS
              </h2>
              {total > 0 ? (
                <p className="text-meta text-tertiary">
                  {filtered === total ? `${total} total` : `${filtered} of ${total}`}
                </p>
              ) : null}
            </div>

            {total === 0 ? (
              /* Nothing has been recorded at all. Distinguished from "your
                 filter matched nothing" below, because they call for
                 different next actions. */
              <div className="rounded-xl border border-subtle bg-background-secondary p-6 text-center">
                <History className="mx-auto size-5 text-tertiary" aria-hidden />
                <p className="mt-2 text-body font-medium text-foreground">
                  No agent sessions recorded yet
                </p>
                <p className="mx-auto mt-1 max-w-sm text-body-sm text-muted-foreground">
                  Sessions appear here once a connected AI agent has worked in a workspace. They
                  stay after the agent finishes.
                </p>
              </div>
            ) : filtered === 0 ? (
              <div className="rounded-xl border border-subtle bg-background-secondary p-6 text-center">
                <p className="text-body-sm text-muted-foreground">
                  No sessions match this filter.
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {history.entries.map((entry) => (
                  <HistoryRow
                    key={entry.runId}
                    entry={entry}
                    now={now}
                    onOpen={() => onOpenSession(entry.runId)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

export type AgentHistoryViewProps = {
  store: WorkspaceStore
  /** The domain, mounted once at the shell. Never a second `useAgentStore`. */
  agentStore: AgentStoreApi
  onOpenSession: (runId: string) => void
  onClose: () => void
}

/**
 * The container.
 *
 * Mirrors `AgentWorldView`'s shape: read the domain the shell mounted, build
 * the index once, own nothing that writes back. Unlike that view it is not
 * scoped to the current workspace - history spans all of them, which is the
 * point, and the workspace filter is how a user narrows it by choice rather
 * than by where they happen to be standing.
 */
export function AgentHistoryView({
  store,
  agentStore,
  onOpenSession,
  onClose,
}: AgentHistoryViewProps) {
  const [filter, setFilter] = useState<AgentHistoryFilter>({})

  // Built once per state object and shared with every other agent surface.
  // `workspaceId` is the current one only so the hook's other consumers are
  // unaffected; history itself reads `runsByWorkspace` across the board.
  const intelligence = useAgentIntelligence({
    state: agentStore.state,
    workspaceId: store.currentId,
  })

  const workspaceNames = useMemo(
    () => new Map(store.workspaces.map((workspace) => [workspace.id, workspace.name])),
    [store.workspaces]
  )

  const history = useMemo(
    () => buildAgentHistory({ index: intelligence.index, workspaceNames, filter }),
    [intelligence.index, workspaceNames, filter]
  )

  // Read once per mount rather than on a timer. Relative labels are a
  // convenience on a record that is not changing, and a ticking clock would
  // re-render the whole list to move "2 hr" to "2 hr 1 min".
  const [now] = useState(() => Date.now())

  return (
    <AgentHistoryScreen
      history={history}
      filter={filter}
      onFilterChange={setFilter}
      now={now}
      onOpenSession={onOpenSession}
      onClose={onClose}
    />
  )
}
