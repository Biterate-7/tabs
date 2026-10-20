"use client"

import { useMemo, useState } from "react"
import { ArrowUpRight, ChevronDown, ExternalLink, MessageSquareShare, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { KindGlyph, KIND_BG_CLASS, KIND_TEXT_CLASS } from "@/components/ui/kind-glyph"
import { PageHeader } from "@/components/ui/page-header"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProviderBadge, ProviderMark } from "@/components/memory/provider-mark"
import { FILE_FORMAT_LABEL, formatBytes } from "@/lib/files/formats"
import { KNOWLEDGE_TYPE_LABEL, knowledgeItemsOf } from "@/lib/memory/items"
import { ITEM_KIND_PLURAL, itemKind } from "@/lib/memory/kinds"
import { aiProviderName } from "@/lib/providers/registry"
import { subjectName } from "@/lib/product/subjects"
import { sourceKey } from "@/lib/resources/url"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { ItemKind } from "@/lib/memory/kinds"
import type { AiProviderId } from "@/lib/providers/registry"
import type { Workspace } from "@/lib/workspace/types"

export type LibraryTab = "all" | ItemKind

const TABS: readonly LibraryTab[] = ["all", "conversation", "file", "source", "note"]
const TAB_LABEL: Record<LibraryTab, string> = { all: "All", ...ITEM_KIND_PLURAL }

const CAPTURE_LABEL = { page: "Saved from the page", export: "Imported from an export", paste: "Pasted" } as const

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

type Entry = { item: KnowledgeItem; workspace: Workspace; kind: ItemKind; key?: string }

function dayGroup(at: number, now: number): string {
  const day = 86_400_000
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (at >= startOfToday) return "Today"
  if (at >= startOfToday - day) return "Yesterday"
  if (at >= startOfToday - 6 * day) return "This week"
  if (at >= startOfToday - 30 * day) return "This month"
  return "Earlier"
}

/**
 * The Library: every conversation, file, source and note across projects,
 * in one place — the way back to a thing when you remember the thing but
 * not where you put it.
 *
 * Conversations from one AI app are separate entries when they are separate
 * conversations; the same conversation saved into two projects is one
 * conversation shown twice, and each copy says "Also in …" — the same
 * identity (`sourceKey`) that decides what counts as a duplicate when saving.
 * Every row opens the item's own reader in its project.
 */
