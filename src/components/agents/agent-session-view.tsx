"use client"

import { useCallback, useMemo, useState } from "react"
import { Boxes, ChevronLeft, Link2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { useAgentIntelligence } from "@/hooks/use-agent-intelligence"
import { buildAgentSession } from "@/lib/agents/session/build"
import { encodeAgentSessionAddress } from "@/lib/agents/session/address"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"
import {
  ARTIFACT_ROLE_WORDS,
  NO_RUN_TITLE,
  RUN_STATUS_WORDS,
  WORK_ITEM_STATUS_WORDS,
  formatTimeAgo,
  isProducedRole,
} from "./agent-session-presentation"
import type { AgentStoreApi } from "@/hooks/use-agent-store"
import type { EventReference } from "@/lib/agents/intelligence/types"
import type {
  AgentSessionView as SessionModel,
  SessionArtifact,
  SessionWorkItem,
} from "@/lib/agents/session/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * The Session View: one run, as a durable record.
 *
 * ## The invariant this screen exists to hold
 *
 * Task evidence and run context are different claims, and they are rendered
 * as different sections that never merge. What appears under a selected work
 * item is exactly what `AgentWorkItemEvidence` recorded for it. What appears
 * under "THE RUN AROUND THIS WORK" is the run's own relationships, labelled
 * as such. A tab the run opened does not appear under a task merely because
 * the task is selected, and nothing on this screen subtracts one set from
 * the other to manufacture the appearance of a distinction.
 *
 * ## Nothing here is generated
 *
 * No summary is written, no intent is inferred, no activity is synthesised.
 * Every line is either a stored field, a count of stored rows, or one of the
 * fixed honest fallbacks below. Where the domain recorded nothing, the
 * screen says nothing was recorded - which is a different statement from
 * saying the work failed, and is worded to keep the two apart.
 *
 * ## No recency
 *
 * This screen does not read the world's recency window, the scene, or any
 * spatial placement. A run resolves here whenever the domain still holds it.
 */

/** The fixed lines for missing data. One wording each, used everywhere. */
const EMPTY = {
  workItems: "No recorded work items.",
  evidence: "No recorded evidence for this task.",
  tabs: "No saved TabDump tabs are linked to this session.",
  result: "No recorded result.",
  taskResult: "No recorded result for this task.",
  events: "No recorded events for this session.",
  files: "No recorded files for this session.",
} as const

/** The accessible name of a selected task's evidence block. */
const EVIDENCE_REGION_LABEL = "Evidence recorded for this task"

/** The accessible name of the run-level section. */
const RUN_CONTEXT_REGION_LABEL = "The run around this work"

/** A small, muted line. Reads as "nothing was recorded", never as a failure. */
function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-body-sm text-muted-foreground">{children}</p>
}

/**
 * A file, with the roles the run holds on it.
 *
 * ## Why there is no open button
 *
 * TabDump has no legitimate generic "open file" capability - it is a web app
 * with no filesystem access, and a button that looked like one would imply a
 * power the product does not have. So a file is metadata: its
 * project-relative path and how it was touched. Nothing here is clickable.
 *
 * `relativePath` is all that is rendered. An artifact id is never used here,
 * not even as a React key: the id embeds the absolute project root, so the
 * session model carries an opaque per-session `key` instead. See
 * SessionArtifact.
 */
function ArtifactRow({ file }: { file: SessionArtifact }) {
  const roles = file.roles.map((role) => ARTIFACT_ROLE_WORDS[role])
  return (
    <li className="flex items-baseline justify-between gap-2 rounded-md border border-subtle px-2 py-1">
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-foreground">
        {file.relativePath}
      </span>
      {roles.length > 0 ? (
        <span className="shrink-0 text-meta text-tertiary">{roles.join(" · ")}</span>
      ) : null}
    </li>
  )
}

/**
 * A tab, as a button when it still exists and as a stale line when it does
 * not.
 *
 * Opening goes through the app's existing tab-opening callback - the same
 * one Favorites and Recents use. No second mechanism is introduced here.
 *
 * A tab that has been deleted keeps its row and says so. Substituting
 * another tab, or hiding the evidence entirely, would both misrepresent what
 * the run actually touched.
 */
