"use client"

import { Bot, FileCode2, PlugZap } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"
import { Pill } from "@/components/workspace/category-filter-bar"
import { AgentActivityList, AgentLoadingState } from "@/components/agents/agent-activity-list"
import { AgentIcon } from "@/components/agents/agent-icon"
import { visualStateForConnector, visualStateForRun } from "@/lib/agents/visual/states"
import { cn } from "@/lib/utils"
import { AGENT_STATUS_VISUALS } from "./agent-node-renderer"
import type { AgentActivityItem } from "@/components/agents/agent-activity-list"
import type { ConnectorStatusKind } from "@/lib/agents/connectors/types"
import { AGENT_FILTER_LABELS, AGENT_SPATIAL_FILTERS } from "@/lib/agents/spatial/types"
import type { AgentSearchResult } from "@/lib/agents/spatial/search"
import type { AgentRunSummary } from "@/lib/agents/intelligence/types"
import type {
  AgentSpatialFilter,
  AgentSpatialNodeUnion,
  SpatialId,
  WorkItemSummary,
} from "@/lib/agents/spatial/types"
import type {
  AgentEvent,
  AgentRunArtifactRole,
  AgentRunLinkRole,
  AgentRunStatus,
  AgentWorkItemStatus,
} from "@/lib/agents/types"

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
      /** This run's work items, in plan order. Empty when none were observed. */
      workItems: WorkItemSummary[]
      /**
       * Phase 16's derived summary of the run.
       *
       * Optional: a caller that does not build the intelligence index renders
       * exactly the Phase 15 inspector, with no derived section at all.
       */
      summary?: AgentRunSummary
      startedAt: number
      endedAt?: number
    }
  | {
      kind: "artifact"
      node: Extract<AgentSpatialNodeUnion, { kind: "artifact" }>
      touchedBy: { runId: string; runTitle: string; agentName: string; role: AgentRunArtifactRole }[]
    }
  | {
      /**
       * One unit of work, selected in its own right.
       *
       * Carries its run's context — files, tabs, events — rather than linking
       * away to it, because "what was touched while doing this" is the
       * question a selected work item raises, and making the user select the
       * run to answer it would lose the item they were looking at.
       */
      kind: "workItem"
      item: WorkItemSummary
      runTitle: string
      runSpatialId: SpatialId
      runStatus?: AgentRunStatus
      agentName: string
      provider: string
      files: { artifactId: string; relativePath: string; role: AgentRunArtifactRole }[]
      tabs: { tabId: string; title: string; role: AgentRunLinkRole }[]
      events: AgentEvent[]
      /** The owning run's derived summary, when the caller built an index. */
      runSummary?: AgentRunSummary
    }

export type InspectorRun = {
  runId: string
  title: string
  status: keyof typeof AGENT_STATUS_VISUALS
}

/**
 * Work item status presentation.
 *
 * A glyph *and* a word for each, mirroring AGENT_STATUS_VISUALS: status must
 * never be carried by colour alone, and a screen reader must be able to read
 * the state out as a word rather than announce a coloured dot.
 *
 * The glyphs deliberately differ from the run glyphs — an active work item is
 * not the same kind of thing as a working run, and reusing the same mark would
 * suggest they are interchangeable.
 */
export const WORK_ITEM_STATUS_VISUALS: Record<
  AgentWorkItemStatus,
  { glyph: string; label: string }
> = {
  pending: { glyph: "○", label: "Pending" },
  active: { glyph: "◐", label: "Active" },
  blocked: { glyph: "▲", label: "Blocked" },
  completed: { glyph: "✓", label: "Completed" },
  cancelled: { glyph: "—", label: "Cancelled" },
}

/**
 * Progress as text, or nothing at all.
 *
 * Returns null when there is no progress to report, which is the common case.
 * The caller renders nothing rather than an empty bar — a 0% indicator is a
 * claim that nothing has been done, when the truth is that nothing was
 * counted. See the domain notes on evidence-based progress.
 */
