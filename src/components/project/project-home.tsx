"use client"

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { ArrowRight, CheckSquare, ChevronDown, ChevronLeft, PanelLeftOpen, Search, Sparkles, Trash2, X } from "lucide-react"
import { SubjectActionsMenu, type SubjectMenuActions } from "@/components/workspace/workspace-header"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AskAiMenu } from "@/components/agents/agent-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { ResourceCard } from "./resource-card"
import { ProjectActivity } from "./project-activity"
import { AddMenu } from "./add-menu"
import { AddSourceDialog } from "./add-source-dialog"
import { SourceDetailsDialog } from "./source-details-dialog"
import { ProjectDropOverlay, useExternalDrop } from "./project-drop-zone"
import { SourceKindIcon } from "./source-status"
import { useLastTask } from "@/hooks/use-last-task"
import { useProjectActivity } from "@/hooks/use-project-activity"
import { useProjectContents } from "@/hooks/use-project-contents"
import { tabsContext, workspaceContext } from "@/lib/agents/command-centre/working-context"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { aiName } from "@/lib/product/ai-vocabulary"
import { subjectName } from "@/lib/product/subjects"
import { describeLocation, searchProject } from "@/lib/resources/search"
import { needsAttention, projectSources } from "@/lib/resources/ingest"
import { projectState } from "@/lib/projects/state"
import { recordLoopMilestone } from "@/lib/product/loop-log"
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
  /** "Ask AI" on one resource: a chat about it. */
  onUseInTask?: (tab: Tab) => void
  onOpenTask?: (sessionId: string) => void
  onUpdateBrief?: (brief: { description: string; focus: string }) => void
  /** Where "Connect AI" goes, shown only while no AI is connected. */
  onConnectAI?: () => void
  /** The connected local folder's name, when the subject has one — its files. */
  folderName?: string
  /** AIs connected in Hubble (the roster). */
  agents: readonly { provider: AgentProviderId; name: string }[]
  /** Shown under the empty state, behind "Paste a list of tabs": the older dump-everything input. */
  emptyExtra?: ReactNode
  /**
   * Present once Hubble for Chrome has said it is here: a tab's right-click
   * menu ("Add to <subject>") and the shortcut add Chrome tabs to this
   * subject — the one on screen.
   */
  quickAdd?: { shortcut: string }
}