function TabRow({
  tabId,
  title,
  onOpenTab,
}: {
  tabId: string
  title: string | undefined
  onOpenTab?: (tabId: string) => void
}) {
  if (title === undefined) {
    return (
      <li className="rounded-md border border-dashed border-subtle px-2 py-1">
        <span className="text-meta italic text-muted-foreground">
          This tab is no longer saved in TabDump
        </span>
      </li>
    )
  }

  if (!onOpenTab) {
    return (
      <li className="rounded-md border border-subtle px-2 py-1">
        <span className="block truncate text-meta text-foreground">{title}</span>
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenTab(tabId)}
        aria-label={`Open tab ${title}`}
        className="block w-full truncate rounded-md border border-subtle px-2 py-1 text-left text-meta text-foreground transition-colors duration-(--duration-fast) hover:border-border hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {title}
      </button>
    </li>
  )
}

/** One event line. Stored timestamp, stored summary, nothing composed. */
function EventRow({
  event,
  now,
  highlighted,
}: {
  event: EventReference
  now: number
  highlighted: boolean
}) {
  const when = formatTimeAgo(event.timestamp, now)
  return (
    <li
      className={cn(
        "flex items-baseline justify-between gap-2 rounded-md border px-2 py-1",
        // Highlighted means "this event is evidence for the selected task".
        // The word in the margin carries that too, so the distinction is not
        // colour alone.
        highlighted ? "border-primary/40 bg-primary/10" : "border-subtle"
      )}
    >
      <span className="min-w-0 flex-1 truncate text-meta text-foreground">{event.summary}</span>
      {highlighted ? (
        <span className="shrink-0 text-meta font-medium text-primary">This task</span>
      ) : null}
      {when ? <span className="shrink-0 text-meta text-tertiary">{when}</span> : null}
    </li>
  )
}

/** A section heading inside the session body. Semantic, for screen readers. */
function Section({
  id,
  title,
  children,
  right,
}: {
  id: string
  title: string
  children: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={id} className="text-eyebrow text-tertiary">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  )
}

/**
 * The evidence recorded for one work item.
 *
 * Renders only what `getWorkItemEvidence` returned, which is only what was
 * explicitly stored. When a task has no rows at all it says so once, rather
 * than printing three empty subsections.
 */
