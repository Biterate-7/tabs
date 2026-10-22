"use client"

import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import { ArrowUpRight, CheckSquare, ChevronDown, ChevronLeft, FileInput, FileText, FileUp, History, MessageSquareShare, NotebookPen, Orbit, PanelLeftOpen, Play, Search, Trash2, X } from "lucide-react"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { ItemIcon } from "@/components/memory/item-icon"
import { pageIconOf } from "@/lib/memory/item-icon"
import { ProjectIcon } from "@/components/workspace/project-icon"
import { LaunchConfirmDialog, useSessionLaunch } from "@/components/sessions/use-session-launch"
import { useTabSessions } from "@/hooks/use-tab-sessions"
import { connectedProjects } from "@/lib/knowledge-graph/related"
import { itemActivityAt } from "@/lib/memory/kinds"
import { sortByActivity } from "@/lib/sessions/model"
import { formatRelativeTime } from "@/lib/time-format"
import { SubjectActionsMenu, type SubjectMenuActions } from "@/components/workspace/workspace-header"
import { useMemoryActions } from "@/components/memory/memory-actions"
import { NoteCard } from "@/components/memory/note-card"
import { NoteDialog } from "@/components/memory/note-dialog"
import { ProviderBadge } from "@/components/memory/provider-mark"
import { SaveFromAiCard, SaveFromAiDialog, SaveFromAiInvite } from "@/components/memory/save-from-ai"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { ResourceCard } from "./resource-card"
import { ProjectActivity } from "./project-activity"
import { AddMenu } from "./add-menu"
import { AddSourceDialog } from "./add-source-dialog"
import { SourceDetailsDialog } from "./source-details-dialog"
import { FileCard } from "./file-card"
import { FileDetailsDialog } from "./file-details-dialog"
import { UploadFilesDialog, useUploadRows } from "./upload-files-dialog"
import type { TranscriptSeek } from "./video-transcript"
import { ProjectDropOverlay, useExternalDrop } from "./project-drop-zone"
import { SourceKindIcon } from "./source-status"
import { useProjectActivity } from "@/hooks/use-project-activity"
import { useProjectContents } from "@/hooks/use-project-contents"
import { subjectName } from "@/lib/product/subjects"
import { describeLocation, markMatches, searchProject, searchTerms } from "@/lib/resources/search"
import { formatTimestamp } from "@/lib/resources/transcript"
import { parseYouTubeUrl, youtubeMomentUrl } from "@/lib/resources/youtube"
import { needsAttention } from "@/lib/resources/ingest"
import { knowledgeCounts, knowledgeItemsOf, refKey } from "@/lib/memory/items"
import { cn } from "@/lib/utils"
import type { CaptureMode } from "@/components/memory/capture-dialog"
import type { DroppedResources } from "@/lib/resources/drop"
import type { IngestOutcome } from "@/lib/resources/ingest"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { ProjectNote } from "@/lib/notes/notes"
import type { ResourceInput, ResourceOrigin } from "@/lib/resources/types"
import type { ResourceActions } from "@/hooks/use-resource-processing"
import type { UploadOutcome } from "@/hooks/use-file-uploads"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

type Filter = "all" | "conversation" | "source" | "note" | "attention"

const FILTERS: { id: Filter; label: string; matches: (item: KnowledgeItem, tab?: Tab) => boolean }[] = [
  { id: "all", label: "All", matches: () => true },
  { id: "conversation", label: "AI conversations", matches: (item) => item.type === "conversation" },
  { id: "source", label: "Sources", matches: (item) => item.type !== "conversation" && item.type !== "note" && item.type !== "excerpt" },
  { id: "note", label: "Notes", matches: (item) => item.type === "note" || item.type === "excerpt" },
  { id: "attention", label: "Needs attention", matches: (_item, tab) => Boolean(tab && needsAttention(tab.resource)) },
]

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** What the project page needs for uploaded files (hooks/use-file-uploads.ts, bound to this project). */
export type ProjectFileActions = {
  upload: (files: readonly File[], onOutcome: (index: number, outcome: UploadOutcome) => void) => Promise<UploadOutcome[]>
  retry: (noteId: string) => void
  download: (noteId: string) => void
}

/** What the project page needs to change a note. */
export type NoteActions = {
  update: (noteId: string, patch: { title?: string; tags?: string[] }) => void
  saveText: (noteId: string, text: string) => Promise<boolean>
  remove: (noteIds: string[]) => void
}

