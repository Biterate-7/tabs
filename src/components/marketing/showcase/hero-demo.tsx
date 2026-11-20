"use client"

import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowUp, Check, House, Layers, Library, MessageSquareShare, Orbit, Plus, Search } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { ProviderMark } from "@/components/memory/provider-mark"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { planStepLine } from "@/lib/knowledge/workspace/plan"
import { buildMemoryBundle } from "@/lib/memory/bundle"
import { KNOWLEDGE_TYPE_LABEL, knowledgeItemsOf, type KnowledgeItem, type KnowledgeItemRef } from "@/lib/memory/items"
import { itemKind } from "@/lib/memory/kinds"
import { AI_PROVIDER_IDS, aiProviderName } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import { SAMPLE_CONTENTS, SAMPLE_WORKSPACE } from "../sample-knowledge"
import { at, useTimeline } from "./use-timeline"
import { AddressBar, DemoWindow, Kbd } from "./window"

/*
 * The hero: Hubble's loop, played across the two places it actually happens.
 *
 *   Workspace — the project in Hubble, everything saved into it.
 *   Context   — four items chosen, and Use in AI writing them up for Claude
 *               (the text is the product's own bundle, built below).
 *   Agent     — Claude, in its own app, with that context in the message
 *               box, reading the project through Hubble's connector.
 *   Action    — Claude saving a decision and proposing a reorganisation, the
 *               connector's real tool names.
 *   Review    — back in Hubble, the proposal waits for the person; nothing
 *               moves until they approve it. Then the project shows it.
 *
 * Every frame is drawn from the sample project by the product's own code
 * (knowledgeItemsOf, buildMemoryBundle, planStepLine), and nothing here
 * claims a feature Hubble does not have: Hubble never runs the AI, it hands
 * over context and holds what comes back for review.
 */

const CHAPTERS = ["Workspace", "Context", "Agent", "Action", "Review"] as const
/** Which chapter each frame belongs to. */
const FRAME_CHAPTER = [0, 1, 1, 2, 2, 3, 4, 4] as const
const DURATIONS = [2600, 1700, 3200, 2600, 3400, 3200, 3600, 3800] as const
const CHAPTER_START = CHAPTERS.map((_, chapter) => FRAME_CHAPTER.indexOf(chapter as (typeof FRAME_CHAPTER)[number]))

const F = {
  select: 1,
  useInAi: 2,
  claude: 3,
  reading: 4,
  acting: 5,
  review: 6,
  applied: 7,
} as const

const CHOSEN: KnowledgeItemRef[] = [
  { kind: "note", noteId: "note-thesis" },
  { kind: "source", tabId: "chat-gpt" },
  { kind: "source", tabId: "chat-claude" },
  { kind: "source", tabId: "pdf-clark" },
]
const REQUEST = "Help me argue that the alliance system was not the main cause"
const JULY_CRISIS = ["pdf-clark", "chat-gemini", "page-sarajevo"]
/** What the connector's search finds: it reads synced titles and links, not the device-local text. */
const JULY_CRISIS_TITLES = SAMPLE_WORKSPACE.tabs.filter((tab) => tab.title?.toLowerCase().includes("july crisis")).length
const HISTORIANS = ["chat-claude", "chat-perplexity"]

