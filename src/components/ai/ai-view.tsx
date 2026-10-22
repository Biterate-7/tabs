"use client"

import { useMemo, useState } from "react"
import { ArrowUpRight, Check, Download, ExternalLink, MessageSquareShare, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { ItemIcon } from "@/components/memory/item-icon"
import { PageHeader } from "@/components/ui/page-header"
import { ProviderMark } from "@/components/memory/provider-mark"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { useBrowserConnected } from "@/hooks/use-tab-sessions"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { knowledgeItemsOf } from "@/lib/memory/items"
import { AI_PROVIDER_IDS, AI_PROVIDERS, aiProviderName } from "@/lib/providers/registry"
import { subjectName, subjectUpdatedAt } from "@/lib/product/subjects"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { AiProviderId, ProviderCapability } from "@/lib/providers/registry"
import type { Workspace } from "@/lib/workspace/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const CAPABILITY_ROWS: { key: "pageCapture" | "insert" | "attachFiles" | "exportImport"; label: string }[] = [
  { key: "pageCapture", label: "Save from the page" },
  { key: "insert", label: "Bring in context" },
  { key: "attachFiles", label: "Attach files" },
  { key: "exportImport", label: "Import an export" },
]

/**
 * AI: where saved work goes back out. Hubble does not run a chat of its own —
 * it brings a project's context into the AI app the person already uses, and
 * brings the answers back.
 *
 *     Use your work in any AI             ● Hubble for Chrome connected
 *     [ChatGPT] [Claude] [Gemini] [Perplexity]   ← choose where it goes
 *     Start with a project …   [Use in ChatGPT]
 *     Pick up a conversation …  [Continue in Claude ↗] [Read]
 *     Bring answers back …
 *
 * What each app supports comes from the provider registry — the one place
 * capability claims live — and the connection line says plainly what happens
 * without the extension (copy, then paste). Nothing here claims an app
 * received anything: the Use in AI dialog reports that, after checking.
 */
