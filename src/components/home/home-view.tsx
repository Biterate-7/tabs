"use client"

import { useMemo } from "react"
import { ArrowRight, Group, MessageSquareShare, MessagesSquare, PanelLeftOpen, Plus, Search, Sparkles, Waypoints } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { BrandMark } from "@/components/brand-mark"
import { ProviderBadge } from "@/components/memory/provider-mark"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { greeting, subjectName, subjectUpdatedAt } from "@/lib/product/subjects"
import { KNOWLEDGE_TYPE_LABEL, knowledgeCounts, knowledgeItemsOf } from "@/lib/memory/items"
import { formatRelativeTime } from "@/lib/time-format"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { Workspace } from "@/lib/workspace/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const LOOP = [
  { icon: MessagesSquare, title: "Capture", text: "Save conversations from ChatGPT, Claude, Gemini or Perplexity, plus pages, PDFs and notes." },
  { icon: Waypoints, title: "Connect", text: "Keep them in projects, where related ideas, sources and conversations sit together." },
  { icon: Search, title: "Find", text: "Search everything later, whichever AI app it came from." },
  { icon: MessageSquareShare, title: "Reuse", text: "Bring the parts you choose into your next AI chat, with where they came from." },
] as const

/**
 * Projects: where everything you learn with AI lives.
 *
 *     Good evening
 *     What are you working on?
 *     [+ New project]  [Search]  [Organize open tabs]
 *
 *     History HL · 4 AI conversations · 6 sources     Math AA HL …
 *
 *     Recently saved
 *       ◇ Causes of WW1 — ChatGPT · History HL
 *
 * The first visit says what Hubble is for, in four steps, and offers one
 * button. Nothing here asks for an AI to be connected: Hubble works without
 * any, and is most useful beside the AI apps a person already uses.
 */