function WorkItemEvidence({
  item,
  now,
  tabTitles,
  onOpenTab,
}: {
  item: SessionWorkItem
  now: number
  tabTitles: ReadonlyMap<string, string>
  onOpenTab?: (tabId: string) => void
}) {
  const { evidence } = item

  if (evidence.total === 0) {
    return (
      <section
        aria-label={EVIDENCE_REGION_LABEL}
        className="space-y-1.5 rounded-lg border border-subtle bg-background-secondary p-2.5"
      >
        <EmptyLine>{EMPTY.evidence}</EmptyLine>
      </section>
    )
  }

  // A "result" is a file this task is recorded as having changed. A file it
  // only read is evidence of inspection and is deliberately not counted -
  // see isProducedRole.
  const produced = evidence.artifacts.filter((file) => file.roles.some(isProducedRole))

  return (
    /* A landmark of its own, so "what belongs to this task" is a region a
       screen reader can jump to - and so nothing in it can be confused with
       the run-level section below. */
    <section
      aria-label={EVIDENCE_REGION_LABEL}
      className="space-y-3 rounded-lg border border-subtle bg-background-secondary p-2.5"
    >
      <Section id={`evidence-events-${item.reference.workItemId}`} title="Events">
        {evidence.events.length === 0 ? (
          <EmptyLine>No events recorded for this task.</EmptyLine>
        ) : (
          <ul className="space-y-1">
            {evidence.events.map((event) => (
              <EventRow key={event.eventId} event={event} now={now} highlighted={false} />
            ))}
          </ul>
        )}
      </Section>

      <Section id={`evidence-tabs-${item.reference.workItemId}`} title="Tabs">
        {evidence.tabIds.length === 0 ? (
          <EmptyLine>No tabs recorded for this task.</EmptyLine>
        ) : (
          <ul className="space-y-1">
            {evidence.tabIds.map((tabId) => (
              <TabRow
                key={tabId}
                tabId={tabId}
                title={tabTitles.get(tabId)}
                onOpenTab={onOpenTab}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section id={`evidence-files-${item.reference.workItemId}`} title="Files">
        {evidence.artifacts.length === 0 ? (
          <EmptyLine>No files recorded for this task.</EmptyLine>
        ) : (
          <ul className="space-y-1">
            {evidence.artifacts.map((file) => (
              <ArtifactRow key={file.key} file={file} />
            ))}
          </ul>
        )}
      </Section>

      <Section id={`evidence-result-${item.reference.workItemId}`} title="Result">
        {produced.length === 0 ? (
          <EmptyLine>{EMPTY.taskResult}</EmptyLine>
        ) : (
          <ul className="space-y-1">
            {produced.map((file) => (
              <ArtifactRow key={file.key} file={file} />
            ))}
          </ul>
        )}
      </Section>
    </section>
  )
}

/** The evidence counts on a work item row. Counted from stored rows only. */
function evidenceCountsLabel(item: SessionWorkItem): string {
  const { evidence } = item
  if (evidence.total === 0) return "No recorded evidence"

  const parts: string[] = []
  if (evidence.artifacts.length > 0) {
    parts.push(
      `${evidence.artifacts.length} ${evidence.artifacts.length === 1 ? "file" : "files"}`
    )
  }
  if (evidence.tabIds.length > 0) {
    parts.push(`${evidence.tabIds.length} ${evidence.tabIds.length === 1 ? "tab" : "tabs"}`)
  }
  if (evidence.events.length > 0) {
    parts.push(`${evidence.events.length} ${evidence.events.length === 1 ? "event" : "events"}`)
  }
  return parts.join(" · ")
}

export type AgentSessionScreenProps = {
  session: SessionModel
  /** The run's workspace, named. `null` when it no longer exists. */
  workspaceName: string | null
  /** Tab titles by id. A tab absent from this map has been deleted. */
  tabTitles: ReadonlyMap<string, string>
  now: number
  selectedWorkItemId: string | null
  onSelectWorkItem: (workItemId: string | null) => void
  onOpenTab?: (tabId: string) => void
  /** Takes the user to the spatial world. Optional - the screen works without it. */
  onOpenWorld?: () => void
  /** Copies the session's address. Absent when the address cannot be formed. */
  onCopyLink?: () => void
  onClose: () => void
}

export function AgentSessionScreen({
  session,
  workspaceName,
  tabTitles,
  now,
  selectedWorkItemId,
  onSelectWorkItem,
  onOpenTab,
  onOpenWorld,
  onCopyLink,
  onClose,
}: AgentSessionScreenProps) {
  const title = session.title ?? NO_RUN_TITLE
  const started = formatTimeAgo(session.createdAt, now)
  const last = formatTimeAgo(session.summary.lastActivityAt ?? session.updatedAt, now)

  const selected = session.workItems.find(
    (item) => item.reference.workItemId === selectedWorkItemId
  )

  // Which run-level events are evidence for the selected task. Unrelated
  // events stay in the timeline rather than being filtered out - the user
  // needs to see task evidence *within* the run's activity, not instead of
  // it.
  const highlightedEventIds = useMemo(
    () => new Set(selected?.evidence.events.map((event) => event.eventId) ?? []),
    [selected]
  )

  const runProduced = session.runContext.artifacts.filter((file) =>
    file.roles.some(isProducedRole)
  )

  return (
    <div
      className="relative flex h-screen min-w-0 flex-1 flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <header className="flex items-center gap-2 border-b border-subtle px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-3">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>

        <AgentIcon
          connector={session.agent?.provider ?? ""}
          state="idle"
          size="sm"
          label={session.agent ? session.agent.name : "Unknown agent"}
        />

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-h2 text-foreground">
            {session.agent?.name ?? "Unknown agent"}
          </h1>
          <p className="truncate text-meta text-tertiary">
            {[
              workspaceName ?? "Unknown workspace",
              RUN_STATUS_WORDS[session.status],
              started ? `started ${started}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        <nav aria-label="Session" className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {onCopyLink ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Copy link to this session"
              onClick={onCopyLink}
            >
              <Link2 />
              <span className="hidden sm:inline">Copy link</span>
            </Button>
          ) : null}
          {onOpenWorld ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Agent World"
              onClick={onOpenWorld}
            >
              <Boxes />
              <span className="hidden sm:inline">Agent World</span>
            </Button>
          ) : null}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
        <div className="mx-auto w-full max-w-4xl space-y-5">
          {/* WHAT — the run's own description, or the honest fallback. */}
          <section aria-labelledby="session-work-heading" className="space-y-1">
            <h2 id="session-work-heading" className="text-eyebrow text-tertiary">
              Work
            </h2>
            <p
              className={cn(
                "text-body text-foreground",
                session.title ? "" : "italic text-muted-foreground"
              )}
            >
              {title}
            </p>
            {session.currentActivity ? (
              <p className="text-body-sm text-muted-foreground">{session.currentActivity}</p>
            ) : null}
            {last ? <p className="text-body-sm text-muted-foreground">Last recorded activity {last}</p> : null}
          </section>

          {/* WORK ITEMS — every one, including completed and cancelled. */}
          <section aria-labelledby="session-items-heading" className="space-y-1.5">
            <h2 id="session-items-heading" className="text-eyebrow text-tertiary">
              Work items
            </h2>

            {session.workItems.length === 0 ? (
              <EmptyLine>{EMPTY.workItems}</EmptyLine>
            ) : (
              <ul className="space-y-1.5">
                {session.workItems.map((item) => {
                  const id = item.reference.workItemId
                  const isSelected = id === selectedWorkItemId
                  return (
                    <li key={id} className="space-y-1.5">
                      <button
                        type="button"
                        // The pressed state is what makes the selection
                        // obvious to a screen reader; the ring and border
                        // make it obvious visually. Never colour alone.
                        aria-pressed={isSelected}
                        aria-label={`${item.reference.title}, ${
                          WORK_ITEM_STATUS_WORDS[item.reference.status]
                        }, ${evidenceCountsLabel(item)}`}
                        onClick={() => onSelectWorkItem(isSelected ? null : id)}
                        className={cn(
                          "w-full rounded-lg border px-2.5 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                          isSelected
                            ? "border-primary/40 bg-primary/10"
                            : "border-subtle hover:border-border hover:bg-surface-hover"
                        )}
                      >
                        <span className="flex flex-wrap items-baseline gap-x-1.5">
                          <span className="text-body-sm font-medium text-foreground">
                            {item.reference.title}
                          </span>
                          <span className="text-meta text-tertiary">
                            {WORK_ITEM_STATUS_WORDS[item.reference.status]}
                          </span>
                        </span>
                        {item.reference.summary ? (
                          <span className="mt-0.5 block text-meta text-muted-foreground">
                            {item.reference.summary}
                          </span>
                        ) : null}
                        <span className="mt-0.5 block text-meta text-tertiary">
                          {evidenceCountsLabel(item)}
                        </span>
                      </button>

                      {isSelected ? (
                        <WorkItemEvidence
                          item={item}
                          now={now}
                          tabTitles={tabTitles}
                          onOpenTab={onOpenTab}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* THE RUN AROUND THIS WORK — visually and semantically separate.
              Everything below belongs to the run, not to any selected task,
              and the subtitle says so in as many words. */}
          <section
            aria-label={RUN_CONTEXT_REGION_LABEL}
            className="space-y-3 rounded-xl border border-subtle bg-background-secondary p-3"
          >
            <div className="space-y-0.5">
              <h2 id="session-run-context-heading" className="text-eyebrow text-tertiary">
                The run around this work
              </h2>
              <p className="text-meta text-muted-foreground">
                Everything this session touched. These are run-level records and are not
                necessarily evidence for the selected task.
              </p>
            </div>

            <Section id="session-run-tabs" title="Tabs">
              {session.runContext.affectedTabIds.length === 0 ? (
                <EmptyLine>{EMPTY.tabs}</EmptyLine>
              ) : (
                <ul className="space-y-1">
                  {/* The impact model's deduplicated union — a tab that is
                      both context and produced is one row, not two. */}
                  {session.runContext.affectedTabIds.map((tabId) => (
                    <TabRow
                      key={tabId}
                      tabId={tabId}
                      title={tabTitles.get(tabId)}
                      onOpenTab={onOpenTab}
                    />
                  ))}
                </ul>
              )}
            </Section>

            <Section id="session-run-files" title="Files">
              {session.runContext.artifacts.length === 0 ? (
                <EmptyLine>{EMPTY.files}</EmptyLine>
              ) : (
                <ul className="space-y-1">
                  {session.runContext.artifacts.map((file) => (
                    <ArtifactRow key={file.key} file={file} />
                  ))}
                </ul>
              )}
            </Section>

            <Section id="session-run-result" title="Result">
              {runProduced.length === 0 ? (
                <EmptyLine>{EMPTY.result}</EmptyLine>
              ) : (
                <ul className="space-y-1">
                  {runProduced.map((file) => (
                    <ArtifactRow key={file.key} file={file} />
                  ))}
                </ul>
              )}
            </Section>

            <Section
              id="session-run-timeline"
              title="TIMELINE"
              right={
                selected ? (
                  <span className="text-body-sm text-muted-foreground">
                    Highlighted: evidence for the selected task
                  </span>
                ) : null
              }
            >
              {session.runContext.events.length === 0 ? (
                <EmptyLine>{EMPTY.events}</EmptyLine>
              ) : (
                <ul className="space-y-1">
                  {session.runContext.events.map((event) => (
                    <EventRow
                      key={event.eventId}
                      event={event}
                      now={now}
                      highlighted={highlightedEventIds.has(event.eventId)}
                    />
                  ))}
                </ul>
              )}
            </Section>
          </section>
        </div>
      </div>
    </div>
  )
}

export type AgentSessionViewProps = {
  runId: string
  store: WorkspaceStore
  agentStore: AgentStoreApi
  /** Preserved across navigation, so returning to a session keeps its task open. */
  initialWorkItemId?: string
  onOpenTab?: (tabId: string) => void
  onOpenWorld?: (workspaceId: string) => void
  onClose: () => void
}

/**
 * The container.
 *
 * Resolves exactly one run. `buildAgentSession` reads the shared index, so
 * opening a session costs that run plus its own evidence - not a scan.
 */
export function AgentSessionView({
  runId,
  store,
  agentStore,
  initialWorkItemId,
  onOpenTab,
  onOpenWorld,
  onClose,
}: AgentSessionViewProps) {
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(
    initialWorkItemId ?? null
  )
  const [now] = useState(() => Date.now())

  const intelligence = useAgentIntelligence({
    state: agentStore.state,
    workspaceId: store.currentId,
  })

  const result = useMemo(
    () => buildAgentSession(intelligence.index, runId),
    [intelligence.index, runId]
  )

  const tabTitles = useMemo(() => {
    const titles = new Map<string, string>()
    for (const workspace of store.workspaces) {
      for (const tab of workspace.tabs) {
        titles.set(tab.id, tab.title?.trim() || tab.domain)
      }
    }
    return titles
  }, [store.workspaces])

  const session = result.ok ? result.session : null

  const workspaceName = useMemo(() => {
    if (!session) return null
    return store.workspaces.find((w) => w.id === session.workspaceId)?.name ?? null
  }, [store.workspaces, session])

  /**
   * Copying the address.
   *
   * Offered only when the address encodes - and it contains opaque ids and
   * nothing else. No title, url, path, artifact id or external id reaches
   * it. Clipboard access can be denied, so the failure is swallowed rather
   * than thrown at the user: the button not appearing to work is a smaller
   * problem than an unhandled rejection.
   */
  const address = session
    ? encodeAgentSessionAddress({
        runId: session.runId,
        ...(selectedWorkItemId ? { workItemId: selectedWorkItemId } : {}),
      })
    : null

  const onCopyLink = useCallback(() => {
    if (!address) return
    void navigator.clipboard?.writeText(address).catch(() => {})
  }, [address])

  if (!session) {
    return (
      <div className="relative flex h-screen min-w-0 flex-1 flex-col bg-background">
        <header className="flex items-center gap-2 border-b border-subtle px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-3">
          <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
            <ChevronLeft />
          </IconButton>
          <h1 className="truncate text-h2 text-foreground">Session</h1>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          {/* The run is gone from the domain. Said plainly, with no attempt
              to show a nearby run instead. */}
          <p className="text-body-sm text-muted-foreground">
            This session is no longer recorded in TabDump.
          </p>
        </div>
      </div>
    )
  }

  return (
    <AgentSessionScreen
      session={session}
      workspaceName={workspaceName}
      tabTitles={tabTitles}
      now={now}
      selectedWorkItemId={selectedWorkItemId}
      onSelectWorkItem={setSelectedWorkItemId}
      onOpenTab={onOpenTab}
      onOpenWorld={onOpenWorld ? () => onOpenWorld(session.workspaceId) : undefined}
      onCopyLink={address ? onCopyLink : undefined}
      onClose={onClose}
    />
  )
}
