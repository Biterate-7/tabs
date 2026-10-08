"use client"

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { ArrowRight, FolderGit2, PanelLeftOpen, Plus, Radio, Search, X } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { ResourceCard } from "./resource-card"
import { ProjectActivity } from "./project-activity"
import { AddSourceDialog } from "./add-source-dialog"
import { SourceDetailsDialog } from "./source-details-dialog"
import { ProjectDropOverlay, useExternalDrop } from "./project-drop-zone"
import { SourceKindIcon } from "./source-status"
import { useLastTask } from "@/hooks/use-last-task"
import { useProjectActivity } from "@/hooks/use-project-activity"
import { useProjectContents } from "@/hooks/use-project-contents"
import { lastTaskStateLabel } from "@/lib/agents/command-centre/last-task"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { describeLocation, searchProject } from "@/lib/resources/search"
import { needsAttention, projectSources } from "@/lib/resources/ingest"
import { projectState } from "@/lib/projects/state"
import { recordLoopMilestone } from "@/lib/product/loop-log"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { DroppedResources } from "@/lib/resources/drop"
import type { IngestOutcome } from "@/lib/resources/ingest"
import type { ResourceInput, ResourceKind, ResourceOrigin } from "@/lib/resources/types"
import type { ResourceActions } from "@/hooks/use-resource-processing"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

type Filter = "all" | "webpage" | "pdf" | "video" | "attention"

const FILTERS: { id: Filter; label: string; matches: (tab: Tab) => boolean }[] = [
  { id: "all", label: "All", matches: () => true },
  { id: "webpage", label: "Web pages", matches: (tab) => tab.resource!.kind === "webpage" || tab.resource!.kind === "document" || tab.resource!.kind === "unknown" },
  { id: "pdf", label: "PDFs", matches: (tab) => tab.resource!.kind === "pdf" },
  { id: "video", label: "Videos", matches: (tab) => tab.resource!.kind === "youtube" || tab.resource!.kind === "video" },
  { id: "attention", label: "Needs attention", matches: (tab) => needsAttention(tab.resource) },
]

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export type ProjectHomeProps = {
  workspace: Workspace
  now: number
  /** The one ingestion pipeline. Returns each input's outcome. */
  onAddSources: (inputs: ResourceInput[], origin: ResourceOrigin) => IngestOutcome[]
  resources: ResourceActions
  onRenameSource: (tabId: string, title: string) => void
  onRemoveSources: (tabIds: string[]) => void
  onOpenSource: (tab: Tab) => void
  /** "Use in task": the Command Centre, with this source in the task's context. */
  onUseInTask?: (tab: Tab) => void
  onOpenCommandCentre?: () => void
  onOpenTask?: (sessionId: string) => void
  onUpdateBrief?: (brief: { description: string; focus: string }) => void
  /** The connected local folder's name, when the project has one — its files. */
  folderName?: string
  /** Agents connected in Hubble (the roster). */
  agents: readonly { provider: AgentProviderId; name: string }[]
  /** Shown under the empty state: the older "dump my open tabs" input. */
  emptyExtra?: ReactNode
  /**
   * Present once Hubble for Chrome has said it is here: a tab's right-click
   * menu ("Add to <project>") and the shortcut add Chrome tabs to this
   * project — the one on screen. Chrome gives pages no way to receive a
   * dragged tab, so nothing here suggests dragging one.
   */
  quickAdd?: { shortcut: string }
}

/**
 * A project's home (Hubble 2.0): what it is about, where the work was left,
 * what the agents have to work from, and its sources — with the whole page a
 * drop target for links and the address bar dragged from Chrome (Chrome does not expose its tab strip to a page;
 * actual tabs come in through the extension's tab right-click menu — see use-extension-quick-add.ts).
 *
 *     History IA
 *     Investigating the Cuban Missile Crisis …     Goal: a strong argument …
 *     Where you left off   Gemini · Done · Challenged Claude's arguments  [Continue]
 *     Context   5 sources · 4 readable · 1 folder · 2 notes  [Add source] [Command Centre]
 *     Agents    Claude · Gemini · Codex
 *     Sources   [search] [All | PDFs | Videos | Needs attention]
 *     Recent work
 */
