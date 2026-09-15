"use client"

import { Bot, FileCode2, PlugZap } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { Pill } from "@/components/workspace/category-filter-bar"
import { AGENT_STATUS_VISUALS } from "./agent-node-renderer"
import { AGENT_FILTER_LABELS, AGENT_SPATIAL_FILTERS } from "@/lib/agents/spatial/types"
import type { AgentSearchResult } from "@/lib/agents/spatial/search"
import type {
  AgentSpatialFilter,
  AgentSpatialNodeUnion,
  SpatialId,
} from "@/lib/agents/spatial/types"
import type { AgentEvent, AgentRunArtifactRole, AgentRunLinkRole } from "@/lib/agents/types"

/**
 * The Graph sidebar's "AGENT" section.
 *
 * Mirrors GraphDependencyPanel and GraphCollectionPanel's role for their own
 * selections rather than introducing a second inspector: it is another section
 * in the existing sidebar, not a dashboard and not a modal.
 *
 * It is the **accessibility fallback** as much as a convenience. Everything
 * the canvas expresses spatially — what a run is, what state it is in, what it
 * touched — is available here as linear, readable text, so understanding agent
 * work never depends on interpreting a graph.
 *
 * Strictly read-only. There is no control here that changes a run, and no
 * prop that would let one be added without changing this file's signature.
 */

/** What the panel needs about the selected entity. Assembled by the caller from domain selectors. */
export type AgentInspectorSelection =
  | { kind: "agent"; node: Extract<AgentSpatialNodeUnion, { kind: "agent" }>; recentRuns: InspectorRun[] }
  | {
      kind: "run"
      node: Extract<AgentSpatialNodeUnion, { kind: "run" }>
      agentName: string
      files: { artifactId: string; relativePath: string; role: AgentRunArtifactRole }[]
      tabs: { tabId: string; title: string; role: AgentRunLinkRole }[]
      events: AgentEvent[]
      startedAt: number
      endedAt?: number
    }
  | {
      kind: "artifact"
      node: Extract<AgentSpatialNodeUnion, { kind: "artifact" }>
      touchedBy: { runId: string; runTitle: string; agentName: string; role: AgentRunArtifactRole }[]
    }

export type InspectorRun = {
  runId: string
  title: string
  status: keyof typeof AGENT_STATUS_VISUALS
}

/** Status as text plus a glyph — never colour alone, and readable by a screen reader. */
function StatusLine({ status }: { status: keyof typeof AGENT_STATUS_VISUALS }) {
  const visual = AGENT_STATUS_VISUALS[status]
  return (
    <p className="text-meta text-tertiary">
      <span aria-hidden>{visual.glyph} </span>
      <span>{visual.label}</span>
    </p>
  )
}

function formatWhen(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return new Date(value).toLocaleString()
}

/** Groups a run's files by role, so "edited" and "inspected" read as separate lists. */
function groupByRole<T extends { role: string }>(items: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const bucket = groups.get(item.role)
    if (bucket) bucket.push(item)
    else groups.set(item.role, [item])
  }
  return [...groups.entries()]
}