export function HeroDemo() {
  const { attach, frame, animated, run, go: goTo, playing, duration } = useTimeline({ durations: DURATIONS, restFrame: 0, startFrame: 0, threshold: 0.25 })
  const [declined, setDeclined] = useState(false)
  const chapter = FRAME_CHAPTER[frame] ?? 0
  const claudeFront = at(frame, F.claude, F.acting)

  const items = useMemo(() => knowledgeItemsOf(SAMPLE_WORKSPACE), [])
  const bundle = useMemo(
    () => buildMemoryBundle({ workspace: SAMPLE_WORKSPACE, refs: CHOSEN, contents: SAMPLE_CONTENTS, request: REQUEST, budget: 5_000 }),
    []
  )
  const steps = useMemo(() => {
    const title = (id: string) => items.find((item) => item.id === id)?.title ?? id
    return [
      { line: planStepLine({ kind: "create_collection", subject: "July Crisis", tabCount: JULY_CRISIS.length, tabs: [], movesFrom: [] }), tabs: JULY_CRISIS.map(title) },
      { line: planStepLine({ kind: "create_collection", subject: "Historians' views", tabCount: HISTORIANS.length, tabs: [], movesFrom: [] }), tabs: HISTORIANS.map(title) },
    ]
  }, [items])

  const go = (next: number) => {
    if (next === 0) setDeclined(false)
    goTo(next)
  }

  return (
    <div ref={attach} className="flex flex-col gap-5" data-hero-demo="" data-frame={frame}>
      <div className="m-stage m-stage-hero m-bleed">
        <div className="relative mx-auto grid h-[560px] max-w-[1180px] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] px-3 pt-6 sm:h-[600px] sm:px-8 sm:pt-10 lg:h-[700px] lg:px-14 lg:pt-14">
          {/* Hubble */}
          <HeroWindow front={!claudeFront} side="hubble">
            <DemoWindow
              label="Hubble with the sample project History IA open: AI conversations from ChatGPT, Claude, Gemini and Perplexity, a PDF, a web page and a note."
              title="Hubble"
              className="h-full"
              inert={claudeFront}
            >
              <HubbleApp
                frame={frame}
                items={items}
                bundleText={bundle.text}
                bundleChars={bundle.chars}
                steps={steps}
                declined={declined}
                onApprove={() => go(F.applied)}
                onDecline={() => {
                  setDeclined(true)
                  goTo(F.applied)
                }}
              />
            </DemoWindow>
          </HeroWindow>

          {/* Claude, in its own app */}
          <HeroWindow front={claudeFront} side="claude">
            <DemoWindow
              label="Claude in Chrome with Hubble's context in the message, reading the project through Hubble's connector, saving a decision and proposing changes for review."
              title="Claude"
              bar={<AddressBar host="claude.ai" path="/new" />}
              className="h-full"
              inert={!claudeFront}
            >
              <ClaudeApp frame={frame} bundleText={bundle.text} />
            </DemoWindow>
          </HeroWindow>
        </div>
      </div>

      <LoopRail chapter={chapter} frame={frame} animated={animated} playing={playing} duration={duration} run={run} onChapter={(index) => go(CHAPTER_START[index] ?? 0)} />
    </div>
  )
}