export type ProjectHomeProps = {
  workspace: Workspace
  now: number
  /** The one ingestion pipeline for links. Returns each input's outcome. */
  onAddSources: (inputs: ResourceInput[], origin: ResourceOrigin) => IngestOutcome[]
  resources: ResourceActions
  notes: NoteActions
  /** Upload files from this device. Absent: not offered. */
  files?: ProjectFileActions
  onRenameSource: (tabId: string, title: string) => void
  onRemoveSources: (tabIds: string[]) => void
  onOpenSource: (tab: Tab) => void
  /** Open a resource at an address Hubble built for it — a video at a moment. */
  onOpenSourceAt?: (tab: Tab, url: string) => void
  onUpdateBrief?: (brief: { description: string; focus: string }) => void
  /** Opens the capture dialog: write a note, or import a file. AI conversations come in through Hubble for Chrome (SaveFromAiCard). */
  onCapture: (mode: CaptureMode) => void
  /** Shown under the empty state, behind "Paste a list of tabs": the older dump-everything input. */
  emptyExtra?: ReactNode
  /**
   * Present once Hubble for Chrome has said it is here: a tab's right-click
   * menu ("Add to <project>") and the shortcut add Chrome tabs to this
   * project — the one on screen.
   */
  quickAdd?: { shortcut: string }
  /** An item to open on arrival (from Search or Home): its reader, at a conversation's turn when given. A new nonce opens it again. */
  focusItem?: { ref: KnowledgeItemRef; turn?: number; terms?: readonly string[]; nonce: number }
  /** Renames the project from its title. Absent: the title is plain text. */
  onRename?: (name: string) => void
  /** Every project, for "Connected to" (shared sources). */
  allWorkspaces?: readonly Workspace[]
  onOpenProject?: (workspaceId: string) => void
  /** Opens the Graph focused on a node (this project: `p:<id>`). */
  onShowInGraph?: (nodeId: string) => void
  /** Sessions saved for this project, with Resume. False in Hubble Desktop. */
  showSessions?: boolean
}

/**
 * A project's Knowledge Centre.
 *
 *     History IA                            [+ Add ▾]  [Use in AI chat]
 *     The causes and consequences of WW1
 *
 *     [All 12] [AI conversations 4] [Sources 6] [Notes 2]  [Select] [Search…]
 *     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 *     │ ◇ Causes of… │ │ JSTOR article│ │ My thesis    │
 *     └──────────────┘ └──────────────┘ └──────────────┘
 *
 * Everything the project knows, whichever AI app or website it came from,
 * in one place — and the two things to do with it: bring more in, and use
 * it in an AI chat. Saved tabs that are not sources follow below, in the
 * workspace view. The whole page is still a drop target for links dragged
 * from Chrome.
 */