export function HomeView({
  subjects,
  firstRun,
  now,
  onOpenSubject,
  onNewSubject,
  onOrganizeOpenTabs,
  onOpenItem,
  onOpenSearch,
  onOpenSidebar,
}: {
  /** The person's projects (workspaces), excluding an untouched default. */
  subjects: readonly Workspace[]
  /** Nothing has ever been made here: say what Hubble is for instead of "no projects". */
  firstRun: boolean
  now: number
  onOpenSubject: (id: string) => void
  onNewSubject: () => void
  /** Smart Organize for the tabs open in Chrome. Omitted where the shell does not offer it. */
  onOrganizeOpenTabs?: () => void
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef) => void
  onOpenSearch?: () => void
  onOpenSidebar?: () => void
}) {
  const recent = useMemo(() => {
    const all: { workspace: Workspace; item: KnowledgeItem }[] = []
    for (const workspace of subjects) for (const item of knowledgeItemsOf(workspace)) all.push({ workspace, item })
    return all.sort((a, b) => b.item.addedAt - a.item.addedAt).slice(0, 8)
  }, [subjects])

  return (
    <div className="min-h-screen" data-home>
      {onOpenSidebar && (
        <header className="flex h-12 items-center px-3 md:hidden">
          <IconButton aria-label="Open sidebar" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </IconButton>
        </header>
      )}
      <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-8 sm:py-20">
        {subjects.length === 0 ? (
          <section aria-label="Get started" className="flex flex-col items-start gap-5 pt-6 sm:pt-12">
            <BrandMark className="size-7 text-foreground" />
            <div>
              <h1 className="text-statement text-foreground">{firstRun ? "Welcome to Hubble" : "Start with a project"}</h1>
              <p className="mt-2 max-w-xl text-body text-muted-foreground">One connected workspace for everything you learn and create with AI.</p>
            </div>
            <ol className="grid w-full gap-2 sm:grid-cols-2" aria-label="How Hubble works">
              {LOOP.map(({ icon: Icon, title, text }, index) => (
                <li key={title} className="flex gap-3 rounded-md border border-subtle bg-card p-3">
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-body-sm text-foreground">
                      <span className="text-tertiary tabular-nums">{index + 1}.</span> {title}
                    </p>
                    <p className="text-meta text-muted-foreground">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <Button type="button" size="lg" onClick={onNewSubject}>
              <Plus /> {firstRun ? "Create your first project" : "New project"}
            </Button>
            <p className="text-meta text-tertiary">No AI connection, API key or sign-in needed. Everything stays in this browser until you choose otherwise.</p>
          </section>
        ) : (
          <>
            <p className="text-body text-muted-foreground">{greeting(new Date(now).getHours())}</p>
            <h1 className="mt-1 text-statement text-foreground">What are you working on?</h1>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button type="button" size="lg" onClick={onNewSubject}>
                <Plus /> New project
              </Button>
              {onOpenSearch && (
                <Button type="button" size="lg" variant="secondary" onClick={onOpenSearch}>
                  <Search /> Search your knowledge
                </Button>
              )}
              {onOrganizeOpenTabs && (
                <Button type="button" size="lg" variant="ghost" onClick={onOrganizeOpenTabs}>
                  <Group /> Organize open tabs
                </Button>
              )}
            </div>

            <section aria-labelledby="home-subjects" className="mt-12">
              <h2 id="home-subjects" className="text-eyebrow text-tertiary">
                Your projects
              </h2>
              <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {subjects.map((subject) => {
                  const counts = knowledgeCounts(knowledgeItemsOf(subject))
                  const updated = formatRelativeTime(subjectUpdatedAt(subject), now)
                  const parts = [
                    counts.conversations > 0 ? plural(counts.conversations, "AI conversation", "AI conversations") : "",
                    counts.sources > 0 ? plural(counts.sources, "source", "sources") : "",
                    counts.notes > 0 ? plural(counts.notes, "note", "notes") : "",
                  ].filter(Boolean)
                  const savedTabs = subject.tabs.filter((tab) => !tab.resource).length
                  if (parts.length === 0 && savedTabs > 0) parts.push(plural(savedTabs, "saved tab", "saved tabs"))
                  return (
                    <li key={subject.id}>
                      <button
                        type="button"
                        onClick={() => onOpenSubject(subject.id)}
                        aria-label={`Open ${subjectName(subject)}`}
                        className="group flex w-full items-center gap-3 rounded-md border border-subtle bg-card px-4 py-4 text-left transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-color) outline-none hover:border-strong hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        <WorkspaceAvatar workspace={subject} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-h2 text-foreground">{subjectName(subject)}</span>
                          <span className="block truncate text-meta text-tertiary">
                            {parts.length === 0 ? "Empty" : parts.join(" · ")}
                            {updated && parts.length > 0 ? ` · ${updated}` : ""}
                          </span>
                        </span>
                        <ArrowRight aria-hidden className="size-4 shrink-0 text-tertiary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>

            {recent.length > 0 ? (
              <section aria-labelledby="home-recent" className="mt-10">
                <h2 id="home-recent" className="text-eyebrow text-tertiary">
                  Recently saved
                </h2>
                <ul className="mt-2 flex flex-col">
                  {recent.map(({ workspace, item }) => (
                    <li key={`${workspace.id}:${item.id}`}>
                      <button
                        type="button"
                        onClick={() => onOpenItem(workspace.id, item.ref)}
                        className="flex w-full min-w-0 items-center gap-3 rounded-xs px-2 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        <span className="min-w-0 flex-1 truncate text-body text-foreground">{item.title}</span>
                        {item.provider ? <ProviderBadge provider={item.provider} className="shrink-0" /> : <span className="shrink-0 text-meta text-tertiary">{KNOWLEDGE_TYPE_LABEL[item.type]}</span>}
                        <span className="shrink-0 truncate text-meta text-tertiary max-sm:hidden">{subjectName(workspace)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p className="mt-10 flex items-start gap-2 text-body-sm text-muted-foreground">
                <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0" />
                Open a project and choose Add to paste a conversation, write a note or import a ChatGPT or Claude export — or use Save to Hubble in Hubble for Chrome on an AI app.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