/** One of the two windows: in front, or a step back and dimmed. On a phone only the front one shows. */
function HeroWindow({ front, side, children }: { front: boolean; side: "hubble" | "claude"; children: ReactNode }) {
  return (
    <div
      data-front={front}
      className={cn(
        "m-hero-window col-start-1 row-start-1 min-h-0",
        side === "hubble" ? "md:mr-[14%] md:mb-[64px] lg:mr-[18%]" : "md:mt-[72px] md:ml-[38%] lg:mt-[120px] lg:ml-[46%] md:-mb-[20px]"
      )}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------- Hubble

function HubbleApp({
  frame,
  items,
  bundleText,
  bundleChars,
  steps,
  declined,
  onApprove,
  onDecline,
}: {
  frame: number
  items: KnowledgeItem[]
  bundleText: string
  bundleChars: number
  steps: { line: string; tabs: string[] }[]
  declined: boolean
  onApprove: () => void
  onDecline: () => void
}) {
  const selecting = at(frame, F.select, F.useInAi)
  const chosen = new Set(CHOSEN.map((ref) => (ref.kind === "note" ? ref.noteId : ref.tabId)))
  const counts = {
    all: items.length,
    conversation: items.filter((item) => item.type === "conversation").length,
    source: items.filter((item) => item.type !== "conversation" && item.type !== "note").length,
    note: items.filter((item) => item.type === "note").length,
  }
  // Proposals wait in Settings → AI connectors, so the review happens there.
  const reviewing = at(frame, F.review, F.applied)

  return (
    <div className="flex min-h-0 flex-1">
      {/* Sidebar — the app's own destinations. */}
      <aside aria-hidden className="hidden w-[188px] shrink-0 flex-col gap-0.5 border-r border-subtle bg-[var(--m-ground-2)] px-2 py-2.5 lg:flex">
        <div className="mb-2 flex items-center gap-2 px-1.5">
          <BrandMark className="size-[18px]" />
          <span className="text-[13px] text-foreground">Hubble</span>
          <Plus className="ml-auto size-3.5 text-tertiary" />
        </div>
        <div className="mb-2 flex h-7 items-center gap-2 rounded-md border border-subtle px-2 text-[12px] text-tertiary">
          <Search className="size-3.5" /> Search <span className="ml-auto"><Kbd>Ctrl K</Kbd></span>
        </div>
        {[
          { icon: House, label: "Home" },
          { icon: Orbit, label: "Graph" },
          { icon: MessageSquareShare, label: "AI" },
          { icon: Library, label: "Library" },
          { icon: Layers, label: "Sessions" },
        ].map(({ icon: Icon, label }) => (
          <span key={label} className="flex h-[28px] items-center gap-2 rounded-md px-2 text-[12.5px] text-muted-foreground">
            <Icon className="size-3.5" /> {label}
          </span>
        ))}
        <span className="mt-4 px-2 text-[11px] text-tertiary">Projects</span>
        {[
          { name: "History IA", count: items.length, current: true },
          { name: "Physics coursework", count: 12 },
          { name: "Extended essay", count: 9 },
        ].map((project) => (
          <span
            key={project.name}
            className={cn(
              "flex h-[28px] items-center gap-2 rounded-md px-2 text-[12.5px]",
              project.current ? "bg-[var(--m-ground-5)] text-foreground" : "text-muted-foreground"
            )}
          >
            <span className="flex size-4 items-center justify-center rounded-[4px] border border-strong text-[9px] text-muted-foreground">{project.name[0]}</span>
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.current && <span className="text-[11px] text-tertiary tabular-nums">{project.count}</span>}
          </span>
        ))}
      </aside>

      {/* The project */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div aria-hidden className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle px-4 text-[12px] text-tertiary">
          <span>{reviewing ? "Settings" : "Projects"}</span>
          <span>/</span>
          <span className="text-muted-foreground">{reviewing ? "AI connectors" : "History IA"}</span>
          <span
            data-on={selecting}
            className="m-glow ml-auto flex h-6 items-center gap-1.5 rounded-[4px] border border-subtle px-2 text-[11.5px] text-muted-foreground data-[on=true]:border-strong data-[on=true]:bg-[var(--m-ground-5)] data-[on=true]:text-foreground"
          >
            <MessageSquareShare className="size-3.5" /> {selecting ? `Use ${chosen.size} in AI` : "Use in AI"}
          </span>
          <span className="flex h-6 items-center gap-1 rounded-[4px] bg-foreground px-2 text-[11.5px] text-background">
            <Plus className="size-3.5" /> Add
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4 sm:px-6 sm:pt-5">
          <p className="text-[20px] leading-tight tracking-[-0.02em] text-foreground">History IA</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{SAMPLE_WORKSPACE.brief?.description}</p>

          <div aria-hidden className="mt-4 flex flex-wrap gap-1.5 text-[11.5px]">
            {[
              { label: "All", count: counts.all, on: true },
              { label: "AI conversations", count: counts.conversation },
              { label: "Sources", count: counts.source },
              { label: "Notes", count: counts.note },
            ].map((chip) => (
              <span
                key={chip.label}
                className={cn("flex h-6 items-center gap-1.5 rounded-full border px-2.5", chip.on ? "border-strong bg-[var(--m-ground-4)] text-foreground" : "border-subtle text-muted-foreground")}
              >
                {chip.label} <span className="text-tertiary tabular-nums">{chip.count}</span>
              </span>
            ))}
          </div>

          <ul aria-hidden className="mt-3 flex flex-col">
            {items.map((item, index) => {
              const picked = selecting && chosen.has(item.id)
              return (
                <li
                  key={item.id}
                  className="m-glow flex h-[46px] items-center gap-2.5 border-b border-subtle px-1 data-[picked=true]:bg-[var(--m-ground-3)]"
                  data-picked={picked}
                  style={{ transitionDelay: picked ? `${index * 70}ms` : "0ms" } as CSSProperties}
                >
                  <span
                    data-on={selecting}
                    className="m-fx m-fx-left flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-strong data-[picked=true]:border-foreground data-[picked=true]:bg-foreground"
                    data-picked={picked}
                    style={{ transitionDelay: `${index * 40}ms` } as CSSProperties}
                  >
                    {picked && <Check className="size-2.5 text-background" strokeWidth={3} />}
                  </span>
                  <ItemMark item={item} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-foreground">{item.title}</span>
                    <span className="block truncate text-[11px] text-tertiary">
                      {item.provider ? aiProviderName(item.provider) : (item.domain ?? "Your words")} · {KNOWLEDGE_TYPE_LABEL[item.type]}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Use in AI — the product's own text, for the app chosen. */}
        <Panel on={frame === F.useInAi}>
          <p className="text-[13px] text-foreground">Use in AI</p>
          <p className="mt-0.5 text-[11.5px] text-tertiary">
            {chosen.size} items · {bundleChars.toLocaleString("en-US")} characters
          </p>
          <div className="mt-3 flex gap-1.5">
            {AI_PROVIDER_IDS.map((id) => (
              <span
                key={id}
                className={cn(
                  "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[5px] border text-[11px]",
                  id === "claude" ? "border-foreground/60 bg-[var(--m-ground-5)] text-foreground" : "border-subtle text-muted-foreground"
                )}
              >
                <ProviderMark provider={id} size={12} />
                <span className="hidden xl:inline">{aiProviderName(id)}</span>
              </span>
            ))}
          </div>
          <pre className="m-mono mt-3 min-h-0 flex-1 overflow-hidden rounded-[5px] border border-subtle bg-[var(--m-ground)] p-2.5 text-[10.5px] leading-[1.55] whitespace-pre-wrap text-muted-foreground">
            {bundleText}
          </pre>
          <p className="mt-2 text-[11px] text-tertiary">You see exactly what Claude receives.</p>
          <span className="mt-2 flex h-7 items-center justify-center gap-1.5 rounded-[4px] bg-foreground text-[12px] text-background">
            <ProviderMark provider="claude" size={12} /> Open in Claude
          </span>
        </Panel>

        {/* Review — Settings → AI connectors, where proposals wait. */}
        <Panel on={reviewing} wide>
          <div className="grid min-h-0 flex-1 gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="min-w-0">
          <p className="text-[13px] text-foreground">AI connectors</p>
          <p className="mt-3 text-[11px] text-tertiary">Changes proposed by AI clients</p>
          <div className="mt-2 rounded-md border border-subtle bg-[var(--m-ground-2)] p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12.5px] leading-snug text-foreground">Claude proposed 2 changes in “History IA”</p>
              <span
                className={cn(
                  "m-glow shrink-0 rounded-full border px-2 py-px text-[10.5px]",
                  frame === F.applied ? "border-strong text-foreground" : "border-subtle text-muted-foreground"
                )}
              >
                {frame === F.applied ? (declined ? "Declined" : "Applied") : "Waiting for you"}
              </span>
            </div>
            <p className="mt-1 text-[11.5px] text-muted-foreground">Its words: “Group the evidence so the essay&rsquo;s argument sits together.”</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {steps.map((step) => (
                <li key={step.line} className="text-[11.5px] text-foreground">
                  {step.line}
                  <span className="block text-[10.5px] text-tertiary">{step.tabs.join(" · ")}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-1.5">
              {frame === F.review ? (
                <>
                  <button type="button" onClick={onApprove} className="m-glow h-6 rounded-[4px] bg-foreground px-2.5 text-[11.5px] text-background hover:bg-[var(--accent-hover)]">
                    Approve
                  </button>
                  <button type="button" onClick={onDecline} className="m-glow h-6 rounded-[4px] border border-strong px-2.5 text-[11.5px] text-foreground hover:bg-[var(--m-ground-4)]">
                    Decline
                  </button>
                </>
              ) : (
                <span className="flex h-6 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <Check className="size-3.5" /> {declined ? "Nothing was changed." : "Applied and verified."}
                </span>
              )}
            </div>
          </div>
          </div>
          <div className="min-w-0">
          <p className="text-[11px] text-tertiary lg:mt-[29px]">Recent activity</p>
          <ul className="mt-1 flex flex-col divide-y divide-subtle text-[11.5px]">
            {[
              { who: "Claude", what: "Saved: save project context", outcome: "Done" },
              { who: "Claude", what: "Proposed: propose organization", outcome: frame === F.applied ? "Done" : "Waiting for you" },
              ...(frame === F.applied ? [{ who: "You", what: declined ? "Declined: propose organization" : "Approved: apply organization", outcome: "Done" }] : []),
            ].map((row) => (
              <li key={row.what} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate text-muted-foreground">
                  <span className="text-foreground">{row.who}</span> · {row.what}
                </span>
                <span className="shrink-0 text-tertiary">{row.outcome}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[11px] text-tertiary">Saved project context · History IA</p>
          <div className="mt-1.5 rounded-md border border-subtle bg-[var(--m-ground-2)] p-2.5 text-[11.5px]">
            <p className="text-muted-foreground">Decisions</p>
            <p className="mt-0.5 flex items-start gap-1.5 text-foreground">
              <ProviderMark provider="claude" size={12} className="mt-[3px]" /> The alliance system explains how the war spread, not why it began.
            </p>
          </div>
          </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}

/** A sheet sliding in over the project's right side, as Hubble's sheets do — or, `wide`, another page of the app replacing the project under its bar. */
function Panel({ on, wide = false, children }: { on: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div
      data-on={on}
      className={cn(
        "m-fx absolute right-0 bottom-0 flex flex-col p-4",
        wide
          ? "top-10 w-full overflow-hidden bg-[var(--m-window)] sm:px-6 sm:pt-5"
          : "top-0 w-full max-w-[340px] border-l border-subtle bg-[var(--m-ground-2)] shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.7)] data-[on=false]:translate-x-6 sm:w-[78%]"
      )}
    >
      {children}
    </div>
  )
}

function ItemMark({ item }: { item: KnowledgeItem }) {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      {item.provider ? <ProviderMark provider={item.provider} size={15} /> : <KindGlyph kind={itemKind(item)} type={item.type} className="size-3.5" />}
    </span>
  )
}

// ---------------------------------------------------------------- Claude

function ClaudeApp({ frame, bundleText }: { frame: number; bundleText: string }) {
  const sent = frame >= F.reading
  const preview = bundleText.split("\n").filter(Boolean).slice(0, 3)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--m-ground)]">
      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4 sm:px-6">
        <div className="mx-auto flex max-w-[520px] flex-col gap-3">
          {/* The message, once sent. */}
          <div data-on={sent} className="m-fx ml-auto max-w-[88%] rounded-[10px] bg-[var(--m-ground-4)] px-3 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
            <span className="m-mono block truncate text-[10.5px] text-tertiary">{preview[0]}</span>
            <span className="block truncate">{preview[1]}</span>
            <span className="mt-1 block text-foreground">{REQUEST}</span>
          </div>

          <ToolRow on={at(frame, F.reading)} working={frame === F.reading} delay={0} tool="get_project_context" result="Read History IA's goal and decisions" />
          <ToolRow on={at(frame, F.reading)} working={frame === F.reading} delay={450} tool="search_workspace" detail="“July Crisis”" result={`${JULY_CRISIS_TITLES} saved items`} />

          <p data-on={at(frame, F.reading)} className="m-fx text-[12px] leading-relaxed text-foreground" style={{ transitionDelay: "900ms" }}>
            Your own thesis points the way: the alliances shaped who joined, not whether war came. Build the argument on the decisions taken in Vienna and Berlin during the July Crisis.
          </p>

          <ToolRow on={at(frame, F.acting)} working={false} delay={0} tool="save_project_context" result="Decision saved to History IA" />
          <ToolRow on={at(frame, F.acting)} working={frame === F.acting} delay={500} tool="propose_organization" result="2 changes proposed · waiting for you in Hubble" />
          <p data-on={at(frame, F.acting)} className="m-fx text-[12px] leading-relaxed text-foreground" style={{ transitionDelay: "1000ms" }}>
            I&rsquo;ve saved that as a decision and proposed grouping the July Crisis sources. Approve it in Hubble and they&rsquo;ll move.
          </p>
        </div>
      </div>

      {/* The message box: Hubble for Chrome types the context in; the person sends it. */}
      <div className="px-4 pb-4 sm:px-6">
        <div className="mx-auto max-w-[520px] rounded-[12px] border border-strong bg-[var(--m-ground-2)] p-2.5">
          <div className="min-h-[38px] text-[11.5px] leading-relaxed">
            {frame === F.claude ? (
              <>
                <span className="m-mono block truncate text-[10.5px] text-tertiary">{preview[0]}</span>
                <span className="block truncate text-muted-foreground">{preview[2]}</span>
                <span className="block truncate text-foreground">
                  {REQUEST}
                  <span className="m-caret" />
                </span>
              </>
            ) : (
              <span className="text-tertiary">Reply to Claude…</span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className={cn("m-glow flex h-5 items-center gap-1 rounded-full border border-strong px-2 text-[10.5px] text-muted-foreground", frame !== F.claude && "invisible")}>
              <BrandMark className="size-3" /> Typed in by Hubble · not sent
            </span>
            <span className={cn("m-glow ml-auto flex size-6 items-center justify-center rounded-full", frame === F.claude ? "bg-foreground text-background" : "bg-[var(--m-ground-5)] text-tertiary")}>
              <ArrowUp className="size-3.5" />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** One call to Hubble's connector, as an AI app shows a tool it used: one line, its result at the end. */
function ToolRow({ on, working, delay, tool, detail, result }: { on: boolean; working: boolean; delay: number; tool: string; detail?: string; result: string }) {
  return (
    <div data-on={on} className="m-fx flex h-8 items-center gap-2 rounded-[7px] border border-subtle bg-[var(--m-ground-2)] px-2.5 text-[11px]" style={{ transitionDelay: `${delay}ms` }}>
      <BrandMark className="size-3.5" />
      <span className="m-mono shrink-0 text-foreground">{tool}</span>
      {detail && <span className="hidden shrink-0 text-muted-foreground sm:inline">{detail}</span>}
      <span className={cn("ml-auto min-w-0 truncate text-right", working ? "m-shimmer" : "text-muted-foreground")}>{working ? "Working…" : result}</span>
      {!working && <Check aria-hidden className="size-3 shrink-0 text-tertiary" />}
    </div>
  )
}

// ---------------------------------------------------------------- Rail

function LoopRail({
  chapter,
  frame,
  animated,
  playing,
  duration,
  run,
  onChapter,
}: {
  chapter: number
  frame: number
  animated: boolean
  playing: boolean
  duration: number
  run: number
  onChapter: (chapter: number) => void
}) {
  return (
    <ol aria-label="The Hubble loop" className="grid grid-cols-5 gap-2 sm:gap-4">
      {CHAPTERS.map((name, index) => {
        const frames = FRAME_CHAPTER.map((c, f) => ({ c, f })).filter((entry) => entry.c === index)
        const total = frames.reduce((sum, entry) => sum + (DURATIONS[entry.f] ?? 0), 0)
        const before = frames.filter((entry) => entry.f < frame).reduce((sum, entry) => sum + (DURATIONS[entry.f] ?? 0), 0)
        const from = total ? before / total : 0
        const to = total ? (before + (DURATIONS[frame] ?? 0)) / total : 1
        const active = index === chapter
        const done = index < chapter
        const barStyle: CSSProperties = active
          ? animated
            ? ({
                "--m-from": from,
                "--m-to": to,
                animation: `m-fill ${duration}ms linear both`,
                animationPlayState: playing ? "running" : "paused",
              } as CSSProperties)
            : ({ "--m-progress": 1 } as CSSProperties)
          : ({ "--m-progress": done ? 1 : 0 } as CSSProperties)
        return (
          <li key={name}>
            <button
              type="button"
              onClick={() => onChapter(index)}
              aria-current={active ? "step" : undefined}
              aria-label={`Show ${name}`}
              className="group flex w-full flex-col gap-2 rounded-xs pt-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="m-rail-bar w-full">
                <span key={active ? `${run}` : "idle"} style={barStyle} />
              </span>
              <span className="flex items-baseline gap-1.5 text-[12px] sm:text-[13px]">
                <span className="hidden text-tertiary tabular-nums sm:inline">0{index + 1}</span>
                <span className={cn("truncate transition-colors duration-300", active ? "text-foreground" : "text-tertiary group-hover:text-muted-foreground")}>{name}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
