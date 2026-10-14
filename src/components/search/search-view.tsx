"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { ExternalLink, MessageSquareShare, PanelLeftOpen, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Highlighted } from "@/components/project/project-home"
import { ProviderBadge } from "@/components/memory/provider-mark"
import { useMemoryActions } from "@/components/memory/memory-actions"
import { useProjectContents } from "@/hooks/use-project-contents"
import { searchKnowledge } from "@/lib/memory/search"
import { KNOWLEDGE_TYPE_LABEL } from "@/lib/memory/items"
import { AI_PROVIDERS, AI_PROVIDER_IDS } from "@/lib/providers/registry"
import { describeLocation, searchTerms } from "@/lib/resources/search"
import { formatTimestamp } from "@/lib/resources/transcript"
import { subjectName } from "@/lib/product/subjects"
import { cn } from "@/lib/utils"
import type { KnowledgeHit } from "@/lib/memory/search"
import type { KnowledgeItemRef, KnowledgeItemType } from "@/lib/memory/items"
import type { AiProviderId } from "@/lib/providers/registry"
import type { Workspace } from "@/lib/workspace/types"

type TypeFilter = "all" | "conversations" | "sources" | "notes"

const TYPE_FILTERS: { id: TypeFilter; label: string; types?: KnowledgeItemType[] }[] = [
  { id: "all", label: "Everything" },
  { id: "conversations", label: "AI conversations", types: ["conversation"] },
  { id: "sources", label: "Sources", types: ["webpage", "pdf", "video", "document", "link"] },
  { id: "notes", label: "Notes", types: ["note", "excerpt"] },
]

const ALL_PROJECTS = "all"

/**
 * Search your knowledge: everything saved in every project — or one —
 * whichever AI app it came from.
 *
 * Runs on this device over the projects' own content (lib/memory/search.ts);
 * each project is searched on its own and the results merged, so a result
 * always names the project it is in. A result opens the item where it
 * matched (the turn of a conversation, the page of a PDF), and can be used
 * in an AI chat from here.
 */