export function AiView({
  workspaces,
  now,
  onUseInAi,
  onOpenItem,
  onOpenUrl,
  onSaveFromAi,
  onOpenAiApps,
  onOpenSidebar,
}: {
  workspaces: readonly Workspace[]
  now: number
  onUseInAi: (workspaceId: string, refs: KnowledgeItemRef[], provider: AiProviderId) => void
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef) => void
  onOpenUrl: (url: string) => void
  /** How to save conversations with Hubble for Chrome. */
  onSaveFromAi: () => void
  /** Settings → AI apps: the full capability matrix. */
  onOpenAiApps?: () => void
  onOpenSidebar?: () => void
}) {
  const connected = useBrowserConnected()
  const isDesktop = useIsDesktop()
  const [provider, setProvider] = useState<AiProviderId>("chatgpt")

  const projects = useMemo(
    () =>
      [...workspaces]
        .map((workspace) => ({ workspace, items: knowledgeItemsOf(workspace) }))
        .filter((entry) => entry.items.length > 0)
        .sort((a, b) => subjectUpdatedAt(b.workspace) - subjectUpdatedAt(a.workspace)),
    [workspaces]
  )
  const conversations = useMemo(() => {
    const all: { workspace: Workspace; item: KnowledgeItem }[] = []
    for (const { workspace, items } of projects) for (const item of items) if (item.type === "conversation") all.push({ workspace, item })
    return all.sort((a, b) => Math.max(b.item.addedAt, b.item.updatedAt) - Math.max(a.item.addedAt, a.item.updatedAt))
  }, [projects])
  const savedBy = useMemo(() => {
    const counts = new Map<AiProviderId, number>()
    for (const { item } of conversations) if (item.provider) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1)
    return counts
  }, [conversations])

  const chosen = AI_PROVIDERS[provider]

  return (
    <div className="min-h-screen" data-ai-view>
      <PageHeader title="AI" {...(onOpenSidebar ? { onOpenSidebar } : {})} />
      <main className="mx-auto w-full max-w-[1120px] px-4 pt-8 pb-16 sm:px-8 sm:pt-12">
        <div className="flex flex-wrap items-end justify-between gap-4 animate-enter">
          <div className="max-w-xl">
            <h1 className="text-display text-foreground">Use your work in any AI</h1>
            <p className="mt-2 text-body text-muted-foreground">Choose an app, then the project or items to bring. Hubble puts them into a new chat for you — and saves the conversation back when you ask.</p>
          </div>
          <ConnectionLine connected={connected} desktop={isDesktop} />
        </div>

        {/* Where it goes. */}
        <div role="radiogroup" aria-label="AI app" className="mt-8 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {AI_PROVIDER_IDS.map((id) => {
            const selected = provider === id
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setProvider(id)}
                className={cn(
                  "group relative flex flex-col gap-3 rounded-lg border bg-card p-4 text-left outline-none transition-[border-color,background-color,box-shadow] duration-(--duration-fast) ease-(--ease-color) focus-visible:ring-2 focus-visible:ring-ring/60",
                  selected ? "border-strong shadow-(--shadow-panel)" : "border-subtle hover:border-strong"
                )}
              >
                <span className="flex items-center gap-2.5">
                  <ProviderMark provider={id} size={20} />
                  <span className="text-h2 text-foreground">{aiProviderName(id)}</span>
                  <span aria-hidden className={cn("ml-auto grid size-4 place-items-center rounded-full border transition-colors", selected ? "border-link bg-link" : "border-strong")}>
                    {selected && <span className="size-1.5 rounded-full bg-background" />}
                  </span>
                </span>
                <span className="text-meta text-tertiary">{savedBy.get(id) ? `${plural(savedBy.get(id)!, "conversation", "conversations")} saved` : "None saved yet"}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-10">
            <section aria-labelledby="ai-projects">
              <Heading id="ai-projects">Start with a project</Heading>
              {projects.length === 0 ? (
                <p className="mt-3 text-body-sm text-muted-foreground">Save something into a project first — a conversation, a page or a file — and it can come along to any AI.</p>
              ) : (
                <ul className="mt-2 flex flex-col">
                  {projects.map(({ workspace, items }, index) => {
                    const conversationCount = items.filter((item) => item.type === "conversation").length
                    return (
                      <li key={workspace.id} className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-hover animate-rise" style={{ ["--stagger" as string]: index }}>
                        <WorkspaceAvatar workspace={workspace} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body text-foreground">{subjectName(workspace)}</span>
                          <span className="block truncate text-meta text-tertiary">
                            {plural(items.length, "item", "items")}
                            {conversationCount > 0 ? ` · ${plural(conversationCount, "conversation", "conversations")}` : ""}
                            {workspace.brief?.focus ? ` · ${workspace.brief.focus}` : ""}
                          </span>
                        </span>
                        <Button type="button" variant="secondary" onClick={() => onUseInAi(workspace.id, [], provider)}>
                          <MessageSquareShare /> Use in {aiProviderName(provider)}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section aria-labelledby="ai-conversations">
              <Heading id="ai-conversations">Pick up a conversation</Heading>
              {conversations.length === 0 ? (
                <p className="mt-3 text-body-sm text-muted-foreground">Conversations you save from {AI_PROVIDER_IDS.map(aiProviderName).join(", ")} appear here, ready to continue.</p>
              ) : (
                <ul className="mt-2 flex flex-col">
                  {conversations.slice(0, 10).map(({ workspace, item }) => (
                    <li key={`${workspace.id}:${item.id}`} className="group flex items-center gap-1 rounded-md pr-1 hover:bg-surface-hover">
                      <button type="button" onClick={() => onOpenItem(workspace.id, item.ref)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                        <ItemIcon item={item} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body text-foreground">{item.title}</span>
                          <span className="block truncate text-meta text-tertiary">
                            {subjectName(workspace)}
                            {item.turns ? ` · ${plural(item.turns, "turn", "turns")}` : ""} · {formatRelativeTime(Math.max(item.addedAt, item.updatedAt), now)}
                          </span>
                        </span>
                      </button>
                      {item.url && item.provider && (
                        <Button type="button" size="sm" variant="ghost" className="max-sm:hidden" onClick={() => onOpenUrl(item.url!)} aria-label={`Continue ${item.title} in ${aiProviderName(item.provider)}`}>
                          Continue in {aiProviderName(item.provider)} <ExternalLink />
                        </Button>
                      )}
                      <IconButton aria-label={`Use ${item.title} in ${aiProviderName(provider)}`} tooltip={`Use in ${aiProviderName(provider)}`} onClick={() => onUseInAi(workspace.id, [item.ref], provider)}>
                        <MessageSquareShare />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <aside className="flex min-w-0 flex-col gap-10" aria-label={`${chosen.name} in Hubble`}>
            <section aria-labelledby="ai-capabilities">
              <Heading id="ai-capabilities" action={onOpenAiApps ? { label: "Details", onClick: onOpenAiApps } : undefined}>
                {chosen.name} with Hubble
              </Heading>
              <ul className="mt-2 flex flex-col">
                {CAPABILITY_ROWS.map(({ key, label }) => (
                  <CapabilityRow key={key} label={label} capability={chosen.capabilities[key]} />
                ))}
              </ul>
              <Button type="button" variant="ghost" size="sm" className="mt-2 -ml-1" onClick={() => onOpenUrl(chosen.homeUrl)}>
                New {chosen.name} chat <ArrowUpRight />
              </Button>
            </section>

            <section aria-labelledby="ai-back">
              <Heading id="ai-back">Bring answers back</Heading>
              <p className="mt-3 text-body-sm text-muted-foreground">When a conversation is worth keeping, save it from the page with Hubble for Chrome — into the project it belongs to. Saving again updates it rather than adding a copy.</p>
              <Button type="button" variant="secondary" className="mt-3" onClick={onSaveFromAi}>
                <Download /> How to save a conversation
              </Button>
            </section>
          </aside>
        </div>
      </main>
    </div>
  )
}

function ConnectionLine({ connected, desktop }: { connected: boolean; desktop: boolean }) {
  return (
    <p className="flex items-center gap-2 rounded-full border border-subtle bg-card px-3 py-1.5 text-meta text-muted-foreground" role="status">
      <span aria-hidden className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-strong")} />
      {connected ? "Hubble for Chrome connected — context goes straight into a new chat" : desktop ? "In Hubble Desktop, Hubble copies the context and opens the app for you to paste" : "Without Hubble for Chrome, Hubble copies the context and opens the app for you to paste"}
    </p>
  )
}

function CapabilityRow({ label, capability }: { label: string; capability: ProviderCapability }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5" title={capability.note}>
      {capability.supported ? <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" /> : <Minus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tertiary" />}
      <span className="min-w-0 flex-1">
        <span className={cn("block text-body-sm", capability.supported ? "text-foreground" : "text-tertiary")}>
          {label}
          <span className="sr-only">: {capability.supported ? "supported" : "not available"}</span>
        </span>
        <span className="line-clamp-2 text-meta text-tertiary">{capability.note}</span>
      </span>
    </li>
  )
}

function Heading({ id, children, action }: { id: string; children: React.ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-subtle pb-2">
      <h2 id={id} className="text-eyebrow text-tertiary">
        {children}
      </h2>
      {action && (
        <button type="button" onClick={action.onClick} className="text-meta text-tertiary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
          {action.label}
        </button>
      )}
    </div>
  )
}