export function GraphAgentPanel({
  available,
  filter,
  onFilterChange,
  selection,
  hiddenRunCount,
  hasAnyAgentData,
  hasVisibleRuns,
  searchQuery,
  searchResults,
  onSelectResult,
  onSelectRun,
}: {
  /** False when the provider cannot currently be observed. Distinct from "no data". */
  available: boolean
  filter: AgentSpatialFilter
  onFilterChange: (filter: AgentSpatialFilter) => void
  selection: AgentInspectorSelection | null
  hiddenRunCount: number
  /** Whether this workspace has any agent runs at all, regardless of filter. */
  hasAnyAgentData: boolean
  hasVisibleRuns: boolean
  searchQuery: string
  searchResults: AgentSearchResult[]
  onSelectResult: (id: SpatialId) => void
  onSelectRun: (runId: string) => void
}) {
  return (
    <section
      aria-labelledby="agent-panel-heading"
      className="space-y-4 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0"
    >
      <p id="agent-panel-heading" className="text-label text-tertiary">
        AGENT
      </p>

      <div role="group" aria-label="Filter agent runs" className="flex flex-wrap gap-1">
        {AGENT_SPATIAL_FILTERS.map((option) => (
          <Pill key={option} active={filter === option} onClick={() => onFilterChange(option)}>
            {AGENT_FILTER_LABELS[option]}
          </Pill>
        ))}
      </div>

      {searchQuery.trim() &&
        (searchResults.length === 0 ? (
          <p className="px-1 py-1 text-body-sm text-tertiary">
            No agent work matches &ldquo;{searchQuery}&rdquo;.
          </p>
        ) : (
          <ul className="space-y-0.5" aria-label="Agent search results">
            {searchResults.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => onSelectResult(result.id)}
                  className="block w-full rounded-md px-1.5 py-1 text-left transition-colors duration-(--duration-fast) hover:bg-accent"
                >
                  <span className="block truncate text-body-sm text-foreground">{result.label}</span>
                  <span className="block truncate text-meta text-tertiary">
                    {result.typeLabel}
                    {result.detail ? ` · ${result.detail}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      <AgentPanelBody
        available={available}
        selection={selection}
        hasAnyAgentData={hasAnyAgentData}
        hasVisibleRuns={hasVisibleRuns}
        hiddenRunCount={hiddenRunCount}
        onSelectRun={onSelectRun}
      />
    </section>
  )
}

function AgentPanelBody({
  available,
  selection,
  hasAnyAgentData,
  hasVisibleRuns,
  hiddenRunCount,
  onSelectRun,
}: {
  available: boolean
  selection: AgentInspectorSelection | null
  hasAnyAgentData: boolean
  hasVisibleRuns: boolean
  hiddenRunCount: number
  onSelectRun: (runId: string) => void
}) {
  if (selection) return <AgentInspector selection={selection} onSelectRun={onSelectRun} />

  // Unavailable and empty are genuinely different states and must not collapse
  // into one message: one says "we cannot look right now", the other says "we
  // looked and there is nothing". Conflating them would either hide a real
  // connection problem or invent one.
  if (!available) {
    return (
      <EmptyState
        icon={PlugZap}
        title="Claude Code unavailable"
        description={
          hasAnyAgentData
            ? "This workspace still shows previously observed agent activity."
            : "Agent activity cannot be observed on this machine right now."
        }
      />
    )
  }

  if (!hasAnyAgentData) {
    return (
      <EmptyState
        icon={Bot}
        title="No agent activity in this workspace."
        description="Agent activity appears here when a connected agent works in this workspace."
      />
    )
  }

  if (!hasVisibleRuns) {
    return (
      <EmptyState
        icon={Bot}
        title="No runs match this filter."
        description={
          hiddenRunCount > 0
            ? `${hiddenRunCount} run${hiddenRunCount === 1 ? "" : "s"} hidden. Try a different filter.`
            : undefined
        }
      />
    )
  }

  return (
    <p className="text-body-sm text-muted-foreground">
      Select an agent, a run, or a file to see its details.
    </p>
  )
}

function AgentInspector({
  selection,
  onSelectRun,
}: {
  selection: AgentInspectorSelection
  onSelectRun: (runId: string) => void
}) {
  if (selection.kind === "agent") {
    const { node, recentRuns } = selection
    return (
      <div className="space-y-3">
        <div>
          <p className="truncate text-body font-medium text-foreground">{node.label}</p>
          <p className="text-meta text-tertiary">{node.provider}</p>
        </div>
        <StatusLine status={node.status} />
        <p className="text-meta text-tertiary">
          {node.activeRunCount} active · {node.totalRunCount} total
        </p>

        {recentRuns.length > 0 && (
          <div className="space-y-1">
            <p className="text-label text-tertiary">RECENT RUNS</p>
            <ul className="space-y-0.5">
              {recentRuns.map((run) => (
                <li key={run.runId}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(run.runId)}
                    className="block w-full rounded-md px-1.5 py-1 text-left transition-colors duration-(--duration-fast) hover:bg-accent"
                  >
                    <span className="block truncate text-body-sm text-foreground">{run.title}</span>
                    <span className="block text-meta text-tertiary">
                      {AGENT_STATUS_VISUALS[run.status].label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  if (selection.kind === "artifact") {
    const { node, touchedBy } = selection
    return (
      <div className="space-y-3">
        <div>
          <p className="truncate text-body font-medium text-foreground">{node.label}</p>
          {/* Project-relative, never the absolute path — see lib/agents/paths.ts. */}
          <p className="break-all text-meta text-tertiary">{node.relativePath}</p>
        </div>
        <p className="text-meta text-tertiary">File</p>

        {touchedBy.length > 0 && (
          <div className="space-y-1">
            <p className="text-label text-tertiary">WORKED ON BY</p>
            <ul className="space-y-0.5">
              {touchedBy.map((entry) => (
                <li key={`${entry.runId}:${entry.role}`}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(entry.runId)}
                    className="block w-full rounded-md px-1.5 py-1 text-left transition-colors duration-(--duration-fast) hover:bg-accent"
                  >
                    <span className="block truncate text-body-sm text-foreground">
                      {entry.agentName} — {entry.runTitle}
                    </span>
                    <span className="block text-meta text-tertiary">{entry.role}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  const { node, agentName, files, tabs, events, startedAt, endedAt } = selection
  const started = formatWhen(startedAt)
  const ended = formatWhen(endedAt)
  const lastActivity = formatWhen(node.updatedAt)

  return (
    <div className="space-y-3">
      <div>
        <p className="truncate text-body font-medium text-foreground">{node.label}</p>
        <p className="text-meta text-tertiary">{agentName}</p>
      </div>

      <StatusLine status={node.status} />

      {node.activity && <p className="text-body-sm text-muted-foreground">{node.activity}</p>}

      {/* Counts are omitted rather than shown as zero: "0 tabs" reads as a
          measured fact, when the honest reading is that there are none to
          mention. */}
      <p className="text-meta text-tertiary">
        {[
          files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"}` : null,
          tabs.length > 0 ? `${tabs.length} tab${tabs.length === 1 ? "" : "s"}` : null,
          events.length > 0 ? `${events.length} event${events.length === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "No recorded work yet."}
      </p>

      {(started || ended || lastActivity) && (
        <dl className="space-y-0.5 text-meta text-tertiary">
          {started && (
            <div className="flex gap-2">
              <dt>Started</dt>
              <dd>{started}</dd>
            </div>
          )}
          {lastActivity && (
            <div className="flex gap-2">
              <dt>Last activity</dt>
              <dd>{lastActivity}</dd>
            </div>
          )}
          {ended && (
            <div className="flex gap-2">
              <dt>Ended</dt>
              <dd>{ended}</dd>
            </div>
          )}
        </dl>
      )}

      {files.length > 0 && (
        <div className="space-y-1">
          <p className="text-label text-tertiary">FILES</p>
          {groupByRole(files).map(([role, group]) => (
            <div key={role} className="space-y-0.5">
              <p className="text-meta text-tertiary">{role}</p>
              <ul className="space-y-0.5">
                {group.map((file) => (
                  <li
                    key={`${file.artifactId}:${file.role}`}
                    className="flex items-start gap-1.5 px-1.5 py-0.5"
                  >
                    <FileCode2 className="mt-0.5 size-3.5 shrink-0 text-tertiary" aria-hidden />
                    <span className="min-w-0 break-all text-body-sm text-foreground">
                      {file.relativePath}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tabs.length > 0 && (
        <div className="space-y-1">
          {/* Tabs are kept visibly separate from files: one is the human's
              context surface, the other is the agent's work target. */}
          <p className="text-label text-tertiary">TABS</p>
          {groupByRole(tabs).map(([role, group]) => (
            <div key={role} className="space-y-0.5">
              <p className="text-meta text-tertiary">{role}</p>
              <ul className="space-y-0.5">
                {group.map((tab) => (
                  <li key={`${tab.tabId}:${tab.role}`} className="truncate px-1.5 py-0.5 text-body-sm text-foreground">
                    {tab.title}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {events.length > 0 && (
        <div className="space-y-1">
          <p className="text-label text-tertiary">RECENT ACTIVITY</p>
          <ul className="space-y-0.5">
            {events.map((event) => (
              <li key={event.id} className="truncate px-1.5 py-0.5 text-body-sm text-muted-foreground">
                {event.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