export function SearchView({
  workspaces,
  initialQuery = "",
  initialWorkspaceId,
  onOpenItem,
  onOpenUrl,
  onOpenSidebar,
}: {
  workspaces: readonly Workspace[]
  initialQuery?: string
  /** Start scoped to this project. */
  initialWorkspaceId?: string
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef, turn?: number) => void
  onOpenUrl: (url: string) => void
  onOpenSidebar?: () => void
}) {
  const memory = useMemoryActions()
  const [query, setQuery] = useState(initialQuery)
  const [scope, setScope] = useState(initialWorkspaceId ?? ALL_PROJECTS)
  const [providers, setProviders] = useState<ReadonlySet<AiProviderId>>(new Set())
  const [type, setType] = useState<TypeFilter>("all")
  const deferred = useDeferredValue(query)
  const searching = searchTerms(deferred).length > 0

  const inScope = useMemo(() => (scope === ALL_PROJECTS ? workspaces : workspaces.filter((workspace) => workspace.id === scope)), [scope, workspaces])
  const contents = useProjectContents(useMemo(() => (searching ? inScope : []), [searching, inScope]))
  const loading = searching && inScope.some((workspace) => !contents.has(workspace.id))
  const hits = useMemo(
    () =>
      searching
        ? searchKnowledge({
            query: deferred,
            workspaces: inScope,
            contents,
            providers: [...providers],
            ...(TYPE_FILTERS.find((entry) => entry.id === type)?.types ? { types: TYPE_FILTERS.find((entry) => entry.id === type)!.types! } : {}),
            limit: 60,
          })
        : [],
    [searching, deferred, inScope, contents, providers, type]
  )
  const terms = searchTerms(deferred)
  const nameOf = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, subjectName(workspace)])), [workspaces])
  const reading = inScope.reduce((sum, workspace) => sum + workspace.tabs.filter((tab) => tab.resource?.status === "pending" || tab.resource?.status === "processing").length, 0)

  function toggleProvider(id: AiProviderId) {
    setProviders((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const scopeOptions = [{ value: ALL_PROJECTS, label: "All projects" }, ...workspaces.map((workspace) => ({ value: workspace.id, label: subjectName(workspace) }))]

  return (
    <div className="min-h-screen" data-search-view>
      <header className="flex h-12 items-center gap-2 border-b border-subtle px-4">
        {onOpenSidebar && (
          <IconButton aria-label="Open sidebar" className="md:hidden" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </IconButton>
        )}
        <p className="text-h2 text-foreground">Search your knowledge</p>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
        <label className="relative">
          <span className="sr-only">Search conversations, notes and saved pages</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary" />
          <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="What did you learn about…" className="h-10 pl-9 text-body" />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-48">
            <Select value={scope} onValueChange={setScope} options={scopeOptions} />
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Kind">
            {TYPE_FILTERS.map((entry) => (
              <Button key={entry.id} type="button" size="xs" variant={type === entry.id ? "secondary" : "ghost"} aria-pressed={type === entry.id} onClick={() => setType(entry.id)}>
                {entry.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="From AI app">
            {AI_PROVIDER_IDS.map((id) => (
              <Button key={id} type="button" size="xs" variant={providers.has(id) ? "secondary" : "ghost"} aria-pressed={providers.has(id)} onClick={() => toggleProvider(id)}>
                {AI_PROVIDERS[id].name}
              </Button>
            ))}
          </div>
        </div>

        {!searching ? (
          <p className="text-body-sm text-muted-foreground">
            Search what you saved from ChatGPT, Claude, Gemini and Perplexity, your notes, and the pages, PDFs and videos in your projects. It runs on this device.
          </p>
        ) : hits.length === 0 ? (
          <div className="flex flex-col gap-1" role="status">
            <p className="text-body-sm text-muted-foreground">{loading ? "Searching…" : "Nothing you've saved mentions that."}</p>
            {!loading && providers.size > 0 && <p className="text-meta text-tertiary">Only items from {[...providers].map((id) => AI_PROVIDERS[id].name).join(", ")} were searched.</p>}
            {reading > 0 && <p className="text-meta text-tertiary">Hubble is still reading {reading === 1 ? "1 item" : `${reading} items`}; they can be searched once ready.</p>}
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-subtle rounded-md border border-subtle" aria-label="Search results">
            {hits.map((hit) => (
              <SearchHitRow
                key={`${hit.workspaceId}:${hit.ref.kind === "note" ? hit.ref.noteId : hit.ref.tabId}`}
                hit={hit}
                terms={terms}
                projectName={nameOf.get(hit.workspaceId) ?? "a project"}
                onOpen={() => onOpenItem(hit.workspaceId, hit.ref, hit.location.kind === "turn" ? hit.location.turn : undefined)}
                onOpenUrl={onOpenUrl}
                {...(memory ? { onUseInAi: () => memory.reuse({ workspaceId: hit.workspaceId, refs: [hit.ref] }) } : {})}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function SearchHitRow({
  hit,
  terms,
  projectName,
  onOpen,
  onOpenUrl,
  onUseInAi,
}: {
  hit: KnowledgeHit
  terms: readonly string[]
  projectName: string
  onOpen: () => void
  onOpenUrl: (url: string) => void
  onUseInAi?: () => void
}) {
  const item = hit.item
  const title = item?.title ?? hit.tab?.title?.trim() ?? hit.tab?.domain ?? "Untitled"
  const url = item?.url ?? hit.tab?.url
  const where = hit.location.kind === "transcript" ? (hit.location.start !== undefined ? `at ${formatTimestamp(hit.location.start)}` : undefined) : describeLocation(hit.location)
  return (
    <li className="flex items-start gap-1 pr-2 hover:bg-surface-hover" data-search-hit={hit.location.kind} data-search-result-type={item?.type ?? "saved-tab"}>
      <button type="button" className="flex min-w-0 flex-1 flex-col gap-0.5 p-3 text-left focus-visible:bg-surface-hover focus-visible:outline-none" onClick={onOpen}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body text-foreground">{title}</span>
          {where && <span className="shrink-0 text-meta text-tertiary">{where}</span>}
        </span>
        <span className="text-meta text-muted-foreground">
          <Highlighted text={hit.snippet} terms={terms} />
        </span>
        <span className={cn("flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-tertiary")}>
          {item?.provider ? <ProviderBadge provider={item.provider} /> : null}
          <span>{item ? KNOWLEDGE_TYPE_LABEL[item.type] : "Saved tab"}</span>
          <span>· {projectName}</span>
          {hit.more > 0 && <span>· {hit.more} more match{hit.more === 1 ? "" : "es"}</span>}
          {item && !item.hasText && <span>· link only</span>}
        </span>
      </button>
      <div className="mt-2 flex shrink-0 gap-0.5">
        {onUseInAi && (
          <IconButton aria-label={`Use ${title} in an AI chat`} tooltip="Use in AI chat" onClick={onUseInAi}>
            <MessageSquareShare />
          </IconButton>
        )}
        {url && (
          <IconButton aria-label={`Open the original of ${title}`} tooltip="Open the original" onClick={() => onOpenUrl(url)}>
            <ExternalLink />
          </IconButton>
        )}
      </div>
    </li>
  )
}