export function ProjectHome(props: ProjectHomeProps) {
  const { workspace, now, resources } = props
  const sources = useMemo(() => projectSources(workspace).sort((a, b) => (b.resource!.addedAt ?? 0) - (a.resource!.addedAt ?? 0)), [workspace])
  const lastTask = useLastTask(workspace.id)
  const events = useProjectActivity(workspace.id)
  const state = useMemo(() => projectState({ workspace, ...(lastTask ? { lastTask } : {}), events }), [workspace, lastTask, events])
  const [addOpen, setAddOpen] = useState(false)
  const [details, setDetails] = useState<{ tabId: string; rename: boolean } | null>(null)
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [editingBrief, setEditingBrief] = useState(false)
  const [dropNotice, setDropNotice] = useState<string | null>(null)

  // Coming back to a project with work in it is the return the loop log counts — once a day per project, never sent.
  const returning = Boolean(lastTask)
  useEffect(() => {
    if (returning) recordLoopMilestone("project_returned", { once: `${workspace.id}:${new Date().toDateString()}` })
  }, [returning, workspace.id])

  const projectName = workspace.name.trim() || "Untitled project"
  const notes = workspace.tabs.filter((tab) => tab.notes).length
  const working = sources.filter((tab) => tab.resource!.status === "pending" || tab.resource!.status === "processing").length
  const searching = query.trim().length > 1
  const contents = useProjectContents(useMemo(() => (searching ? [workspace] : []), [searching, workspace]))
  const tabById = useMemo(() => new Map(workspace.tabs.map((tab) => [tab.id, tab])), [workspace.tabs])
  const titleOf = (tabId: string) => {
    const tab = tabById.get(tabId)
    return tab ? tab.title?.trim() || tab.domain : undefined
  }

  const hits = useMemo(() => {
    if (!searching) return []
    const results = events.filter((event) => event.kind === "task").map((event) => ({ id: event.id, text: `${agentDisplayName(event.provider)} ${event.headline ?? ""} ${event.task ?? ""}` }))
    return searchProject({ query, tabs: workspace.tabs, contents: contents.get(workspace.id) ?? new Map(), results, limit: 30 })
  }, [searching, query, workspace.tabs, workspace.id, contents, events])

  const handleDrop = (dropped: DroppedResources) => {
    if (dropped.inputs.length > 0) {
      props.onAddSources(dropped.inputs, "chrome")
      setDropNotice(null)
    } else if (dropped.files.length > 0) {
      // A file has no address to keep; it belongs to a PDF source waiting for it.
      const waiting = sources.filter((tab) => tab.resource!.kind === "pdf" && tab.resource!.status !== "ready")
      const pdf = dropped.files.find((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
      const match = pdf ? (waiting.find((tab) => tab.resource!.meta?.fileName === pdf.name || decodeURIComponent(tab.url).toLowerCase().endsWith(`/${pdf.name.toLowerCase()}`)) ?? (waiting.length === 1 ? waiting[0] : undefined)) : undefined
      if (pdf && match) {
        void resources.attachPdf(workspace.id, match.id, pdf)
        setDropNotice(null)
      } else {
        setDropNotice(
          pdf
            ? "A PDF file needs its source: add the PDF's web address first, then drop or upload the file on it."
            : "That item couldn't be added. Drop links, tabs or the address bar from Chrome."
        )
      }
    } else {
      setDropNotice("That item couldn't be added. Drop links, tabs or the address bar from Chrome.")
    }
  }
  const { active } = useExternalDrop({ enabled: true, onDrop: handleDrop })

  const visible = sources.filter(FILTERS.find((entry) => entry.id === filter)!.matches)
  const detailTab = details ? (tabById.get(details.tabId) ?? null) : null
  const cardActions = {
    onOpen: props.onOpenSource,
    ...(props.onUseInTask ? { onUseInTask: props.onUseInTask } : {}),
    onRename: (tab: Tab) => setDetails({ tabId: tab.id, rename: true }),
    onRemove: (tab: Tab) => props.onRemoveSources([tab.id]),
    onRetry: (tab: Tab) => resources.retry(workspace.id, tab.id),
    onDetails: (tab: Tab) => setDetails({ tabId: tab.id, rename: false }),
    onCopyUrl: (tab: Tab) => void navigator.clipboard?.writeText(tab.url).catch(() => undefined),
  }

  return (
    <section aria-label={`${projectName} project`} className="mb-6 flex flex-col gap-4" data-project-home={workspace.id}>
      <ProjectDropOverlay active={active} projectName={projectName} />

      {/* What are you working on? */}
      {editingBrief && props.onUpdateBrief ? (
        <BriefForm
          description={workspace.brief?.description ?? ""}
          focus={workspace.brief?.focus ?? ""}
          onCancel={() => setEditingBrief(false)}
          onSave={(brief) => {
            props.onUpdateBrief!(brief)
            setEditingBrief(false)
          }}
        />
      ) : workspace.brief?.description || workspace.brief?.focus ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {workspace.brief.description && <p className="text-body text-foreground">{workspace.brief.description}</p>}
          {workspace.brief.focus && (
            <p className="text-body-sm text-muted-foreground">
              <span className="text-tertiary">Goal </span>
              {workspace.brief.focus}
            </p>
          )}
          {props.onUpdateBrief && (
            <Button type="button" size="xs" variant="ghost" className="-ml-1.5 w-fit" onClick={() => setEditingBrief(true)}>
              Edit brief
            </Button>
          )}
        </div>
      ) : (
        props.onUpdateBrief && (
          <button type="button" className="w-fit text-left text-body-sm text-muted-foreground hover:text-foreground" onClick={() => setEditingBrief(true)}>
            What are you working on? <span className="text-link">Add a brief</span> so every agent knows.
          </button>
        )
      )}

      {/* Where you left off */}
      {state.lastTask && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-subtle bg-card px-3 py-2" data-project-left-off>
          <span className="text-eyebrow text-tertiary">Where you left off</span>
          <AgentIcon connector={state.lastTask.provider} size="xs" />
          <p className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground" title={state.lastTask.task}>
            <span className="text-foreground">{agentDisplayName(state.lastTask.provider)}</span>
            <span className="text-tertiary"> · </span>
            <span className={state.lastTask.attention ? "text-link" : "text-foreground"}>{lastTaskStateLabel(state.lastTask)}</span>
            <span className="text-tertiary"> · </span>
            {state.lastTask.headline}
            {state.lastTask.task && <span className="text-tertiary"> · “{state.lastTask.task}”</span>}
            <span className="text-tertiary"> · {formatRelativeTime(state.lastTask.at, now)}</span>
          </p>
          {props.onOpenTask && (
            <Button type="button" size="xs" variant="secondary" onClick={() => props.onOpenTask!(state.lastTask!.sessionId)}>
              Continue <ArrowRight />
            </Button>
          )}
        </div>
      )}

      {/* Context */}
      <div className="flex flex-col gap-3 rounded-md border border-subtle bg-card p-3" data-project-context>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-label text-foreground">Context</h2>
          <p className="text-body-sm text-muted-foreground" data-project-counts>
            {plural(sources.length, "source", "sources")}
            {sources.length > 0 && ` · ${state.sources.ready} readable`}
            {props.folderName ? ` · folder ${props.folderName}` : ""}
            {notes > 0 ? ` · ${plural(notes, "note", "notes")}` : ""}
          </p>
          {working > 0 && (
            <p role="status" className="text-meta text-muted-foreground">
              Reading {plural(working, "source", "sources")}…
            </p>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button type="button" size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
              <Plus /> Add source
            </Button>
            {props.onOpenCommandCentre && (
              <Button type="button" size="sm" onClick={props.onOpenCommandCentre}>
                <Radio /> Command Centre
              </Button>
            )}
          </div>
        </div>
        {/* Taught once: the empty state below carries it until the project has sources. */}
        {sources.length > 0 &&
          (props.quickAdd ? (
            <ChromeQuickAdd projectName={projectName} shortcut={props.quickAdd.shortcut} className="hidden md:flex" />
          ) : (
            <p className="hidden text-meta text-tertiary md:block" data-add-hint>
              Drag a link or the address bar from Chrome onto this page, or use Hubble for Chrome to add tabs.
            </p>
          ))}
        {dropNotice && (
          <p role="alert" className="flex items-center gap-2 text-body-sm text-destructive">
            {dropNotice}
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setDropNotice(null)}>
              <X />
            </Button>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-subtle pt-2">
          <span className="text-meta text-tertiary">Agents</span>
          {props.agents.length > 0 ? (
            props.agents.map((agent) => (
              <span key={agent.provider} className="flex items-center gap-1 text-body-sm text-muted-foreground" data-project-agent={agent.provider}>
                <AgentIcon connector={agent.provider} size="xs" /> {agent.name}
              </span>
            ))
          ) : (
            <span className="text-body-sm text-muted-foreground">Your project is ready. Connect an agent to start working.</span>
          )}
          {state.next && (
            <span className="text-body-sm text-muted-foreground md:ml-auto" data-project-next={state.next.kind}>
              <span className="text-tertiary">Next · </span>
              {state.next.text}
            </span>
          )}
        </div>
      </div>

      {/* Sources */}
      {sources.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-strong p-5" data-project-empty>
          <p className="text-h2 text-foreground">Start by adding context.</p>
          {props.quickAdd ? (
            <>
              <ChromeQuickAdd projectName={projectName} shortcut={props.quickAdd.shortcut} />
              <p className="max-w-prose text-body-sm text-muted-foreground">
                Hubble reads each source — web pages, PDFs, YouTube videos — and every agent you choose works from them. Links and the address bar can be dragged here too.
              </p>
            </>
          ) : (
            <p className="max-w-prose text-body text-muted-foreground" data-add-hint>
              Drag a link or the address bar from Chrome here, add addresses, or use Hubble for Chrome to add tabs. Hubble reads each source — web pages, PDFs, YouTube videos — and then any agent you choose can work from them.
            </p>
          )}
          <Button type="button" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus /> Add source
          </Button>
          {props.emptyExtra}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-label text-foreground">Sources</h2>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Show sources">
              {FILTERS.map((entry) => (
                <Button
                  key={entry.id}
                  type="button"
                  size="xs"
                  variant={filter === entry.id ? "secondary" : "ghost"}
                  aria-pressed={filter === entry.id}
                  onClick={() => setFilter(entry.id)}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
            <label className="relative ml-auto w-full sm:w-64">
              <span className="sr-only">Search {projectName}</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${projectName}…`} className="pl-7" />
            </label>
          </div>
          {searching ? (
            <SearchResults hits={hits} titleOf={titleOf} kindOf={(tabId) => tabById.get(tabId)?.resource?.kind} onOpen={(tabId) => setDetails({ tabId, rename: false })} onOpenTask={props.onOpenTask} events={events} />
          ) : visible.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">No sources here.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" aria-label={`Sources in ${projectName}`}>
              {visible.map((tab) => (
                <ResourceCard key={tab.id} tab={tab} now={now} actions={cardActions} />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Recent work */}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-label text-foreground">Recent work</h2>
        <ProjectActivity events={events} projectName={projectName} titleOf={titleOf} now={now} limit={showAllActivity ? undefined : 6} {...(props.onOpenTask ? { onOpenTask: props.onOpenTask } : {})} />
        {events.length > 6 && (
          <Button type="button" size="xs" variant="ghost" className="-ml-1.5 w-fit" onClick={() => setShowAllActivity((value) => !value)}>
            {showAllActivity ? "Show less" : "Show all activity"}
          </Button>
        )}
      </div>

      <AddSourceDialog open={addOpen} onOpenChange={setAddOpen} projectName={projectName} onAdd={(inputs) => props.onAddSources(inputs, "manual")} />
      {detailTab?.resource && (
        <SourceDetailsDialog
          tab={detailTab}
          workspaceId={workspace.id}
          focusRename={details?.rename}
          onOpenChange={(open) => !open && setDetails(null)}
          onRename={(tab, title) => props.onRenameSource(tab.id, title)}
          onRetry={(tab) => resources.retry(workspace.id, tab.id)}
          onOpen={props.onOpenSource}
          onAttachPdf={async (tab, file) => void (await resources.attachPdf(workspace.id, tab.id, file))}
          onAttachTranscript={(tab, text) => resources.attachTranscript(workspace.id, tab.id, text)}
        />
      )}
    </section>
  )
}

function SearchResults({
  hits,
  titleOf,
  kindOf,
  onOpen,
  onOpenTask,
  events,
}: {
  hits: ReturnType<typeof searchProject>
  titleOf: (tabId: string) => string | undefined
  kindOf: (tabId: string) => ResourceKind | undefined
  onOpen: (tabId: string) => void
  onOpenTask?: (sessionId: string) => void
  events: ReturnType<typeof useProjectActivity>
}) {
  if (hits.length === 0) return <p className="text-body-sm text-muted-foreground">Nothing in this project mentions that.</p>
  return (
    <ul className="flex flex-col divide-y divide-subtle rounded-md border border-subtle" aria-label="Search results">
      {hits.map((hit, index) => {
        if (hit.type === "result") {
          const event = events.find((entry) => entry.id === hit.id)
          return (
            <li key={`r-${hit.id}-${index}`} className="flex items-start gap-2 p-2">
              {event?.provider && <AgentIcon connector={event.provider} size="xs" />}
              <div className="min-w-0 flex-1">
                <p className="text-body-sm text-foreground">{agentDisplayName(event?.provider)}&apos;s work</p>
                <p className="text-meta text-muted-foreground">{hit.snippet}</p>
              </div>
              {event?.sessionId && onOpenTask && (
                <Button type="button" size="xs" variant="ghost" onClick={() => onOpenTask(event.sessionId!)}>
                  Review
                </Button>
              )}
            </li>
          )
        }
        const where = describeLocation(hit.location)
        const kind = kindOf(hit.tabId)
        return (
          <li key={`s-${hit.tabId}-${index}`}>
            <button type="button" className="flex w-full items-start gap-2 p-2 text-left hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none" onClick={() => onOpen(hit.tabId)}>
              {kind && <SourceKindIcon kind={kind} className="mt-0.5" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm text-foreground">
                  {titleOf(hit.tabId)}
                  {where && <span className="text-tertiary"> — {where}</span>}
                </span>
                <span className={cn("block text-meta text-muted-foreground")}>{hit.snippet}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function BriefForm({ description, focus, onSave, onCancel }: { description: string; focus: string; onSave: (brief: { description: string; focus: string }) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState({ description, focus })
  function submit(event: FormEvent) {
    event.preventDefault()
    onSave(draft)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-subtle p-3" aria-label="Project brief">
      <label className="text-meta text-muted-foreground">
        What is this project about?
        <Textarea className="mt-1 min-h-14 text-body-sm" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={280} />
      </label>
      <label className="text-meta text-muted-foreground">
        Goal or research question
        <Input className="mt-1" value={draft.focus} onChange={(event) => setDraft({ ...draft, focus: event.target.value })} maxLength={160} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Save brief
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * The page around an empty project's home: its name, and the drawer button
 * the sidebar needs below `md`. A project with tabs uses the workspace view's
 * own header instead.
 */
/** "Alt+Shift+H" as Chrome reports it → "Alt + Shift + H". */
export function formatShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean)
    .join(" + ")
}

/**
 * How Chrome tabs get into this project, once Hubble for Chrome has said it is
 * here: the extension's item in a tab's own right-click menu, named for the
 * project on screen (which is the project it adds to), and its shortcut.
 *
 *     Add anything useful from Chrome to this project.
 *     Right-click a tab → Add to History IA        Alt + Shift + H also works.
 */
function ChromeQuickAdd({ projectName, shortcut, className }: { projectName: string; shortcut: string; className?: string }) {
  return (
    <div className={cn("flex-col gap-0.5", className ?? "flex")} data-add-hint data-quick-add-target={projectName}>
      <p className="text-body-sm text-muted-foreground">Add anything useful from Chrome to this project.</p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-body-sm text-foreground">
          Right-click a tab → Add to <span className="font-medium">{projectName}</span>
        </span>
        {shortcut && (
          <span className="flex items-center gap-1.5 text-meta text-tertiary">
            <Kbd>{formatShortcut(shortcut)}</Kbd> also works.
          </span>
        )}
      </p>
    </div>
  )
}

export function ProjectPage({ workspace, onOpenSidebar, children }: { workspace: Workspace; onOpenSidebar?: () => void; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="flex h-12 items-center gap-2 border-b border-subtle px-4">
        {onOpenSidebar && (
          <Button type="button" size="icon-sm" variant="ghost" className="md:hidden" aria-label="Open sidebar" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </Button>
        )}
        <FolderGit2 aria-hidden className="hidden size-4 text-tertiary" />
        <h1 className="truncate text-h2 text-foreground">{workspace.name.trim() || "Untitled project"}</h1>
      </header>
      <main className="mx-auto w-full max-w-(--tabdump-content-max-width) px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