function progressLabel(progress: { completed: number; total: number } | undefined): string | null {
  if (!progress || progress.total <= 0) return null
  return `${progress.completed} of ${progress.total} done`
}

/** One work item row: glyph, title, and its state in words. */
function WorkItemRow({
  item,
  onSelect,
}: {
  item: WorkItemSummary
  onSelect: (id: SpatialId) => void
}) {
  const visual = WORK_ITEM_STATUS_VISUALS[item.status]
  const progress = progressLabel(item.progress)

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        // The accessible name carries the state in words, so the row does not
        // depend on the glyph (or its colour) being perceived.
        aria-label={`${item.title} — ${visual.label}${progress ? `, ${progress}` : ""}`}
        className="block w-full rounded-md px-1.5 py-1 text-left transition-colors duration-(--duration-fast) hover:bg-accent"
      >
        <span className="block truncate text-body-sm text-foreground">
          <span aria-hidden>{visual.glyph} </span>
          {item.title}
        </span>
        <span className="block truncate text-meta text-tertiary">
          {visual.label}
          {progress ? ` · ${progress}` : ""}
        </span>
      </button>
    </li>
  )
}

/**
 * A run's work items, with a heading that states the tally.
 *
 * Renders nothing when there are none — §17's "run exists but has no work
 * item" state is an absence, not a message, because a run legitimately has no
 * observed plan and saying so on every run would be noise.
 */
function WorkItemList({
  items,
  onSelect,
}: {
  items: WorkItemSummary[]
  onSelect: (id: SpatialId) => void
}) {
  if (items.length === 0) return null

  // Counted from the items actually shown, so the heading can never disagree
  // with the list under it.
  const done = items.filter((item) => item.status === "completed").length
  const countable = items.filter((item) => item.status !== "cancelled").length

  return (
    <div className="space-y-1">
      <p className="text-label text-tertiary">WORK</p>
      {countable > 0 && (
        <p className="text-meta text-tertiary">{done} of {countable} done</p>
      )}
      <ul className="space-y-0.5" aria-label="Work items">
        {items.map((item) => (
          <WorkItemRow key={item.id} item={item} onSelect={onSelect} />
        ))}
      </ul>
    </div>
  )
}

/**
 * A run's derived summary.
 *
 * Phase 16's contribution to the inspector: the per-status breakdown of the
 * run's work, its reach across files and tabs split by role, and a progress
 * line that is always a count of real items.
 *
 * Every figure is omitted when there is nothing to report, rather than shown
 * as zero. "0 files" reads as a measurement; the honest reading is that there
 * are none to mention. The whole section disappears for a run nothing has
 * been observed about, which is the common case for Claude Code.
 */
