"use client"

import { ArrowRight, Group, PanelLeftOpen, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { BrandMark } from "@/components/brand-mark"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { greeting, recentResources, subjectName, subjectUpdatedAt } from "@/lib/product/subjects"
import { formatRelativeTime } from "@/lib/time-format"
import type { Workspace } from "@/lib/workspace/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Home: where a student's school stuff lives.
 *
 *     Good evening
 *     What are you working on?
 *     [+ New subject]
 *
 *     History HL      Math AA HL      Physics SL
 *
 *     Recent
 *
 * No metrics, no onboarding copy, no agent status. The page answers "where
 * do I put my stuff?" by being a list of places to put it, with one button
 * to make another — and one to sort the tabs already open in Chrome into
 * them (Smart Organize; see components/organize/open-tabs-organize.tsx). AI is offered once, quietly, and only while none is
 * connected — Hubble works without it.
 */
export function HomeView({
  subjects,
  firstRun,
  now,
  onOpenSubject,
  onNewSubject,
  onOrganizeOpenTabs,
  onOpenResource,
  aiConnected,
  onConnectAI,
  onOpenSidebar,
}: {
  /** The student's subjects (workspaces), excluding an untouched default. */
  subjects: readonly Workspace[]
  /** Nothing has ever been made here: say hello once instead of "no subjects". */
  firstRun: boolean
  now: number
  onOpenSubject: (id: string) => void
  onNewSubject: () => void
  /** Smart Organize for the tabs open in Chrome. Omitted where the shell does not offer it. */
  onOrganizeOpenTabs?: () => void
  onOpenResource: (workspaceId: string, tabId: string) => void
  /** Whether any AI is connected. Unknown counts as connected — never nag on a guess. */
  aiConnected: boolean
  onConnectAI: () => void
  onOpenSidebar?: () => void
}) {
  const recent = recentResources(subjects, 6)
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
            <h1 className="text-statement text-foreground">{firstRun ? "Welcome to Hubble" : "Start with a subject"}</h1>
            {/* One line and one button: organizing open tabs joins it once there are subjects (and is in ⌘K throughout). */}
            <Button type="button" size="lg" onClick={onNewSubject}>
              <Plus /> {firstRun ? "Create your first subject" : "New subject"}
            </Button>
          </section>
        ) : (
          <>
            <p className="text-body text-muted-foreground">{greeting(new Date(now).getHours())}</p>
            <h1 className="mt-1 text-statement text-foreground">What are you working on?</h1>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button type="button" size="lg" onClick={onNewSubject}>
                <Plus /> New subject
              </Button>
              {onOrganizeOpenTabs && (
                <Button type="button" size="lg" variant="secondary" onClick={onOrganizeOpenTabs}>
                  <Group /> Organize open tabs
                </Button>
              )}
            </div>

            <section aria-labelledby="home-subjects" className="mt-12">
              <h2 id="home-subjects" className="text-eyebrow text-tertiary">
                Your subjects
              </h2>
              <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {subjects.map((subject) => {
                  const updated = formatRelativeTime(subjectUpdatedAt(subject), now)
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
                            {subject.tabs.length === 0 ? "Empty" : plural(subject.tabs.length, "resource", "resources")}
                            {updated && subject.tabs.length > 0 ? ` · ${updated}` : ""}
                          </span>
                        </span>
                        <ArrowRight aria-hidden className="size-4 shrink-0 text-tertiary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>

            {recent.length > 0 && (
              <section aria-labelledby="home-recent" className="mt-10">
                <h2 id="home-recent" className="text-eyebrow text-tertiary">
                  Recent
                </h2>
                <ul className="mt-2 flex flex-col">
                  {recent.map(({ workspace, tab }) => (
                    <li key={`${workspace.id}:${tab.id}`}>
                      <button
                        type="button"
                        onClick={() => onOpenResource(workspace.id, tab.id)}
                        className="flex w-full min-w-0 items-center gap-3 rounded-xs px-2 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        <TabFavicon domain={tab.domain} icon={tab.favicon} size={16} />
                        <span className="min-w-0 flex-1 truncate text-body text-foreground">{tab.title?.trim() || tab.domain}</span>
                        <span className="shrink-0 truncate text-meta text-tertiary max-sm:hidden">{subjectName(workspace)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {!aiConnected && (
              <Button type="button" variant="ghost" size="sm" className="mt-10 -ml-2" onClick={onConnectAI}>
                Connect AI
              </Button>
            )}
          </>
        )}
      </main>
    </div>
  )
}
