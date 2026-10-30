"use client"

import { useMemo, useState } from "react"
import { AlertCircle, ArrowRight, ArrowUpRight, Group, MessageSquareShare, Orbit, PanelLeftOpen, Play, Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { KindGlyph, KIND_BG_CLASS } from "@/components/ui/kind-glyph"
import { ItemIcon } from "@/components/memory/item-icon"
import { pageIconOf } from "@/lib/memory/item-icon"
import { BrandMark } from "@/components/brand-mark"
import { ProviderBadge, ProviderMark } from "@/components/memory/provider-mark"
import { ProjectIcon } from "@/components/workspace/project-icon"
import { LaunchConfirmDialog, useSessionLaunch } from "@/components/sessions/use-session-launch"
import { activityRows, describeProjectEvent } from "@/components/project/project-activity"
import { ProjectGalaxy } from "./project-galaxy"
import { ResumeSessionCard } from "@/components/sessions/resume-card"
import { useHomeContext } from "@/components/intelligence/home-context"
import type { HomeContextProps } from "@/components/intelligence/home-context"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { useTabSessions } from "@/hooks/use-tab-sessions"
import { useAllProjectActivity } from "@/hooks/use-all-project-activity"
import { subjectName } from "@/lib/product/subjects"
import { changesSince, greetingFor, previousVisit, projectPulses, recentEvents, recentItems } from "@/lib/product/continuity"
import { readLoopLog } from "@/lib/product/loop-log"
import { KNOWLEDGE_TYPE_LABEL, knowledgeCounts } from "@/lib/memory/items"
import { itemActivityAt, itemKind } from "@/lib/memory/kinds"
import { isAiProviderId } from "@/lib/providers/registry"
import { sortByActivity } from "@/lib/sessions/model"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { ProjectPulse } from "@/lib/product/continuity"
import type { TabSession } from "@/lib/sessions/types"
import type { Workspace } from "@/lib/workspace/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Home: where you were, what changed, what next.
 *
 *     Good evening                       [Organize open tabs] [+ New project]
 *     Tuesday 20 October · 3 new since yesterday
 *
 *     ┌ 🔍 Search everything...                                              ┐
 *     └──────────────────────────────────────────────────────────────────────┘
 *
 *     ┌ Continue ────────────────────────────────────────────────── (galaxy) ┐
 *     │ Thesis — Urban heat islands                                          │
 *     │ Chapter 3: methods                                                   │
 *     │ Last: Regression design for canopy cover…  ChatGPT · 2 hr  [Open]    │
 *     │ [Resume “Thesis — writing methods”] [Use in AI] [Show in graph]      │
 *     └──────────────────────────────────────────────────────────────────────┘
 *
 *     Projects                       │  Since you were last here / Activity
 *     Recently saved                 │  Sessions · Needs attention
 *
 * Continue is the anchor: the project something last happened in, its
 * latest item one click from its reader, and the session saved for it. Every
 * row on the page opens the real thing. A first visit gets one sentence and
 * one button — nothing here is a placeholder or an invented number.
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
  onUseInAi,
  onShowInGraph,
  context,
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
  /** The Sessions page. Absent (Hubble Desktop, which can't reach Chrome): no sessions anywhere on Home. */
  onOpenSessions?: (options?: { save?: boolean }) => void
  /** "Use in AI" on a project. */
  onUseInAi?: (workspaceId: string) => void
  /** Opens the Graph focused on a node. */
  onShowInGraph?: (nodeId: string) => void
  /** Context intelligence: suggestions, Smart Resume and the first-run choice. Absent in Hubble Desktop. */
  context?: HomeContextProps
}) {
  const isDesktop = useIsDesktop()
  const { sessions: allSessions } = useTabSessions()
  const sessions = useMemo(() => (onOpenSessions ? allSessions : []), [onOpenSessions, allSessions])
  const events = useAllProjectActivity()
  const [loop] = useState(() => (typeof window === "undefined" ? [] : readLoopLog()))
  const launcher = useSessionLaunch()

  const pulses = useMemo(() => projectPulses({ workspaces: subjects, sessions, events }), [subjects, sessions, events])
  const recent = useMemo(() => recentItems(pulses, 8), [pulses])
  const since = useMemo(() => previousVisit(loop, now), [loop, now])
  const changes = useMemo(() => (since ? changesSince(pulses, since) : undefined), [pulses, since])
  const feed = useMemo(() => recentEvents(events, new Set(subjects.map((subject) => subject.id)), 8), [events, subjects])
  const attention = useMemo(() => pulses.flatMap((pulse) => pulse.attention.map((item) => ({ workspace: pulse.workspace, item }))).slice(0, 4), [pulses])
  const orderedSessions = useMemo(() => sortByActivity(sessions).slice(0, 3), [sessions])
  const intelligence = useHomeContext({ context, subjects, pulses, now, returningFrom: since, launcher, canOpenTabs: Boolean(onOpenSessions), onOpenSubject })

  const launchSession = (session: TabSession) =>
    void launcher.launch({ tabs: session.tabs.map((tab) => ({ url: tab.url, ...(tab.pinned ? { pinned: true } : {}) })), sessionIds: [session.id] })

  const mobileBar = onOpenSidebar && (
    <header className="flex h-12 items-center px-3 md:hidden">
      <IconButton aria-label="Open sidebar" onClick={onOpenSidebar}>
        <PanelLeftOpen />
      </IconButton>
    </header>
  )

  if (subjects.length === 0) {
    return (
      <div className="min-h-screen" data-home>
        {mobileBar}
        <main className="mx-auto flex min-h-[80vh] w-full max-w-xl flex-col justify-center px-6 py-12">
          {/* Sessions can come before projects: someone who saved their tabs can pick them up here. */}
          {onOpenSessions && <ResumeSessionCard now={now} onOpenSessions={onOpenSessions} />}
          {intelligence.top}
          {intelligence.suggestions}
          <section aria-label="Get started" className="flex flex-col items-start gap-6 animate-enter">
            <div className="relative grid size-20 place-items-center">
              <svg aria-hidden viewBox="0 0 80 80" className="absolute inset-0 size-20 text-foreground">
                <circle cx="40" cy="40" r="36" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeDasharray="2 5" />
                <circle cx="40" cy="40" r="24" fill="none" stroke="currentColor" strokeOpacity="0.16" />
                <circle cx="64" cy="40" r="3" fill="var(--kind-conversation)" />
                <circle cx="22" cy="20" r="2.4" fill="var(--kind-source)" />
                <circle cx="30" cy="70" r="2.4" fill="var(--kind-file)" />
              </svg>
              <BrandMark className="relative size-7 text-foreground" />
            </div>
            <div>
              <h1 className="text-display text-foreground">{firstRun ? "Welcome to Hubble" : "No projects yet"}</h1>
              <p className="mt-3 max-w-md text-body text-muted-foreground">Keep AI conversations, pages and notes in projects, then reuse them in any AI chat.</p>
            </div>
            <Button type="button" size="lg" onClick={onNewSubject}>
              <Plus /> New project
            </Button>
            <p className="text-meta text-tertiary">No sign-in needed. Everything stays {isDesktop ? "on this computer" : "in this browser"}.</p>
          </section>
        </main>
        {intelligence.dialogs}
      </div>
    )
  }

  const lead = pulses[0]!
  const dateLine = new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
  const changeLine = changes && changes.items.length > 0 ? `${plural(changes.items.length, "new item", "new items")} since ${formatRelativeTime(changes.since, now)?.toLowerCase() ?? "your last visit"}` : null

  return (
    <div className="min-h-screen" data-home>
      {mobileBar}
      <main className="mx-auto w-full max-w-[1120px] px-4 pt-4 pb-12 sm:px-8 sm:pt-8">
        {/* Greeting: the hour, the date, and what changed — nothing more. */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 animate-enter">
          <div className="min-w-0">
            <h1 className="text-title text-foreground">{greetingFor(now)}</h1>
            <p className="mt-1 text-body text-muted-foreground">
              {dateLine}
              {changeLine && <span className="text-tertiary"> · {changeLine}</span>}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick actions">
            {onOrganizeOpenTabs && (
              <Button type="button" variant="ghost" onClick={onOrganizeOpenTabs}>
                <Group /> Organize open tabs
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onNewSubject}>
              <Plus /> New project
            </Button>
          </div>
        </div>

        {/* Context intelligence: the first-run choice and Smart Resume, only when there is something worth saying. */}
        {intelligence.top}

        {/* Universal Search: the same search page the sidebar opens, from the middle of Home. */}
        {onOpenSearch && <HomeSearch onOpen={onOpenSearch} />}

        <ContinueCard
          pulse={lead}
          now={now}
          onOpenSubject={onOpenSubject}
          onOpenItem={onOpenItem}
          {...(onOpenSessions && lead.session ? { onResume: () => launchSession(lead.session!), resumePending: launcher.pending } : {})}
          {...(onUseInAi ? { onUseInAi } : {})}
          {...(onShowInGraph ? { onShowInGraph } : {})}
        />

        {/* Smart Save / Smart Organize: a few suggestions, strongest first. */}
        {intelligence.suggestions}

        <div className="mt-8 grid grid-cols-1 gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-8">
            <section aria-labelledby="home-projects">
              <SectionHeading id="home-projects">Projects</SectionHeading>
              <ul aria-label="Your projects" className="mt-2 flex flex-col">
                {pulses.map((pulse, index) => (
                  <li key={pulse.workspace.id} className="animate-rise" style={{ ["--stagger" as string]: index }}>
                    <ProjectRow pulse={pulse} now={now} onOpen={onOpenSubject} />
                  </li>
                ))}
              </ul>
            </section>

            {recent.length > 0 && (
              <section aria-labelledby="home-recent">
                <SectionHeading id="home-recent">Recently saved</SectionHeading>
                <ul className="mt-2 flex flex-col">
                  {recent.map(({ workspace, item }) => (
                    <li key={`${workspace.id}:${item.id}`}>
                      <ItemRow item={item} favicon={pageIconOf(workspace, item)} projectName={subjectName(workspace)} now={now} onOpen={() => onOpenItem(workspace.id, item.ref)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <aside className="flex min-w-0 flex-col gap-8" aria-label="Activity">
            {changes && changes.items.length > 0 ? (
              <section aria-labelledby="home-changes">
                <SectionHeading id="home-changes">Since you were last here</SectionHeading>
                <ul className="mt-2 flex flex-col">
                  {changes.items.map(({ workspace, item }) => (
                    <li key={`${workspace.id}:${item.id}`}>
                      <ItemRow item={item} favicon={pageIconOf(workspace, item)} projectName={subjectName(workspace)} now={now} compact onOpen={() => onOpenItem(workspace.id, item.ref)} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              feed.length > 0 && (
                <section aria-labelledby="home-activity">
                  <SectionHeading id="home-activity">Activity</SectionHeading>
                  <ol className="mt-2 flex flex-col">
                    {activityRows(feed).map((row) => {
                      const workspace = subjects.find((subject) => subject.id === row.event.workspaceId)
                      if (!workspace) return null
                      const titleOf = (id: string) => workspace.tabs.find((tab) => tab.id === id)?.title ?? workspace.notes?.find((note) => note.id === id)?.title
                      const provider = isAiProviderId(row.event.provider) ? row.event.provider : undefined
                      return (
                        <li key={row.key}>
                          <button type="button" onClick={() => onOpenSubject(workspace.id)} className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60">
                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-strong" aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block text-body-sm text-foreground">{describeProjectEvent(row, { projectName: subjectName(workspace), titleOf })}</span>
                              <span className="block truncate text-meta text-tertiary">
                                {subjectName(workspace)} · {formatRelativeTime(row.at, now)}
                              </span>
                            </span>
                            {provider && <ProviderMark provider={provider} size={14} className="mt-0.5" />}
                          </button>
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )
            )}

            {onOpenSessions && (
              <section aria-labelledby="home-sessions">
                <SectionHeading id="home-sessions" action={orderedSessions.length > 0 ? { label: "All", onClick: () => onOpenSessions() } : undefined}>
                  Sessions
                </SectionHeading>
                {orderedSessions.length === 0 ? (
                  <div className="mt-2 rounded-lg border border-dashed border-strong px-4 py-4">
                    <p className="text-body-sm text-muted-foreground">Save the tabs you have open, and pick them up again later.</p>
                    <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => onOpenSessions({ save: true })}>
                      Save your open tabs as a session
                    </Button>
                  </div>
                ) : (
                  <ul className="mt-2 flex flex-col">
                    {orderedSessions.map((session) => (
                      <li key={session.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                        <KindGlyph kind="session" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm text-foreground">{session.name}</span>
                          <span className="block truncate text-meta text-tertiary">
                            {plural(session.tabs.length, "tab", "tabs")}
                            {session.workspaceId && subjects.some((subject) => subject.id === session.workspaceId) ? ` · ${subjectName(subjects.find((subject) => subject.id === session.workspaceId)!)}` : ""}
                            {" · "}
                            {formatRelativeTime(Math.max(session.updatedAt, session.lastRestoredAt ?? 0), now)}
                          </span>
                        </span>
                        <Button type="button" size="sm" variant="ghost" aria-label={`Resume ${session.name}`} disabled={launcher.pending} onClick={() => launchSession(session)}>
                          <Play /> Resume
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {attention.length > 0 && (
              <section aria-labelledby="home-attention">
                <SectionHeading id="home-attention">Needs attention</SectionHeading>
                <ul className="mt-2 flex flex-col">
                  {attention.map(({ workspace, item }) => (
                    <li key={`${workspace.id}:${item.id}`}>
                      <button type="button" onClick={() => onOpenItem(workspace.id, item.ref)} className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60">
                        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm text-foreground">{item.title}</span>
                          <span className="block truncate text-meta text-tertiary">{item.problem ?? "Couldn't be read"} · {subjectName(workspace)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      </main>
      <LaunchConfirmDialog request={launcher.confirming} onConfirm={() => void launcher.confirm()} onCancel={launcher.cancel} />
      {intelligence.dialogs}
    </div>
  )
}

/** The search field of Home. A button, not an input: it opens the search page, where typing happens. */
function HomeSearch({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search"
      className="group mt-5 flex h-12 w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-4 text-left text-body text-tertiary shadow-(--shadow-panel) outline-none transition-[border-color,color] duration-(--duration-fast) ease-(--ease-color) animate-enter hover:border-strong hover:text-muted-foreground focus-visible:border-strong focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search everything...</span>
    </button>
  )
}

function SectionHeading({ id, children, action }: { id: string; children: React.ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-subtle pb-2">
      <h2 id={id} className="text-eyebrow text-tertiary">
        {children}
      </h2>
      {action && (
        <button type="button" onClick={action.onClick} className="flex items-center gap-1 text-meta text-tertiary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
          {action.label} <ArrowRight aria-hidden className="size-3" />
        </button>
      )}
    </div>
  )
}

/**
 * The anchor of Home: the project something last happened in. Its latest
 * item opens its reader in one click; the session saved for it reopens its
 * tabs; and the galaxy on the right is the project itself — one star per
 * thing it holds, in the Graph's own encoding. Where the card is too narrow
 * to share (phones, tablets) it is the card's header, bled to its edges.
 */
function ContinueCard({
  pulse,
  now,
  onOpenSubject,
  onOpenItem,
  onResume,
  resumePending,
  onUseInAi,
  onShowInGraph,
}: {
  pulse: ProjectPulse
  now: number
  onOpenSubject: (id: string) => void
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef) => void
  onResume?: () => void
  resumePending?: boolean
  onUseInAi?: (workspaceId: string) => void
  onShowInGraph?: (nodeId: string) => void
}) {
  const { workspace, items, session } = pulse
  const name = subjectName(workspace)
  const last = items[0]
  const more = items.slice(1, 4)
  const focus = workspace.brief?.focus || workspace.brief?.description
  return (
    <section aria-labelledby="home-continue" className="relative mt-5 overflow-hidden rounded-xl border border-border bg-card shadow-(--shadow-panel) animate-enter" data-continue={workspace.id}>
      <div className="relative flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col">
          <p id="home-continue" className="text-eyebrow text-tertiary">
            Continue
          </p>
          <button type="button" onClick={() => onOpenSubject(workspace.id)} aria-label={`Open ${name}`} className="group mt-2 flex w-fit max-w-full items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-md">
            <ProjectIcon workspace={workspace} size={20} />
            <span className="min-w-0">
              <span className="block truncate text-title text-foreground group-hover:underline group-hover:decoration-border-strong group-hover:underline-offset-4">{name}</span>
              <span className="block truncate text-body-sm text-muted-foreground">{focus || `${plural(items.length, "item", "items")} · active ${formatRelativeTime(pulse.lastAt, now)?.toLowerCase()}`}</span>
            </span>
          </button>

          {last ? (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => onOpenItem(workspace.id, last.ref)}
                className="group flex w-full min-w-0 items-center gap-3 rounded-lg border border-subtle bg-background/60 px-3 py-2.5 text-left outline-none transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-color) hover:border-strong hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/60"
                aria-label={`Open ${last.title}`}
              >
                <ItemIcon item={last} favicon={pageIconOf(workspace, last)} tile />
                <span className="min-w-0 flex-1">
                  <span className="block text-meta text-tertiary">Last touched · {formatRelativeTime(itemActivityAt(last), now)}</span>
                  <span className="block truncate text-body text-foreground">{last.title}</span>
                </span>
                {last.provider && <ProviderBadge provider={last.provider} className="shrink-0 max-sm:hidden" />}
                <ArrowUpRight aria-hidden className="size-4 shrink-0 text-tertiary transition-transform duration-(--duration-fast) ease-(--ease-standard) group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
              </button>
              {more.length > 0 && (
                <ul className="mt-1.5 flex flex-col" aria-label={`More in ${name}`}>
                  {more.map((item) => (
                    <li key={item.id}>
                      <button type="button" onClick={() => onOpenItem(workspace.id, item.ref)} className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-3 py-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60">
                        <ItemIcon item={item} favicon={pageIconOf(workspace, item)} size={14} className="size-3.5" />
                        <span className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground">{item.title}</span>
                        <span className="shrink-0 text-meta text-tertiary">{formatRelativeTime(itemActivityAt(item), now)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="mt-5 text-body-sm text-muted-foreground">Nothing saved here yet — add a conversation, a page or a file.</p>
          )}

          <div className="mt-auto flex flex-wrap gap-2 pt-5">
            {onResume && session && (
              <Button type="button" variant="secondary" onClick={onResume} disabled={resumePending} aria-label={`Resume ${session.name}`}>
                <Play /> {resumePending ? "Opening…" : `Resume “${session.name}”`}
              </Button>
            )}
            {onUseInAi && items.length > 0 && (
              <Button type="button" variant="ghost" onClick={() => onUseInAi(workspace.id)}>
                <MessageSquareShare /> Use in AI
              </Button>
            )}
            {onShowInGraph && (
              <Button type="button" variant="ghost" onClick={() => onShowInGraph(`p:${workspace.id}`)}>
                <Orbit /> Show in graph
              </Button>
            )}
          </div>
        </div>
        <ProjectGalaxy
          items={items}
          seed={workspace.id}
          className="relative order-first -mx-5 -mt-5 h-44 [mask-image:linear-gradient(to_bottom,black_72%,transparent)] sm:-mx-7 sm:-mt-7 sm:h-48 lg:order-none lg:my-[-1.75rem] lg:mr-[-1.75rem] lg:ml-0 lg:h-auto lg:min-h-64 lg:w-[300px] lg:shrink-0 lg:[mask-image:linear-gradient(to_right,transparent,black_22%)] xl:w-[360px]"
        />
      </div>
    </section>
  )
}

function ProjectRow({ pulse, now, onOpen }: { pulse: ProjectPulse; now: number; onOpen: (id: string) => void }) {
  const { workspace, items } = pulse
  const counts = knowledgeCounts(items)
  const files = items.filter((item) => itemKind(item) === "file").length
  const parts = [
    counts.conversations > 0 ? plural(counts.conversations, "AI conversation", "AI conversations") : "",
    counts.sources - files > 0 ? plural(counts.sources - files, "source", "sources") : "",
    files > 0 ? plural(files, "file", "files") : "",
    counts.notes > 0 ? plural(counts.notes, "note", "notes") : "",
  ].filter(Boolean)
  const savedTabs = workspace.tabs.filter((tab) => !tab.resource).length
  if (parts.length === 0 && savedTabs > 0) parts.push(plural(savedTabs, "saved tab", "saved tabs"))
  const updated = formatRelativeTime(pulse.lastAt, now)
  const name = subjectName(workspace)
  return (
    <button
      type="button"
      onClick={() => onOpen(workspace.id)}
      aria-label={`Open ${name}`}
      className="group flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left outline-none transition-[background-color] duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <ProjectIcon workspace={workspace} size={20} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-foreground">{name}</span>
        <span className="block truncate text-meta text-tertiary">{parts.length === 0 ? "Empty" : parts.join(" · ")}</span>
      </span>
      <KindBar items={items} />
      <span className="w-20 shrink-0 text-right text-meta text-tertiary max-sm:hidden">{updated}</span>
      <ArrowRight aria-hidden className="size-4 shrink-0 text-tertiary opacity-0 transition-[opacity,transform] duration-(--duration-fast) ease-(--ease-standard) group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  )
}

/** A project's mix at a glance: one segment per kind, as wide as its share. Decorative — the counts are in words beside it. */
function KindBar({ items }: { items: readonly KnowledgeItem[] }) {
  if (items.length === 0) return <span className="h-1 w-24 shrink-0 rounded-full bg-surface-active max-md:hidden" aria-hidden />
  const counts = { conversation: 0, source: 0, file: 0, note: 0 }
  for (const item of items) counts[itemKind(item)] += 1
  return (
    <span aria-hidden className="flex h-1 w-24 shrink-0 gap-px overflow-hidden rounded-full max-md:hidden">
      {(Object.keys(counts) as (keyof typeof counts)[]).map((kind) =>
        counts[kind] > 0 ? <span key={kind} className={cn("h-full", KIND_BG_CLASS[kind])} style={{ flexGrow: counts[kind] }} /> : null
      )}
    </span>
  )
}

function ItemRow({ item, favicon, projectName, now, onOpen, compact = false }: { item: KnowledgeItem; favicon?: string; projectName: string; now: number; onOpen: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-[background-color] duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <ItemIcon item={item} {...(favicon ? { favicon } : {})} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-foreground">{item.title}</span>
        {compact && <span className="block truncate text-meta text-tertiary">{projectName}</span>}
      </span>
      {!compact && (item.provider ? <ProviderBadge provider={item.provider} className="shrink-0" /> : <span className="shrink-0 text-meta text-tertiary">{KNOWLEDGE_TYPE_LABEL[item.type]}</span>)}
      {!compact && <span className="w-36 shrink-0 truncate text-right text-meta text-tertiary max-sm:hidden">{projectName}</span>}
      <span className="w-16 shrink-0 text-right text-meta text-tertiary max-md:hidden">{formatRelativeTime(item.addedAt, now)}</span>
    </button>
  )
}