function RunSummarySection({ summary }: { summary: AgentRunSummary }) {
  const { workItems, progress } = summary

  // Counts worth naming, in attention order. Cancelled is deliberately last
  // and blocked deliberately first: abandoned work is the least urgent thing
  // on the list, and stuck work is the most.
  const breakdown = [
    workItems.blocked > 0 ? `${workItems.blocked} blocked` : null,
    workItems.active > 0 ? `${workItems.active} active` : null,
    workItems.pending > 0 ? `${workItems.pending} pending` : null,
    workItems.completed > 0 ? `${workItems.completed} completed` : null,
    workItems.cancelled > 0 ? `${workItems.cancelled} cancelled` : null,
  ].filter(Boolean)

  const reach = [
    summary.artifactCount > 0
      ? `${summary.artifactCount} file${summary.artifactCount === 1 ? "" : "s"}`
      : null,
    summary.contextTabCount > 0 ? `${summary.contextTabCount} context` : null,
    summary.producedTabCount > 0 ? `${summary.producedTabCount} produced` : null,
  ].filter(Boolean)

  if (breakdown.length === 0 && reach.length === 0 && !progress) return null

  return (
    <div className="space-y-1">
      <p className="text-label text-tertiary">SUMMARY</p>

      {/* Derived from real item statuses — never from elapsed time, event
          volume, or a session going quiet. */}
      {progress && (
        <p className="text-body-sm text-foreground">
          {progress.completed} / {progress.total} complete
        </p>
      )}

      {breakdown.length > 0 && <p className="text-meta text-tertiary">{breakdown.join(" · ")}</p>}

      {reach.length > 0 && <p className="text-meta text-tertiary">{reach.join(" · ")}</p>}

      {/* Blocked work is called out in words, not by colour, and never
          folded into "inactive": it is neither finished nor failed. */}
      {workItems.blocked > 0 && (
        <p className="text-body-sm text-foreground">
          <span aria-hidden>{WORK_ITEM_STATUS_VISUALS.blocked.glyph} </span>
          {workItems.blocked} work item{workItems.blocked === 1 ? " is" : "s are"} blocked
        </p>
      )}
    </div>
  )
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

/**
 * One connected provider, as the workspace sees it.
 *
 * A view model rather than the connector itself, so the panel stays a pure
 * presentational component and cannot reach a connector's lifecycle. There is
 * no `onConnect` here and no `onDisconnect`: connecting is a settings action,
 * and a control that changed observation from inside the graph sidebar would
 * put a system-level switch in a place people click while exploring.
 */
export type AgentPanelConnector = {
  provider: string
  displayName: string
  /** Already-resolved status word — the panel does not know the status vocabulary. */
  statusLabel: string
  connected: boolean
  /**
   * The connector's raw status kind, so the strip can show the agent's mark in
   * the state it is actually in.
   *
   * Optional, and its absence is handled rather than assumed: a caller that
   * has not supplied it gets a resting mark, which is the honest default for
   * "we were not told".
   */
  statusKind?: ConnectorStatusKind
}

/**
 * The unified agent strip.
 *
 * Every provider the user has connected, with the state it is actually in.
 * Nothing is listed that was not connected, and nothing shows activity that
 * was not observed — a provider that is connected and has done nothing says
 * so, rather than being given a hopeful dot.
 */
function ConnectorStrip({ connectors }: { connectors: AgentPanelConnector[] }) {
  if (connectors.length === 0) return null

  return (
    <ul aria-label="Connected agents" className="space-y-0.5">
      {connectors.map((entry) => (
        <li key={entry.provider} className="flex items-center gap-2">
          {/* Who, then what state. The mark identifies the provider; the dot
              beside it says whether it is observing. Two marks because they
              answer two questions, and because status must never be carried
              by an identity's colour. */}
          <AgentIcon
            connector={entry.provider}
            state={entry.statusKind ? visualStateForConnector(entry.statusKind) : "idle"}
            size="sm"
          />
          <span
            className={cn("text-body-sm leading-none", entry.connected ? "text-accent-text" : "text-tertiary")}
            aria-hidden
          >
            {entry.connected ? "●" : "○"}
          </span>
          <span className="min-w-0 flex-1 truncate text-meta text-foreground">{entry.displayName}</span>
          <span className="shrink-0 text-meta text-tertiary">{entry.statusLabel}</span>
        </li>
      ))}
    </ul>
  )
}

export function GraphAgentPanel({
  available,
  filter,
  onFilterChange,
  connectors = [],
  providers = [],
  providerFilter = null,
  onProviderFilterChange,
  providerLabels,
  selection,
  hiddenRunCount,
  hasAnyAgentData,
  hasVisibleRuns,
  searchQuery,
  searchResults,
  onSelectResult,
  onSelectRun,
  activity = [],
  selectedActivityId = null,
  onOpenWorld,
}: {
  /** False when the provider cannot currently be observed. Distinct from "no data". */
  available: boolean
  filter: AgentSpatialFilter
  onFilterChange: (filter: AgentSpatialFilter) => void
  /** Connected providers and their state. Empty when the user has connected none. */
  connectors?: AgentPanelConnector[]
  /** Providers with runs in this workspace. The filter appears only when there are two or more. */
  providers?: string[]
  providerFilter?: string | null
  onProviderFilterChange?: (provider: string | null) => void
  /** Provider id -> display name. Falls back to the id for a provider with no descriptor. */
  providerLabels?: Record<string, string>
  selection: AgentInspectorSelection | null
  hiddenRunCount: number
  /** Whether this workspace has any agent runs at all, regardless of filter. */
  hasAnyAgentData: boolean
  hasVisibleRuns: boolean
  searchQuery: string
  searchResults: AgentSearchResult[]
  onSelectResult: (id: SpatialId) => void
  onSelectRun: (runId: string) => void
  /**
   * The runs that are live right now, newest first.
   *
   * Each item's `id` is its run's spatial id, so selecting a row selects the
   * same thing clicking the card on the canvas would. Empty when nothing is
   * running, and the section then does not appear at all.
   */
  activity?: readonly AgentActivityItem[]
  selectedActivityId?: SpatialId | null
  /** Opens the Agent World. Absent when the user has turned it off. */
  onOpenWorld?: () => void
}) {
  // One provider is not a choice. The control appears the moment a second one
  // has worked here, and not before.
  const showProviderFilter = providers.length > 1 && onProviderFilterChange !== undefined

  return (
    <section
      aria-labelledby="agent-panel-heading"
      className="space-y-4 duration-(--duration-base) ease-(--ease-standard) animate-in fade-in-0"
    >
      <div className="flex items-center justify-between gap-2">
        <p id="agent-panel-heading" className="text-label text-tertiary">
          AI AGENTS
        </p>

        {/* The entry point into the world.

            It used to be gated on this workspace having agent history, on the
            principle that a button opening an empty room promises more than it
            delivers. That was true of the room it used to open. The world now
            has a real idle state — the connected agents standing in it, and a
            line saying what would make them work — so the gate was hiding the
            one view that explains the feature from exactly the people who had
            not found it yet. */}
        {onOpenWorld && (
          <button
            type="button"
            onClick={onOpenWorld}
            className="shrink-0 rounded-md border border-subtle px-2 py-0.5 text-meta text-muted-foreground transition-colors duration-(--duration-fast) hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Agent World
          </button>
        )}
      </div>

      <ConnectorStrip connectors={connectors} />

      {/* What is happening right now, with each agent's mark animating
          according to its own run's real state. Above the filters because it
          answers the question the panel is most often opened for, and it is
          not something the filters apply to. */}
      {activity.length > 0 && (
        <div className="space-y-1">
          <p className="text-label text-tertiary">NOW</p>
          <AgentActivityList
            items={activity}
            onSelect={onSelectResult}
            selectedId={selectedActivityId}
          />
        </div>
      )}

      <div role="group" aria-label="Filter agent runs" className="flex flex-wrap gap-1">
        {AGENT_SPATIAL_FILTERS.map((option) => (
          <Pill key={option} active={filter === option} onClick={() => onFilterChange(option)}>
            {AGENT_FILTER_LABELS[option]}
          </Pill>
        ))}
      </div>

      {showProviderFilter && (
        <div role="group" aria-label="Filter by agent" className="flex flex-wrap gap-1">
          <Pill active={providerFilter === null} onClick={() => onProviderFilterChange(null)}>
            All agents
          </Pill>
          {providers.map((provider) => (
            <Pill
              key={provider}
              active={providerFilter === provider}
              onClick={() => onProviderFilterChange(provider)}
            >
              {providerLabels?.[provider] ?? provider}
            </Pill>
          ))}
        </div>
      )}

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
        anyConnected={connectors.some((entry) => entry.connected)}
        anyConfigured={connectors.length > 0}
        // The one connector still establishing observation, if any. §27's
        // replacement for a bare "Loading…": the agent's own mark, in its
        // starting state, beside a sentence naming it. A real state with a
        // real duration, not a spinner standing in for one.
        connecting={connectors.find(
          (entry) =>
            entry.statusKind === "connecting" || entry.statusKind === "reconnecting"
        )}
        selection={selection}
        hasAnyAgentData={hasAnyAgentData}
        hasVisibleRuns={hasVisibleRuns}
        hiddenRunCount={hiddenRunCount}
        onSelectRun={onSelectRun}
        onSelectSpatial={onSelectResult}
      />
    </section>
  )
}

function AgentPanelBody({
  available,
  anyConnected,
  anyConfigured,
  connecting,
  selection,
  hasAnyAgentData,
  hasVisibleRuns,
  hiddenRunCount,
  onSelectRun,
  onSelectSpatial,
}: {
  available: boolean
  /** At least one connector is reporting `connected`. */
  anyConnected: boolean
  /** The user has enabled at least one connector, whatever state it is in. */
  anyConfigured: boolean
  /** A connector currently establishing observation, if there is one. */
  connecting?: AgentPanelConnector
  selection: AgentInspectorSelection | null
  hasAnyAgentData: boolean
  hasVisibleRuns: boolean
  hiddenRunCount: number
  onSelectRun: (runId: string) => void
  onSelectSpatial: (id: SpatialId) => void
}) {
  if (selection) return <AgentInspector selection={selection} onSelectRun={onSelectRun} onSelectSpatial={onSelectSpatial} />

  // Before any of the empty states: a connector that is mid-handshake has not
  // failed and has not finished, and saying "no agent activity" while it is
  // still connecting would be wrong in a way the user would act on.
  if (connecting && !hasVisibleRuns) {
    return <AgentLoadingState connector={connecting.provider} name={connecting.displayName} />
  }

  // Four states that all look like "nothing here", kept apart because they
  // call for four different things from the user: connect something, wait,
  // fix a connection, or change the filter. Collapsing any two of them would
  // either hide a real problem or invent one.
  if (!anyConfigured) {
    return (
      <EmptyState
        icon={Bot}
        title="No agents connected"
        description={
          hasAnyAgentData
            ? "This workspace still shows previously observed agent activity. Connect an agent in Settings → AI connectors to resume."
            : "Connect an agent in Settings → AI connectors to watch it work here."
        }
      />
    )
  }

  if (!anyConnected || !available) {
    return (
      <EmptyState
        icon={PlugZap}
        title="Agent not observable"
        description={
          hasAnyAgentData
            ? "This workspace still shows previously observed agent activity."
            : "A connected agent cannot be observed on this machine right now. Settings → AI connectors explains why."
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
  onSelectSpatial,
}: {
  selection: AgentInspectorSelection
  onSelectRun: (runId: string) => void
  /** Selects any spatial entity by id — used for work items and for the owning run. */
  onSelectSpatial: (id: SpatialId) => void
}) {
  if (selection.kind === "agent") {
    const { node, recentRuns } = selection
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          {/* The agent's own mark, in the state its worst run is in. The
              provider id below it stays, because the mark identifies and the
              text names. */}
          <AgentIcon
            connector={node.provider}
            state={node.status === "idle" ? "idle" : visualStateForRun({ status: node.status })}
            size="md"
            className="mt-0.5"
          />
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-foreground">{node.label}</p>
            <p className="text-meta text-tertiary">{node.provider}</p>
          </div>
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

  if (selection.kind === "workItem") {
    const { item, runTitle, runSpatialId, runStatus, agentName, files, tabs, events, runSummary } =
      selection
    const visual = WORK_ITEM_STATUS_VISUALS[item.status]
    const progress = progressLabel(item.progress)
    const started = formatWhen(item.startedAt)
    const updated = formatWhen(item.updatedAt)
    const completed = formatWhen(item.completedAt)

    return (
      <div className="space-y-3">
        <div>
          <p className="text-body font-medium text-foreground">{item.title}</p>
          <p className="text-meta text-tertiary">Work item</p>
        </div>

        <p className="text-meta text-tertiary">
          <span aria-hidden>{visual.glyph} </span>
          <span>{visual.label}</span>
          {/* Only when a provider actually counted something. */}
          {progress && <span> · {progress}</span>}
        </p>

        {item.summary && <p className="text-body-sm text-muted-foreground">{item.summary}</p>}

        {/* The owning run, as a control rather than a caption: a work item is
            only meaningful in relation to its run, so getting back to it must
            be one keystroke away. */}
        <div className="space-y-1">
          <p className="text-label text-tertiary">RUN</p>
          <button
            type="button"
            onClick={() => onSelectSpatial(runSpatialId)}
            aria-label={`Select run ${runTitle}`}
            className="block w-full rounded-md px-1.5 py-1 text-left transition-colors duration-(--duration-fast) hover:bg-accent"
          >
            <span className="block truncate text-body-sm text-foreground">{runTitle}</span>
            <span className="block text-meta text-tertiary">
              {agentName}
              {runStatus ? ` · ${AGENT_STATUS_VISUALS[runStatus].label}` : ""}
            </span>
          </button>
        </div>

        {(started || updated || completed) && (
          <dl className="space-y-0.5 text-meta text-tertiary">
            {started && (
              <div className="flex gap-2">
                <dt>Started</dt>
                <dd>{started}</dd>
              </div>
            )}
            {updated && (
              <div className="flex gap-2">
                <dt>Updated</dt>
                <dd>{updated}</dd>
              </div>
            )}
            {completed && (
              <div className="flex gap-2">
                <dt>Completed</dt>
                <dd>{completed}</dd>
              </div>
            )}
          </dl>
        )}

        {runSummary && <RunSummarySection summary={runSummary} />}

        <RunContext files={files} tabs={tabs} events={events} />
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

  const { node, agentName, files, tabs, events, workItems, summary, startedAt, endedAt } = selection
  const started = formatWhen(startedAt)
  const ended = formatWhen(endedAt)
  // Phase 16's last-activity is a maximum over every kind of observed
  // evidence — events, work-item updates and file links — so it is preferred
  // over the run record's own `updatedAt`, which only moves when the run
  // itself is rewritten. Falls back to the Phase 14 behaviour without an index.
  const lastActivity = formatWhen(summary?.lastActivityAt ?? node.updatedAt)

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        {/* Who is doing this run, drawn in the state the run is actually in.
            The activity line the node already carries decides whether that
            reads as working or as thinking — the same derivation the world
            and the sidebar use, so all three agree. */}
        <AgentIcon
          connector={node.provider}
          state={visualStateForRun({ status: node.status, currentActivity: node.activity })}
          size="md"
          className="mt-0.5"
        />
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-foreground">{node.label}</p>
          <p className="text-meta text-tertiary">{agentName}</p>
        </div>
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

      {summary && <RunSummarySection summary={summary} />}

      <WorkItemList items={workItems} onSelect={onSelectSpatial} />

      <RunContext files={files} tabs={tabs} events={events} />
    </div>
  )
}

/**
 * The files, tabs and recent activity of one run.
 *
 * Shared by the run and work-item inspectors so both describe a run the same
 * way. Each section renders nothing when empty, rather than a heading over an
 * empty list.
 */
function RunContext({
  files,
  tabs,
  events,
}: {
  files: { artifactId: string; relativePath: string; role: AgentRunArtifactRole }[]
  tabs: { tabId: string; title: string; role: AgentRunLinkRole }[]
  events: AgentEvent[]
}) {
  return (
    <>
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
    </>
  )
}