export function ProjectHome(props: ProjectHomeProps) {
  const { workspace, now, resources } = props
  const memory = useMemoryActions()
  const items = useMemo(() => knowledgeItemsOf(workspace), [workspace])
  const counts = useMemo(() => knowledgeCounts(items), [items])
  const events = useProjectActivity(workspace.id)
  const [addOpen, setAddOpen] = useState(false)
  const [details, setDetails] = useState<{ tabId: string; rename: boolean; seek?: TranscriptSeek; turn?: number } | null>(null)
  const [openNote, setOpenNote] = useState<{ noteId: string; turn?: number; page?: number } | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const uploads = useUploadRows((files, onOutcome) => (props.files ? props.files.upload(files, onOutcome) : Promise.resolve([])))
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const [showActivity, setShowActivity] = useState(false)
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [editingBrief, setEditingBrief] = useState(false)
  const [dropNotice, setDropNotice] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pasteOpen, setPasteOpen] = useState(false)
  const [saveFromAiOpen, setSaveFromAiOpen] = useState(false)
  // Arriving with an item to open (Search, Home): opened once per request — adjusting state during render, not in an effect.
  const [seenFocus, setSeenFocus] = useState<number | undefined>(undefined)
  const [focusTerms, setFocusTerms] = useState<readonly string[]>([])
  const focus = props.focusItem
  if (focus && focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce)
    setFocusTerms(focus.terms ?? [])
    if (focus.ref.kind === "note") setOpenNote({ noteId: focus.ref.noteId, ...(focus.turn !== undefined ? { turn: focus.turn } : {}) })
    else setDetails({ tabId: focus.ref.tabId, rename: false, ...(focus.turn !== undefined ? { turn: focus.turn } : {}) })
  }

  const projectName = subjectName(workspace)
  const { sessions: allSessions } = useTabSessions()
  const launcher = useSessionLaunch()
  const session = useMemo(() => (props.showSessions ? sortByActivity(allSessions.filter((entry) => entry.workspaceId === workspace.id))[0] : undefined), [props.showSessions, allSessions, workspace.id])
  const related = useMemo(() => (props.allWorkspaces ? connectedProjects(props.allWorkspaces, workspace.id).slice(0, 3) : []), [props.allWorkspaces, workspace.id])
  const lastItem = useMemo(() => [...items].sort((a, b) => itemActivityAt(b) - itemActivityAt(a))[0], [items])
  const lastActive = lastItem ? itemActivityAt(lastItem) : undefined
  const [renaming, setRenaming] = useState(false)
  const tabById = useMemo(() => new Map(workspace.tabs.map((tab) => [tab.id, tab])), [workspace.tabs])
  const noteById = useMemo(() => new Map((workspace.notes ?? []).map((note) => [note.id, note])), [workspace.notes])
  const working = items.filter((item) => item.status === "pending" || item.status === "processing").length
  const searching = query.trim().length > 1
  const contents = useProjectContents(useMemo(() => (searching ? [workspace] : []), [searching, workspace]))
  const titleOf = (tabId: string) => {
    const tab = tabById.get(tabId)
    return tab ? tab.title?.trim() || tab.domain : undefined
  }

  const activeFilter = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0]!
  const visible = items.filter((item) => activeFilter.matches(item, item.ref.kind === "source" ? tabById.get(item.ref.tabId) : undefined))

  const hits = useMemo(() => {
    if (!searching) return []
    // A filter narrows search too.
    const shownTabs = filter === "all" ? workspace.tabs : workspace.tabs.filter((tab) => visible.some((item) => item.ref.kind === "source" && item.ref.tabId === tab.id))
    const shownNotes = (workspace.notes ?? []).filter((note) => filter === "all" || visible.some((item) => item.ref.kind === "note" && item.ref.noteId === note.id))
    return searchProject({ query, tabs: shownTabs, contents: contents.get(workspace.id) ?? new Map(), notes: shownNotes, limit: 30 })
  }, [searching, query, filter, workspace.tabs, workspace.notes, workspace.id, contents, visible])

  function startUpload(files: readonly File[]) {
    uploads.add(files)
    setUploadOpen(true)
  }

  const handleDrop = (dropped: DroppedResources) => {
    if (dropped.inputs.length > 0) {
      props.onAddSources(dropped.inputs, "chrome")
      setDropNotice(null)
    } else if (dropped.files.length > 0) {
      // A single PDF named like a PDF link that is waiting for its file completes that link; any other file is uploaded.
      const waiting = workspace.tabs.filter((tab) => tab.resource?.kind === "pdf" && tab.resource.status !== "ready")
      const pdf = dropped.files.length === 1 ? dropped.files.find((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) : undefined
      const match = pdf ? waiting.find((tab) => tab.resource!.meta?.fileName === pdf.name || safeDecode(tab.url).toLowerCase().endsWith(`/${pdf.name.toLowerCase()}`)) : undefined
      if (pdf && match) {
        void resources.attachPdf(workspace.id, match.id, pdf)
        setDropNotice(null)
      } else if (props.files) {
        startUpload(dropped.files)
        setDropNotice(null)
      } else {
        setDropNotice(pdf ? "Add the PDF's link first, then drop the file on it." : "Files can't be added here.")
      }
    } else {
      setDropNotice("That couldn't be added. Try a link instead.")
    }
  }
  const { active } = useExternalDrop({ enabled: true, onDrop: handleDrop })

  const tabOfItem = (item: KnowledgeItem) => (item.ref.kind === "source" ? tabById.get(item.ref.tabId) : undefined)
  const filterCounts = new Map(FILTERS.map((entry) => [entry.id, items.filter((item) => entry.matches(item, tabOfItem(item))).length]))
  const kindsPresent = FILTERS.filter((entry) => entry.id !== "all" && (filterCounts.get(entry.id) ?? 0) > 0)
  const filters = kindsPresent.length > 1 || kindsPresent.some((entry) => entry.id === "attention") ? [FILTERS[0]!, ...kindsPresent] : []
  const detailTab = details ? (tabById.get(details.tabId) ?? null) : null
  const detailNote: ProjectNote | null = openNote ? (noteById.get(openNote.noteId) ?? null) : null

  const reuse = (refs: readonly KnowledgeItemRef[]) => memory?.reuse({ workspaceId: workspace.id, refs })
  const fileActions = {
    onOpen: (note: ProjectNote) => setOpenNote({ noteId: note.id }),
    ...(memory ? { onUseInAi: (note: ProjectNote) => reuse([{ kind: "note", noteId: note.id }]) } : {}),
    onDownload: (note: ProjectNote) => props.files?.download(note.id),
    onRetry: (note: ProjectNote) => props.files?.retry(note.id),
    onRemove: (note: ProjectNote) => props.notes.remove([note.id]),
  }
  const cardActions = {
    onOpen: props.onOpenSource,
    ...(memory ? { onUseInAi: (tab: Tab) => reuse([{ kind: "source", tabId: tab.id }]) } : {}),
    onRename: (tab: Tab) => setDetails({ tabId: tab.id, rename: true }),
    onRemove: (tab: Tab) => props.onRemoveSources([tab.id]),
    onRetry: (tab: Tab) => resources.retry(workspace.id, tab.id),
    onDetails: (tab: Tab) => setDetails({ tabId: tab.id, rename: false }),
    onCopyUrl: (tab: Tab) => void navigator.clipboard?.writeText(tab.url).catch(() => undefined),
  }
  const chosen = items.filter((item) => selected.has(refKey(item.ref)))

  function stopSelecting() {
    setSelecting(false)
    setSelected(new Set())
  }

  function toggle(ref: KnowledgeItemRef) {
    setSelected((current) => {
      const next = new Set(current)
      const key = refKey(ref)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function removeChosen() {
    const tabIds = chosen.flatMap((item) => (item.ref.kind === "source" ? [item.ref.tabId] : []))
    const noteIds = chosen.flatMap((item) => (item.ref.kind === "note" ? [item.ref.noteId] : []))
    if (tabIds.length > 0) props.onRemoveSources(tabIds)
    if (noteIds.length > 0) props.notes.remove(noteIds)
    stopSelecting()
  }

  const addMenu = (size: "default" | "lg", variant: "default" | "secondary") => (
    <AddMenu
      subjectName={projectName}
      onAdd={(inputs) => props.onAddSources(inputs, "manual")}
      onOpenLink={() => setAddOpen(true)}
      onCapture={(mode) => props.onCapture(mode)}
      onSaveFromAi={() => setSaveFromAiOpen(true)}
      {...(props.files ? { onUpload: () => setUploadOpen(true) } : {})}
      size={size}
      variant={variant}
      {...(props.quickAdd ? { quickAdd: props.quickAdd } : {})}
    />
  )

  return (
    <section aria-label={projectName} className="mb-6 flex flex-col gap-8" data-project-home={workspace.id}>
      <ProjectDropOverlay active={active} projectName={projectName} />

      {/* The project, and the two things to do with it. */}
      <div className="flex flex-col gap-4 animate-enter sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
        <ProjectIcon workspace={workspace} size={24} className="mt-1.5 max-sm:hidden" />
        <div className="min-w-0">
          {renaming && props.onRename ? (
            <RenameTitle
              name={workspace.name}
              onDone={(name) => {
                setRenaming(false)
                if (name && name !== workspace.name) props.onRename!(name)
              }}
            />
          ) : (
            <h1 className="truncate text-statement text-foreground" data-subject-title>
              {props.onRename ? (
                <button type="button" className="max-w-full truncate rounded-xs text-left outline-none hover:underline hover:decoration-border-strong hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring/60" title="Rename" onClick={() => setRenaming(true)}>
                  {projectName}
                </button>
              ) : (
                projectName
              )}
            </h1>
          )}
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
                Add description
              </button>
            )
          )}
          {items.length > 0 && (
            <p className="mt-2 text-meta text-tertiary" data-project-summary>
              {[
                counts.conversations > 0 ? plural(counts.conversations, "conversation", "conversations") : "",
                counts.sources > 0 ? plural(counts.sources, "source or file", "sources and files") : "",
                counts.notes > 0 ? plural(counts.notes, "note", "notes") : "",
                lastActive ? `active ${formatRelativeTime(lastActive, now)?.toLowerCase()}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {addMenu("lg", "default")}
          {memory && items.length + workspace.tabs.length > 0 && (
            <Button type="button" size="lg" variant="secondary" onClick={() => reuse(chosen.length > 0 ? chosen.map((item) => item.ref) : [])}>
              <MessageSquareShare /> {chosen.length > 0 ? `Use ${chosen.length} in AI` : "Use in AI"}
            </Button>
          )}
        </div>
      </div>

      {/* Where to pick up: the latest item, the session saved for this project, and what it connects to. */}
      {items.length > 0 && (
        <div className="grid grid-cols-1 gap-2 animate-enter md:grid-cols-3" data-project-overview>
          {lastItem && (
            <button
              type="button"
              onClick={() => (lastItem.ref.kind === "note" ? setOpenNote({ noteId: lastItem.ref.noteId }) : setDetails({ tabId: lastItem.ref.tabId, rename: false }))}
              className="group flex min-w-0 flex-col gap-2 rounded-lg border border-subtle bg-card p-3.5 text-left outline-none transition-[border-color,box-shadow] duration-(--duration-fast) ease-(--ease-color) hover:border-strong hover:shadow-(--shadow-sm) focus-visible:ring-2 focus-visible:ring-ring/60"
              aria-label={`Pick up: ${lastItem.title}`}
            >
              <span className="flex items-center justify-between text-eyebrow text-tertiary">
                Pick up
                <ArrowUpRight aria-hidden className="size-3.5 opacity-60 transition-transform duration-(--duration-fast) ease-(--ease-standard) group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </span>
              <span className="flex min-w-0 items-center gap-2.5">
                <ItemIcon item={lastItem} favicon={pageIconOf(workspace, lastItem)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-foreground">{lastItem.title}</span>
                  <span className="block truncate text-meta text-tertiary">{formatRelativeTime(itemActivityAt(lastItem), now)}</span>
                </span>
              </span>
            </button>
          )}
          {session ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-subtle bg-card p-3.5" data-project-session>
              <span className="text-eyebrow text-tertiary">Session</span>
              <span className="flex min-w-0 items-center gap-2.5">
                <KindGlyph kind="session" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-foreground">{session.name}</span>
                  <span className="block truncate text-meta text-tertiary">
                    {plural(session.tabs.length, "tab", "tabs")} · {formatRelativeTime(Math.max(session.updatedAt, session.lastRestoredAt ?? 0), now)}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={launcher.pending}
                  aria-label={`Resume ${session.name}`}
                  onClick={() => void launcher.launch({ tabs: session.tabs.map((tab) => ({ url: tab.url, ...(tab.pinned ? { pinned: true } : {}) })), sessionIds: [session.id] })}
                >
                  <Play /> {launcher.pending ? "Opening…" : "Resume"}
                </Button>
              </span>
            </div>
          ) : null}
          {(related.length > 0 || props.onShowInGraph) && (
            <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-subtle bg-card p-3.5" data-project-related>
              <span className="flex items-center justify-between text-eyebrow text-tertiary">
                {related.length > 0 ? "Connected to" : "In the graph"}
                {props.onShowInGraph && (
                  <button type="button" className="flex items-center gap-1 normal-case tracking-normal text-tertiary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60" onClick={() => props.onShowInGraph!(`p:${workspace.id}`)}>
                    <Orbit aria-hidden className="size-3" /> Show in graph
                  </button>
                )}
              </span>
              {related.length > 0 ? (
                <ul className="flex flex-col">
                  {related.map(({ workspace: other, shared }) => (
                    <li key={other.id}>
                      <button type="button" disabled={!props.onOpenProject} onClick={() => props.onOpenProject?.(other.id)} className="flex w-full min-w-0 items-center gap-2 rounded-xs py-0.5 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
                        <ProjectIcon workspace={other} size={16} />
                        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{subjectName(other)}</span>
                        <span className="shrink-0 text-meta text-tertiary">{plural(shared, "shared source", "shared sources")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-body-sm text-muted-foreground">Nothing shared with another project yet.</p>
              )}
            </div>
          )}
        </div>
      )}

      {dropNotice && (
        <p role="alert" className="-mt-3 flex items-center gap-2 text-body-sm text-destructive">
          {dropNotice}
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setDropNotice(null)}>
            <X />
          </Button>
        </p>
      )}

      {/* The knowledge. A project that only has saved tabs (from a dump) shows them below, not "Nothing saved yet". */}
      {items.length === 0 && workspace.tabs.length > 0 ? (
        <CaptureInvite onCapture={props.onCapture} />
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-md border border-dashed border-strong px-5 py-8" data-project-empty>
          <p className="text-h2 text-foreground">Nothing saved yet</p>
          <SaveFromAiCard />
          <div className="flex flex-wrap gap-2" data-capture-invite>
            <Button type="button" variant="secondary" onClick={() => props.onCapture("note")}>
              <NotebookPen /> Write a note
            </Button>
            {props.files && (
              <Button type="button" variant="secondary" onClick={() => setUploadOpen(true)}>
                <FileUp /> Upload files
              </Button>
            )}
          </div>
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
            <h2 className="sr-only">Knowledge</h2>
            {filters.length > 0 ? (
              <div className="flex flex-wrap gap-0.5 rounded-md border border-subtle bg-card p-0.5" role="group" aria-label="Show">
                {filters.map((entry) => (
                  <Button key={entry.id} type="button" size="sm" variant={filter === entry.id ? "secondary" : "ghost"} className={cn(filter === entry.id && "border-transparent shadow-(--shadow-sm)")} aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
                    {entry.id === "conversation" && <span aria-hidden className="size-1.5 rounded-full bg-kind-conversation" />}
                    {entry.id === "source" && <span aria-hidden className="size-1.5 rounded-full bg-kind-source" />}
                    {entry.id === "note" && <span aria-hidden className="size-1.5 rounded-full bg-kind-note" />}
                    {entry.id === "attention" && <span aria-hidden className="size-1.5 rounded-full bg-warning" />}
                    {entry.label}
                    <span className="text-tertiary tabular-nums" data-filter-count>
                      {filterCounts.get(entry.id) ?? 0}
                    </span>
                  </Button>
                ))}
              </div>
            ) : (
              <span className="text-meta text-tertiary" data-project-counts>
                {plural(items.length, "item", "items")}
              </span>
            )}
            {working > 0 && (
              <span role="status" className="text-meta text-muted-foreground">
                Reading {plural(working, "item", "items")}…
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
          {counts.conversations === 0 && <CaptureInvite onCapture={props.onCapture} />}
          {selecting && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-subtle bg-card px-3 py-2" role="toolbar" aria-label="Selected items">
              <span className="text-body-sm text-foreground">{chosen.length > 0 ? `${chosen.length} selected` : "Select items"}</span>
              <span className="min-w-0 flex-1" />
              {chosen.length > 0 && (
                <>
                  {memory && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => reuse(chosen.map((item) => item.ref))}>
                      <MessageSquareShare /> Use in AI
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="ghost" onClick={removeChosen}>
                    <Trash2 /> Remove
                  </Button>
                </>
              )}
            </div>
          )}
          {searching ? (
            <SearchResults
              hits={hits}
              terms={searchTerms(query)}
              titleOf={titleOf}
              tabOf={(tabId) => tabById.get(tabId)}
              noteOf={(noteId) => noteById.get(noteId)}
              onOpen={(tabId, seek, turn) => setDetails({ tabId, rename: false, ...(seek ? { seek } : {}), ...(turn !== undefined ? { turn } : {}) })}
              onOpenNote={(noteId, turn, page) => setOpenNote({ noteId, ...(turn !== undefined ? { turn } : {}), ...(page !== undefined ? { page } : {}) })}
              {...(props.onOpenSourceAt ? { onOpenAt: props.onOpenSourceAt } : {})}
              working={working}
            />
          ) : visible.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">Nothing here.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" aria-label={`Knowledge in ${projectName}`}>
              {visible.map((item) => {
                const selection = selecting ? { selected: selected.has(refKey(item.ref)), onToggle: () => toggle(item.ref) } : undefined
                if (item.ref.kind === "note") {
                  const note = noteById.get(item.ref.noteId)
                  if (!note) return null
                  if (note.kind === "file" && note.file) return <FileCard key={item.id} note={note} now={now} actions={fileActions} {...(selection ? { selection } : {})} />
                  return (
                    <NoteCard
                      key={item.id}
                      note={note}
                      now={now}
                      onOpen={() => setOpenNote({ noteId: note.id })}
                      {...(memory ? { onUseInAi: () => reuse([{ kind: "note", noteId: note.id }]) } : {})}
                      onDelete={() => props.notes.remove([note.id])}
                      {...(selection ? { selection } : {})}
                    />
                  )
                }
                const tab = tabById.get(item.ref.tabId)
                if (!tab) return null
                return <ResourceCard key={tab.id} tab={tab} now={now} actions={cardActions} {...(selection ? { selection } : {})} />
              })}
            </ul>
          )}
        </div>
      )}

      {/* Recent activity: there when wanted, not in the way — and not at all until there is something in the project. */}
      {events.length > 0 && workspace.tabs.length + items.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            className="flex w-fit items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground"
            aria-expanded={showActivity}
            onClick={() => setShowActivity((open) => !open)}
          >
            <History aria-hidden className="size-3.5" /> Recent activity
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", showActivity && "rotate-180")} />
          </button>
          {showActivity && (
            <>
              <ProjectActivity events={events} projectName={projectName} titleOf={(id) => titleOf(id) ?? noteById.get(id)?.title} now={now} limit={showAllActivity ? undefined : 6} />
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
      <SaveFromAiDialog open={saveFromAiOpen} onOpenChange={setSaveFromAiOpen} />
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
          {...(props.onOpenSourceAt ? { onOpenAt: props.onOpenSourceAt } : {})}
          {...(details?.seek ? { seek: details.seek } : {})}
          {...(details?.turn !== undefined ? { focusTurn: details.turn, terms: query.trim() ? searchTerms(query) : focusTerms } : {})}
        />
      )}
      <UploadFilesDialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open)
          if (!open) uploads.clearFinished()
        }}
        projectName={projectName}
        rows={uploads.rows}
        notes={workspace.notes ?? []}
        onChoose={uploads.add}
        onAgain={uploads.again}
        onRetry={(noteId) => props.files?.retry(noteId)}
        onOpenFile={(noteId) => {
          setUploadOpen(false)
          uploads.clearFinished()
          setOpenNote({ noteId })
        }}
      />
      {detailNote?.kind === "file" && detailNote.file && (
        <FileDetailsDialog
          key={detailNote.id}
          note={detailNote}
          workspaceId={workspace.id}
          onOpenChange={(open) => !open && setOpenNote(null)}
          onDownload={(note) => props.files?.download(note.id)}
          onRetry={(note) => props.files?.retry(note.id)}
          onRemove={(note) => {
            setOpenNote(null)
            props.notes.remove([note.id])
          }}
          {...(openNote?.page !== undefined ? { focusPage: openNote.page } : {})}
          {...(query.trim() ? { terms: searchTerms(query) } : focusTerms.length > 0 ? { terms: focusTerms } : {})}
        />
      )}
      {detailNote && detailNote.kind !== "file" && (
        <NoteDialog
          note={detailNote}
          workspaceId={workspace.id}
          onOpenChange={(open) => !open && setOpenNote(null)}
          onUpdate={(note, patch) => props.notes.update(note.id, patch)}
          onSaveText={(note, text) => props.notes.saveText(note.id, text)}
          onDelete={(note) => {
            setOpenNote(null)
            props.notes.remove([note.id])
          }}
          {...(openNote?.turn !== undefined ? { focusTurn: openNote.turn, terms: query.trim() ? searchTerms(query) : focusTerms } : {})}
        />
      )}
      <LaunchConfirmDialog request={launcher.confirming} onConfirm={() => void launcher.confirm()} onCancel={launcher.cancel} />
    </section>
  )
}

/** The project's name, edited where it is shown: Enter keeps it, Escape (or an empty name) changes nothing. */
function RenameTitle({ name, onDone }: { name: string; onDone: (name: string | undefined) => void }) {
  const [draft, setDraft] = useState(name)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onDone(draft.trim() || undefined)
      }}
    >
      <Input
        autoFocus
        aria-label="Project name"
        value={draft}
        maxLength={80}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onDone(draft.trim() || undefined)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onDone(undefined)
          }
        }}
        className="h-10 w-[min(32rem,80vw)] text-statement"
      />
    </form>
  )
}

/**
 * A project with things in it but no AI conversation yet: one quiet line
 * with the ways to bring one in — Hubble for Chrome, or an export file.
 */
function CaptureInvite({ onCapture }: { onCapture: ProjectHomeProps["onCapture"] }) {
  return (
    <SaveFromAiInvite>
      <Button type="button" size="xs" variant="ghost" onClick={() => onCapture("import")}>
        <FileInput /> Import
      </Button>
    </SaveFromAiInvite>
  )
}

/** Search words marked in a snippet — as text, never markup. */
export function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {markMatches(text, terms).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-xs bg-surface-active px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  )
}

let seekNonce = 0

function SearchResults({
  hits,
  terms,
  titleOf,
  tabOf,
  noteOf,
  onOpen,
  onOpenNote,
  onOpenAt,
  working,
}: {
  hits: ReturnType<typeof searchProject>
  terms: readonly string[]
  titleOf: (tabId: string) => string | undefined
  tabOf: (tabId: string) => Tab | undefined
  noteOf: (noteId: string) => ProjectNote | undefined
  onOpen: (tabId: string, seek?: TranscriptSeek, turn?: number) => void
  onOpenNote: (noteId: string, turn?: number, page?: number) => void
  onOpenAt?: (tab: Tab, url: string) => void
  /** Items still being read: their content can't be searched yet. */
  working: number
}) {
  const stillReading = working > 0 && (
    <p className="text-meta text-tertiary">
      Still reading {working === 1 ? "1 item" : `${working} items`}.
    </p>
  )
  if (hits.length === 0)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-body-sm text-muted-foreground">Nothing in this project mentions that.</p>
        {stillReading}
      </div>
    )
  return (
    <div className="flex flex-col gap-1.5">
      {stillReading}
      <ul className="flex flex-col divide-y divide-subtle rounded-md border border-subtle" aria-label="Search results">
        {hits.map((hit, index) => {
          const location = hit.location
          const turn = location.kind === "turn" ? location.turn : undefined
          if (hit.type === "note") {
            const note = noteOf(hit.noteId)
            if (!note) return null
            const where = describeLocation(location)
            const page = location.kind === "page" ? location.page : undefined
            const NoteIcon = note.kind === "file" ? FileText : NotebookPen
            return (
              <li key={`n-${hit.noteId}-${index}`} className="flex items-start gap-1 pr-2 hover:bg-surface-hover" data-search-hit={location.kind}>
                <button type="button" className="flex min-w-0 flex-1 items-start gap-2 p-2 text-left focus-visible:bg-surface-hover focus-visible:outline-none" onClick={() => onOpenNote(note.id, turn, page)}>
                  <NoteIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm text-foreground">
                      {note.title}
                      {where && <span className="text-tertiary"> — {where}</span>}
                    </span>
                    <span className="block text-meta text-muted-foreground">
                      <Highlighted text={hit.snippet} terms={terms} />
                    </span>
                  </span>
                  {note.provider ? <ProviderBadge provider={note.provider} className="mt-0.5" /> : null}
                </button>
              </li>
            )
          }
          const tab = tabOf(hit.tabId)
          const kind = tab?.resource?.kind
          const moment = location.kind === "transcript" ? location : undefined
          const at = moment?.start
          const video = at !== undefined && tab ? parseYouTubeUrl(tab.url) : undefined
          const where = moment ? undefined : describeLocation(location)
          const provider = tab?.resource?.meta?.provider
          return (
            <li key={`s-${hit.tabId}-${index}`} className="flex items-start gap-1 pr-2 hover:bg-surface-hover" data-search-hit={location.kind}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start gap-2 p-2 text-left focus-visible:bg-surface-hover focus-visible:outline-none"
                onClick={() => (tab?.resource ? onOpen(hit.tabId, moment ? { line: moment.line, ...(at !== undefined ? { seconds: at } : {}), nonce: ++seekNonce } : undefined, turn) : tab && onOpenAt?.(tab, tab.url))}
              >
                {kind && <SourceKindIcon kind={kind} className="mt-0.5" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm text-foreground">
                    {titleOf(hit.tabId)}
                    {where && <span className="text-tertiary"> — {where}</span>}
                    {!tab?.resource && <span className="text-tertiary"> — saved tab</span>}
                  </span>
                  <span className="block text-meta text-muted-foreground">
                    {at !== undefined && <span className="mr-1.5 text-tertiary tabular-nums">{formatTimestamp(at)}</span>}
                    <Highlighted text={hit.snippet} terms={terms} />
                  </span>
                </span>
                {provider ? <ProviderBadge provider={provider} className="mt-0.5" /> : null}
              </button>
              {video && tab && onOpenAt && at !== undefined && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="mt-1.5 shrink-0"
                  aria-label={`Watch ${titleOf(hit.tabId) ?? "the video"} on YouTube from ${formatTimestamp(at)}`}
                  onClick={() => onOpenAt(tab, youtubeMomentUrl(video.videoId, at))}
                >
                  <Play /> {formatTimestamp(at)}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function BriefForm({ description, focus, onSave, onCancel }: { description: string; focus: string; onSave: (brief: { description: string; focus: string }) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState({ description, focus })
  function submit(event: FormEvent) {
    event.preventDefault()
    onSave(draft)
  }
  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2 rounded-md border border-subtle p-3" aria-label="Project details">
      <label className="text-meta text-muted-foreground">
        What is it about?
        <Textarea className="mt-1 min-h-14 text-body-sm" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={280} />
      </label>
      <label className="text-meta text-muted-foreground">
        Current goal
        <Input className="mt-1" value={draft.focus} onChange={(event) => setDraft({ ...draft, focus: event.target.value })} maxLength={160} />
      </label>
      <p className="text-meta text-tertiary">Included when you use this project in an AI chat.</p>
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

/** An address with its escapes decoded — or as it is, when they are malformed. */
function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
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
 * The page around an empty project: the way back to Projects, the project's
 * menu, and the drawer button the sidebar needs below `md`. A project with
 * saved tabs uses the workspace view's own bar instead.
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
      <header className="sticky top-0 z-(--hb-z-sticky) flex h-12 items-center gap-2 border-b border-subtle bg-[color-mix(in_oklab,var(--background)_82%,transparent)] px-4 backdrop-blur-md">
        {onOpenSidebar && (
          <Button type="button" size="icon-sm" variant="ghost" className="md:hidden" aria-label="Open sidebar" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </Button>
        )}
        {onBack ? (
          <nav aria-label="Breadcrumb" className="mr-auto flex min-w-0 items-center gap-1 text-body-sm">
            <Button type="button" variant="ghost" size="sm" className="-ml-1.5" onClick={onBack}>
              <ChevronLeft /> Home
            </Button>
            <span aria-hidden className="text-tertiary">/</span>
            <span className="truncate px-1 text-foreground" aria-current="page">
              {subjectName(workspace)}
            </span>
          </nav>
        ) : (
          <span className="mr-auto truncate text-h2 text-foreground">{subjectName(workspace)}</span>
        )}
        {subjectMenu && <SubjectActionsMenu workspace={workspace} subjectMenu={subjectMenu} />}
      </header>
      <main className="mx-auto w-full max-w-(--tabdump-content-max-width) px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