export function LibraryView({
  workspaces,
  now,
  initialTab = "all",
  onOpenItem,
  onUseInAi,
  onOpenUrl,
  onOpenSidebar,
}: {
  workspaces: readonly Workspace[]
  now: number
  initialTab?: LibraryTab
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef) => void
  onUseInAi?: (workspaceId: string, refs: KnowledgeItemRef[]) => void
  onOpenUrl: (url: string) => void
  onOpenSidebar?: () => void
}) {
  const [tab, setTab] = useState<LibraryTab>(initialTab)
  const [query, setQuery] = useState("")
  const [project, setProject] = useState<string>("all")
  const [provider, setProvider] = useState<AiProviderId | "all">("all")

  const entries = useMemo(() => {
    const all: Entry[] = []
    for (const workspace of workspaces) {
      for (const item of knowledgeItemsOf(workspace)) {
        const key = item.url && item.type !== "excerpt" ? sourceKey(item.url) : undefined
        all.push({ item, workspace, kind: itemKind(item), ...(key ? { key } : {}) })
      }
    }
    return all.sort((a, b) => b.item.addedAt - a.item.addedAt)
  }, [workspaces])

  // Which projects hold each source: "Also in …".
  const holders = useMemo(() => {
    const map = new Map<string, Workspace[]>()
    for (const entry of entries) if (entry.key) map.set(entry.key, [...(map.get(entry.key) ?? []), entry.workspace])
    return map
  }, [entries])

  const counts = useMemo(() => {
    const out: Record<LibraryTab, number> = { all: 0, conversation: 0, file: 0, source: 0, note: 0 }
    for (const entry of entries) {
      if (project !== "all" && entry.workspace.id !== project) continue
      out.all += 1
      out[entry.kind] += 1
    }
    return out
  }, [entries, project])

  const providers = useMemo(() => [...new Set(entries.filter((entry) => entry.kind === "conversation" && entry.item.provider).map((entry) => entry.item.provider!))], [entries])

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = entries.filter((entry) => {
    if (tab !== "all" && entry.kind !== tab) return false
    if (project !== "all" && entry.workspace.id !== project) return false
    if (provider !== "all" && entry.item.provider !== provider) return false
    if (terms.length === 0) return true
    const haystack = [entry.item.title, entry.item.domain, entry.item.fileName, entry.item.provider ? aiProviderName(entry.item.provider) : "", subjectName(entry.workspace), ...(entry.item.tags ?? [])].join(" ").toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })

  const groups: { label: string; entries: Entry[] }[] = []
  for (const entry of shown) {
    const label = dayGroup(entry.item.addedAt, now)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }

  const projectLabel = project === "all" ? "All projects" : (workspaces.find((workspace) => workspace.id === project)?.name ?? "Project")

  return (
    <div className="min-h-screen" data-library>
      <PageHeader title="Library" {...(onOpenSidebar ? { onOpenSidebar } : {})}>
        <div className="flex gap-1 overflow-x-auto px-3 pb-2 sm:px-4" role="tablist" aria-label="Show">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-body-sm outline-none transition-[background-color,color] duration-(--duration-fast) ease-(--ease-color) focus-visible:ring-2 focus-visible:ring-ring/60",
                tab === id ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              )}
            >
              {id !== "all" && <span aria-hidden className={cn("size-1.5 rounded-full", KIND_BG_CLASS[id])} />}
              {TAB_LABEL[id]}
              <span className="text-meta text-tertiary tabular-nums">{counts[id]}</span>
            </button>
          ))}
        </div>
      </PageHeader>

      <main className="mx-auto w-full max-w-[1120px] px-4 pt-6 pb-16 sm:px-8">
        <h1 className="sr-only">Library</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 sm:max-w-sm">
            <span className="sr-only">Find in the library</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find by name, site, AI app or project" className="h-8 pl-8" />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="secondary" size="lg" className="max-w-56" aria-label="Choose project">
                  <span className="truncate">{projectLabel}</span>
                  <ChevronDown className="opacity-60" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="max-h-80 min-w-52">
              <DropdownMenuRadioGroup value={project} onValueChange={(value) => setProject(String(value))}>
                <DropdownMenuRadioItem value="all">All projects</DropdownMenuRadioItem>
                {workspaces.map((workspace) => (
                  <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
                    {subjectName(workspace)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {(tab === "conversation" || tab === "all") && providers.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-md border border-subtle p-0.5" role="group" aria-label="AI app">
              <button type="button" aria-pressed={provider === "all"} onClick={() => setProvider("all")} className={cn("h-6 rounded-sm px-2 text-body-sm", provider === "all" ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:text-foreground")}>
                Any app
              </button>
              {providers.map((id) => (
                <button key={id} type="button" aria-pressed={provider === id} aria-label={aiProviderName(id)} title={aiProviderName(id)} onClick={() => setProvider(id)} className={cn("grid h-6 w-7 place-items-center rounded-sm", provider === id ? "bg-surface-selected" : "opacity-60 hover:opacity-100")}>
                  <ProviderMark provider={id} size={14} />
                </button>
              ))}
            </div>
          )}
        </div>

        {shown.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-2 text-center animate-fade">
            {tab !== "all" && <KindGlyph kind={tab} tile className="size-10" />}
            <p className="text-body text-foreground">{entries.length === 0 ? "Nothing saved yet" : terms.length > 0 ? "Nothing matches that" : `No ${TAB_LABEL[tab].toLowerCase()} here yet`}</p>
            <p className="max-w-sm text-body-sm text-muted-foreground">
              {tab === "conversation"
                ? "Save a conversation from ChatGPT, Claude, Gemini or Perplexity with Hubble for Chrome, or import an export in a project."
                : tab === "file"
                  ? "Upload PDFs, Word documents or Markdown into a project to read and search them here."
                  : "Everything you save into projects appears here."}
            </p>
          </div>
        ) : tab === "file" ? (
          <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Files">
            {shown.map((entry, index) => (
              <li key={`${entry.workspace.id}:${entry.item.id}`} className="animate-rise" style={{ ["--stagger" as string]: index }}>
                <FileTile entry={entry} now={now} onOpen={() => onOpenItem(entry.workspace.id, entry.item.ref)} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h2 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">{group.label}</h2>
                <ul className="mt-1 flex flex-col">
                  {group.entries.map((entry) => (
                    <li key={`${entry.workspace.id}:${entry.item.id}`}>
                      <LibraryRow
                        entry={entry}
                        now={now}
                        also={entry.key ? (holders.get(entry.key) ?? []).filter((workspace) => workspace.id !== entry.workspace.id) : []}
                        onOpen={() => onOpenItem(entry.workspace.id, entry.item.ref)}
                        {...(onUseInAi ? { onUseInAi: () => onUseInAi(entry.workspace.id, [entry.item.ref]) } : {})}
                        onOpenUrl={onOpenUrl}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function LibraryRow({ entry, now, also, onOpen, onUseInAi, onOpenUrl }: { entry: Entry; now: number; also: readonly Workspace[]; onOpen: () => void; onUseInAi?: () => void; onOpenUrl: (url: string) => void }) {
  const { item, workspace, kind } = entry
  const facts = [
    kind === "conversation" && item.capture ? CAPTURE_LABEL[item.capture] : undefined,
    item.turns ? plural(item.turns, "turn", "turns") : undefined,
    item.pages ? plural(item.pages, "page", "pages") : undefined,
    kind === "source" && item.domain ? item.domain : undefined,
    item.status === "failed" ? "Couldn't read" : !item.hasText && kind !== "note" ? "Link only" : undefined,
  ].filter(Boolean)
  return (
    <div className="group flex items-center gap-1 rounded-md pr-1 transition-[background-color] duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        <KindGlyph kind={kind} type={item.type} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-foreground">{item.title}</span>
          <span className="block truncate text-meta text-tertiary">
            {[subjectName(workspace), ...facts].join(" · ")}
            {also.length > 0 && <span className="text-muted-foreground"> · Also in {also.map(subjectName).join(", ")}</span>}
          </span>
        </span>
        <span className="flex w-28 shrink-0 justify-end max-sm:hidden">{item.provider ? <ProviderBadge provider={item.provider} /> : <span className={cn("text-meta", KIND_TEXT_CLASS[kind])}>{KNOWLEDGE_TYPE_LABEL[item.type]}</span>}</span>
        <span className="w-20 shrink-0 text-right text-meta text-tertiary max-md:hidden">{formatRelativeTime(item.addedAt, now)}</span>
      </button>
      {item.url && kind === "conversation" && (
        <IconButton aria-label={`Continue in ${item.provider ? aiProviderName(item.provider) : "the AI app"}`} tooltip={`Continue in ${item.provider ? aiProviderName(item.provider) : "the AI app"}`} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:hidden" onClick={() => onOpenUrl(item.url!)}>
          <ExternalLink />
        </IconButton>
      )}
      {onUseInAi && (
        <IconButton aria-label={`Use ${item.title} in AI`} tooltip="Use in AI" className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:hidden" onClick={onUseInAi}>
          <MessageSquareShare />
        </IconButton>
      )}
    </div>
  )
}

/** A file as a document: its format, name and size, and where it lives. Opening it shows the original, drawn page by page. */
function FileTile({ entry, now, onOpen }: { entry: Entry; now: number; onOpen: () => void }) {
  const { item, workspace } = entry
  const note = workspace.notes?.find((candidate) => candidate.id === item.id)
  const file = note?.file
  const format = file ? FILE_FORMAT_LABEL[file.format] : KNOWLEDGE_TYPE_LABEL[item.type]
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${item.title}`}
      className="group flex w-full flex-col overflow-hidden rounded-lg border border-subtle bg-card text-left outline-none transition-[border-color,box-shadow,transform] duration-(--duration-fast) ease-(--ease-standard) hover:-translate-y-px hover:border-strong hover:shadow-(--shadow-panel) focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {/* The page: a sheet with the format on it — the reader shows the real thing. */}
      <span className="relative flex h-28 items-end justify-center overflow-hidden bg-background-tertiary">
        <span className="relative h-24 w-[4.5rem] translate-y-3 rounded-t-sm border border-b-0 border-subtle bg-background shadow-(--shadow-sm) transition-transform duration-(--duration-base) ease-(--ease-standard) group-hover:translate-y-2">
          <span className="absolute top-0 right-0 size-3.5 rounded-bl-sm border-b border-l border-subtle bg-background-tertiary" />
          <span className="absolute top-4 left-2 right-4 flex flex-col gap-1">
            <span className="h-0.5 w-full rounded-full bg-surface-active" />
            <span className="h-0.5 w-4/5 rounded-full bg-surface-active" />
            <span className="h-0.5 w-full rounded-full bg-surface-active" />
            <span className="h-0.5 w-3/5 rounded-full bg-surface-active" />
          </span>
          <span className="absolute bottom-2 left-2 rounded-xs bg-kind-file/15 px-1 text-[9px] font-medium tracking-wide text-kind-file uppercase">{format}</span>
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
        <span className="truncate text-body text-foreground">{item.title}</span>
        <span className="truncate text-meta text-tertiary">
          {[file?.pages ? plural(file.pages, "page", "pages") : undefined, file ? formatBytes(file.size) : undefined, formatRelativeTime(item.addedAt, now)].filter(Boolean).join(" · ")}
        </span>
        <span className="flex items-center gap-1 truncate text-meta text-muted-foreground">
          {subjectName(workspace)}
          {file && file.status !== "ready" && <span className="text-warning"> · {file.status === "processing" ? "Reading…" : file.status === "partial" ? "Kept without text" : "Couldn't read"}</span>}
          <ArrowUpRight aria-hidden className="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
      </span>
    </button>
  )
}
