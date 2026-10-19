"use client"

import { useMemo } from "react"
import { ArrowRight, Group, PanelLeftOpen, Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { BrandMark } from "@/components/brand-mark"
import { ProviderBadge } from "@/components/memory/provider-mark"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { FirstSessionPrompt, ResumeSessionCard } from "@/components/sessions/resume-card"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { subjectName, subjectUpdatedAt } from "@/lib/product/subjects"
import { KNOWLEDGE_TYPE_LABEL, knowledgeCounts, knowledgeItemsOf } from "@/lib/memory/items"
import { formatRelativeTime } from "@/lib/time-format"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { Workspace } from "@/lib/workspace/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Projects: where everything you learn with AI lives.
 *
 *     Projects                     [+ New project]  [Search]  [Organize open tabs]
 *
 *     History HL · 4 AI conversations · 6 sources     Math AA HL …
 *
 *     Recently saved
 *       ◇ Causes of WW1 — ChatGPT · History HL
 *
 * Above it, once a session of Chrome tabs is saved, "Pick up where you left
 * off" with one Resume button (components/sessions/resume-card.tsx).
 *
 * The page is its title, its projects and one primary action. With no
 * projects it says what Hubble is for in one sentence and offers one button.
 * Nothing here asks for an AI to be connected: Hubble works without any.
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
  onOpenSessions,
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
  /** The Sessions page. Absent (Hubble Desktop, which can't reach Chrome): no resume card. */
  onOpenSessions?: (options?: { save?: boolean }) => void
}) {
  const recent = useMemo(() => {
    const all: { workspace: Workspace; item: KnowledgeItem }[] = []
    for (const workspace of subjects) for (const item of knowledgeItemsOf(workspace)) all.push({ workspace, item })
    return all.sort((a, b) => b.item.addedAt - a.item.addedAt).slice(0, 8)
  }, [subjects])

  const isDesktop = useIsDesktop()

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
        {onOpenSessions && <ResumeSessionCard now={now} onOpenSessions={onOpenSessions} />}
        {subjects.length === 0 ? (
          <section aria-label="Get started" className="flex flex-col items-start gap-5 pt-6 sm:pt-12">
            <BrandMark className="size-7 text-foreground" />
            <div>
              <h1 className="text-statement text-foreground">{firstRun ? "Welcome to Hubble" : "No projects yet"}</h1>
              <p className="mt-2 max-w-md text-body text-muted-foreground">Keep AI conversations, pages and notes in projects, then reuse them in any AI chat.</p>
            </div>
            <Button type="button" size="lg" onClick={onNewSubject}>
              <Plus /> New project
            </Button>
            <p className="text-meta text-tertiary">No sign-in needed. Everything stays {isDesktop ? "on this computer" : "in this browser"}.</p>
          </section>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <h1 className="text-statement text-foreground">Projects</h1>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="lg" onClick={onNewSubject}>
                  <Plus /> New project
                </Button>
                {onOpenSearch && (
                  <Button type="button" size="lg" variant="secondary" onClick={onOpenSearch}>
                    <Search /> Search
                  </Button>
                )}
                {onOrganizeOpenTabs && (
                  <Button type="button" size="lg" variant="ghost" onClick={onOrganizeOpenTabs}>
                    <Group /> Organize open tabs
                  </Button>
                )}
              </div>
            </div>

            <ul aria-label="Your projects" className="mt-8 grid grid-cols-1 gap-2 sm:grid-cols-2">
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

            {recent.length > 0 && (
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
            )}
            {onOpenSessions && <FirstSessionPrompt onOpenSessions={onOpenSessions} />}
          </>
        )}
      </main>
    </div>
  )
}