/**
 * A subject's page.
 *
 *     History HL                                   [+ Add ▾]  [✦ Ask AI ▾]
 *     The causes and consequences of WW1
 *
 *     Continue with Claude · Summary of the Treaty of Versailles   →
 *
 *     Resources  12                        [Select]   [Search History HL…]
 *     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 *     │ Treaty of …  │ │ JSTOR article│ │ YouTube …    │
 *     └──────────────┘ └──────────────┘ └──────────────┘
 *
 *     Recent activity ▸
 *
 * The subject (a workspace — see lib/product/subjects.ts) leads with its
 * name and the two things to do: put something in, and ask AI about it.
 * Ask AI uses the selected resources when some are selected, else the
 * whole subject; which AI, session or context is never asked. Collections
 * and the rest of the subject's tabs follow below, in the workspace view.
 *
 * The whole page is still a drop target for links and the address bar
 * dragged from Chrome — it just doesn't need a paragraph saying so.
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
  const [showActivity, setShowActivity] = useState(false)
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [editingBrief, setEditingBrief] = useState(false)
  const [dropNotice, setDropNotice] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pasteOpen, setPasteOpen] = useState(false)

  // Coming back to a subject with work in it is the return the loop log counts — once a day per subject, never sent.
  const returning = Boolean(lastTask)
  useEffect(() => {
    if (returning) recordLoopMilestone("project_returned", { once: `${workspace.id}:${new Date().toDateString()}` })
  }, [returning, workspace.id])

  const projectName = subjectName(workspace)
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
      // A file has no address to keep; it belongs to a PDF resource waiting for it.
      const waiting = sources.filter((tab) => tab.resource!.kind === "pdf" && tab.resource!.status !== "ready")
      const pdf = dropped.files.find((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
      const match = pdf ? (waiting.find((tab) => tab.resource!.meta?.fileName === pdf.name || decodeURIComponent(tab.url).toLowerCase().endsWith(`/${pdf.name.toLowerCase()}`)) ?? (waiting.length === 1 ? waiting[0] : undefined)) : undefined
      if (pdf && match) {
        void resources.attachPdf(workspace.id, match.id, pdf)
        setDropNotice(null)
      } else {
        setDropNotice(pdf ? "Add the PDF's link first, then drop the file on it." : "That couldn't be added. Try a link instead.")
      }
    } else {
      setDropNotice("That couldn't be added. Try a link instead.")
    }
  }
  const { active } = useExternalDrop({ enabled: true, onDrop: handleDrop })

  // Only the filters that would show something different from "All".
  const kindsPresent = FILTERS.filter((entry) => entry.id !== "all" && sources.some(entry.matches))
  const filters = kindsPresent.length > 1 || kindsPresent.some((entry) => entry.id === "attention") ? [FILTERS[0]!, ...kindsPresent] : []
  const visible = sources.filter((FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0]!).matches)
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
  // Ask AI works on what is selected, or the whole subject.
  const chosen = [...selected].filter((id) => tabById.has(id))
  const askContext = chosen.length > 0 ? tabsContext(workspace.id, chosen) : workspaceContext(workspace.id)

  function stopSelecting() {
    setSelecting(false)
    setSelected(new Set())
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const addMenu = (size: "default" | "lg", variant: "default" | "secondary") => (
    <AddMenu
      subjectName={projectName}
      onAdd={(inputs) => props.onAddSources(inputs, "manual")}
      onOpenLink={() => setAddOpen(true)}
      size={size}
      variant={variant}
      {...(props.quickAdd ? { quickAdd: props.quickAdd } : {})}
    />
  )

  return (
    <section aria-label={projectName} className="mb-6 flex flex-col gap-8" data-project-home={workspace.id}>
      <ProjectDropOverlay active={active} projectName={projectName} />

      {/* The subject, and the two things to do with it. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-statement text-foreground" data-subject-title>
            {projectName}
          </h1>
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
            <button
              type="button"
              className="mt-1 block max-w-prose text-left text-body text-muted-foreground hover:text-foreground disabled:pointer-events-none"
              disabled={!props.onUpdateBrief}
              onClick={() => setEditingBrief(true)}
              title="Edit details"
            >
              {workspace.brief.description || workspace.brief.focus}
              {workspace.brief.description && workspace.brief.focus && <span className="text-tertiary"> · {workspace.brief.focus}</span>}
            </button>
          ) : (
            props.onUpdateBrief && (
              <button type="button" className="mt-1 text-body-sm text-tertiary hover:text-foreground" onClick={() => setEditingBrief(true)}>
                Add details
              </button>
            )
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {addMenu("lg", "default")}
          <AskAiMenu context={askContext} variant="secondary" label={chosen.length > 0 ? `Ask AI · ${chosen.length}` : "Ask AI"} />
          {props.agents.length === 0 && props.onConnectAI && (
            <Button type="button" size="sm" variant="ghost" onClick={props.onConnectAI}>
              Connect AI
            </Button>
          )}
        </div>
      </div>

      {/* Where the last AI chat was left: one line, one click. */}
      {state.lastTask && props.onOpenTask && (
        <button
          type="button"
          onClick={() => props.onOpenTask!(state.lastTask!.sessionId)}
          className="-mt-3 flex min-w-0 items-center gap-2 self-start rounded-md border border-subtle bg-card px-3 py-2 text-left transition-colors hover:border-strong focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          data-project-left-off
        >
          <AgentIcon connector={state.lastTask.provider} size="xs" />
          <span className="shrink-0 text-body-sm text-foreground">Continue with {aiName(state.lastTask.provider)}</span>
          <span className="min-w-0 truncate text-body-sm text-tertiary" title={state.lastTask.task}>
            · {state.lastTask.headline}
          </span>
          <ArrowRight aria-hidden className="size-3.5 shrink-0 text-tertiary" />
        </button>
      )}

      {dropNotice && (
        <p role="alert" className="-mt-3 flex items-center gap-2 text-body-sm text-destructive">
          {dropNotice}
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setDropNotice(null)}>
            <X />
          </Button>
        </p>
      )}

      {/* Resources. A subject that only has saved tabs (from before resources) shows them below, not "No resources yet". */}
      {sources.length === 0 && workspace.tabs.length > 0 ? null : sources.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-strong px-5 py-8" data-project-empty>
          <p className="text-h2 text-foreground">No resources yet.</p>
          {addMenu("default", "secondary")}
          {props.quickAdd && (
            <p className="hidden text-meta text-tertiary md:block" data-add-hint data-quick-add-target={projectName}>
              In Chrome: right-click a tab → Add to {projectName}
              {props.quickAdd.shortcut && (
                <>
                  {" "}
                  · <Kbd>{formatShortcut(props.quickAdd.shortcut)}</Kbd>
                </>
              )}
            </p>
          )}
          {props.emptyExtra && (
            <div className="w-full">
              <button
                type="button"
                className="flex items-center gap-1 text-meta text-tertiary hover:text-foreground"
                aria-expanded={pasteOpen}
                onClick={() => setPasteOpen((open) => !open)}
              >
                Paste a list of tabs <ChevronDown aria-hidden className={cn("size-3 transition-transform", pasteOpen && "rotate-180")} />
              </button>
              {pasteOpen && <div className="mt-2 max-w-xl">{props.emptyExtra}</div>}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h2 text-foreground">Resources</h2>
            <span className="text-meta text-tertiary" data-project-counts>
              {sources.length}
            </span>
            {working > 0 && (
              <span role="status" className="text-meta text-muted-foreground">
                · Reading {plural(working, "resource", "resources")}…
              </span>
            )}
            <div className="ml-auto flex w-full items-center gap-1.5 sm:w-auto">
              {selecting ? (
                <Button type="button" size="sm" variant="ghost" onClick={stopSelecting}>
                  <X /> Cancel
                </Button>
              ) : (
                <Button type="button" size="sm" variant="ghost" onClick={() => setSelecting(true)}>
                  <CheckSquare /> Select
                </Button>
              )}
              <label className="relative flex-1 sm:w-56 sm:flex-none">
                <span className="sr-only">Search {projectName}</span>
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${projectName}…`} className="pl-7" />
              </label>
            </div>
          </div>
          {filters.length > 0 && (
            <div className="-mt-1 flex flex-wrap gap-1" role="group" aria-label="Show resources">
              {filters.map((entry) => (
                <Button key={entry.id} type="button" size="xs" variant={filter === entry.id ? "secondary" : "ghost"} aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
                  {entry.label}
                </Button>
              ))}
            </div>
          )}
          {selecting && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-subtle bg-card px-3 py-2" role="toolbar" aria-label="Selected resources">
              <span className="text-body-sm text-foreground">{chosen.length > 0 ? `${chosen.length} selected` : "Select resources to ask AI about"}</span>
              <span className="min-w-0 flex-1" />
              {chosen.length > 0 && (
                <>
                  <AskAiMenu context={askContext} size="sm" />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      props.onRemoveSources(chosen)
                      stopSelecting()
                    }}
                  >
                    <Trash2 /> Remove
                  </Button>
                </>
              )}
            </div>
          )}
          {searching ? (
            <SearchResults hits={hits} titleOf={titleOf} kindOf={(tabId) => tabById.get(tabId)?.resource?.kind} onOpen={(tabId) => setDetails({ tabId, rename: false })} onOpenTask={props.onOpenTask} events={events} />
          ) : visible.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">Nothing here.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" aria-label={`Resources in ${projectName}`}>
              {visible.map((tab) => (
                <ResourceCard
                  key={tab.id}
                  tab={tab}
                  now={now}
                  actions={cardActions}
                  {...(selecting ? { selection: { selected: selected.has(tab.id), onToggle: () => toggle(tab.id) } } : {})}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Recent activity: there when wanted, not in the way — and not at all until there is something in the subject. */}
      {events.length > 0 && (workspace.tabs.length > 0 || state.lastTask) && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            className="flex w-fit items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground"
            aria-expanded={showActivity}
            onClick={() => setShowActivity((open) => !open)}
          >
            <Sparkles aria-hidden className="size-3.5" /> Recent activity
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", showActivity && "rotate-180")} />
          </button>
          {showActivity && (
            <>
              <ProjectActivity events={events} projectName={projectName} titleOf={titleOf} now={now} limit={showAllActivity ? undefined : 6} {...(props.onOpenTask ? { onOpenTask: props.onOpenTask } : {})} />
              {events.length > 6 && (
                <Button type="button" size="xs" variant="ghost" className="-ml-1.5 w-fit" onClick={() => setShowAllActivity((value) => !value)}>
                  {showAllActivity ? "Show less" : "Show all activity"}
                </Button>
              )}
            </>
          )}
        </div>
      )}

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
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2 rounded-md border border-subtle p-3" aria-label="Subject details">
      <label className="text-meta text-muted-foreground">
        What is it about?
        <Textarea className="mt-1 min-h-14 text-body-sm" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={280} />
      </label>
      <label className="text-meta text-muted-foreground">
        Current goal
        <Input className="mt-1" value={draft.focus} onChange={(event) => setDraft({ ...draft, focus: event.target.value })} maxLength={160} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** "Alt+Shift+H" as Chrome reports it → "Alt + Shift + H". */
export function formatShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean)
    .join(" + ")
}

/**
 * The page around an empty subject: the way back to Subjects, the subject's
 * menu, and the drawer button the sidebar needs below `md`. A subject with
 * things in it uses the workspace view's own bar instead.
 */
export function ProjectPage({
  workspace,
  onOpenSidebar,
  onBack,
  onRenameSubject,
  onUpdateSubjectLogo,
  onDeleteSubject,
  canDeleteSubject = false,
  children,
}: {
  workspace: Workspace
  onOpenSidebar?: () => void
  onBack?: () => void
  onRenameSubject?: (name: string) => void
  onUpdateSubjectLogo?: (logo: string | undefined) => void
  onDeleteSubject?: () => void
  canDeleteSubject?: boolean
  children: ReactNode
}) {
  const subjectMenu: SubjectMenuActions | undefined =
    onRenameSubject && onUpdateSubjectLogo && onDeleteSubject
      ? { onRename: onRenameSubject, onUpdateLogo: onUpdateSubjectLogo, onDelete: onDeleteSubject, canDelete: canDeleteSubject }
      : undefined
  return (
    <div className="min-h-screen">
      <header className="flex h-12 items-center gap-2 border-b border-subtle px-4">
        {onOpenSidebar && (
          <Button type="button" size="icon-sm" variant="ghost" className="md:hidden" aria-label="Open sidebar" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </Button>
        )}
        {onBack ? (
          <Button type="button" variant="ghost" size="sm" className="-ml-1.5 mr-auto" onClick={onBack}>
            <ChevronLeft /> Subjects
          </Button>
        ) : (
          <span className="mr-auto truncate text-h2 text-foreground">{subjectName(workspace)}</span>
        )}
        {subjectMenu && <SubjectActionsMenu workspace={workspace} subjectMenu={subjectMenu} />}
      </header>
      <main className="mx-auto w-full max-w-(--tabdump-content-max-width) px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
