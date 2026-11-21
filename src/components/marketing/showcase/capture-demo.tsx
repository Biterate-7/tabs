"use client"

import { useMemo, type CSSProperties } from "react"
import { Check } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { ProviderMark } from "@/components/memory/provider-mark"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { KNOWLEDGE_TYPE_LABEL, knowledgeItemsOf, type KnowledgeItem } from "@/lib/memory/items"
import { itemKind } from "@/lib/memory/kinds"
import { searchKnowledge } from "@/lib/memory/search"
import { aiProviderName } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import { SAMPLE_CONTENT_MAP, SAMPLE_WORKSPACE } from "../sample-knowledge"
import { useTimeline } from "./use-timeline"

/*
 * Context reconstruction: six tabs — four AI apps, a PDF, a web page — saved
 * one by one into a project, each line drawing from where it was to where it
 * now lives, until the project holds the whole piece of work and its own
 * search shows the threads that run through it.
 *
 * Desktop draws the connecting lines; it knows the geometry because the
 * rows are a fixed height. Narrower screens stack the tabs above the
 * project and drop the lines rather than squeezing them.
 */

/** Frame at which each source (in SOURCE order) is saved. */
const SAVED_AT = [2, 3, 3, 4, 4, 4] as const
const DURATIONS = [1300, 1500, 1700, 1800, 2000, 5200] as const
const DONE = DURATIONS.length - 1
const SOURCES = ["chat-gpt", "chat-claude", "pdf-clark", "chat-gemini", "page-sarajevo", "chat-perplexity"] as const
const THREADS = ["July Crisis", "alliance system", "Sarajevo"] as const

// Fixed geometry (px) shared by the cards, the rows and the lines between
// them, measured from the top of the scene: 58px cards 10px apart; the
// window's 34px bar, 58px header and 1px rule, then 40px rows.
const CARD_H = 58
const CARD_GAP = 10
const COLUMN_H = SOURCES.length * CARD_H + (SOURCES.length - 1) * CARD_GAP
const LIST_TOP = 34 + 58 + 1
const ROW_H = 40
const cardY = (index: number) => CARD_H / 2 + index * (CARD_H + CARD_GAP)
const rowY = (index: number) => LIST_TOP + ROW_H / 2 + index * ROW_H

export function CaptureDemo() {
  const { attach, frame } = useTimeline({ durations: DURATIONS, restFrame: DONE, startFrame: 0 })
  const items = useMemo(() => knowledgeItemsOf(SAMPLE_WORKSPACE), [])
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const note = items.find((item) => item.type === "note")
  const threads = useMemo(
    () => THREADS.map((query) => ({ query, count: searchKnowledge({ query, workspaces: [SAMPLE_WORKSPACE], contents: SAMPLE_CONTENT_MAP }).length })),
    []
  )
  const saved = (index: number) => frame >= (SAVED_AT[index] ?? 0)
  const providers = new Set(items.flatMap((item) => (item.provider ? [item.provider] : [])))

  return (
    <figure
      ref={attach}
      aria-label="Six browser tabs — conversations in ChatGPT, Claude, Gemini and Perplexity, a PDF and a web page — saved one by one into the Hubble project History IA, which then shows the topics they share."
      data-hubble-illustration=""
      className="m-app relative px-3 pt-5 pb-3 sm:px-6 sm:pt-6 sm:pb-6"
      data-capture-demo=""
      data-frame={frame}
    >
      <div className="relative grid gap-4 md:grid-cols-[minmax(0,1fr)_56px_minmax(0,1.2fr)] md:items-start md:gap-0">
        {/* The tabs, where the work happened */}
        <ul aria-label="Browser tabs" className="grid grid-cols-2 gap-2 md:flex md:flex-col md:gap-[10px] md:pt-0">
          {SOURCES.map((id, index) => {
            const item = byId.get(id)
            if (!item) return null
            const isSaved = saved(index)
            const saving = frame === 1 && index === 0
            return (
              <li
                key={id}
                data-saved={isSaved}
                className="m-glow relative flex min-w-0 flex-col justify-center gap-0.5 rounded-[8px] border border-subtle bg-[var(--m-window)] px-2.5 shadow-[0_12px_30px_-12px_rgb(0_0_0/0.8)] data-[saved=true]:border-strong md:h-[58px]"
              >
                <span className="flex min-w-0 items-center gap-1.5 py-1.5 md:py-0">
                  <SourceMark item={item} size={13} />
                  <span className="truncate text-[11px] text-tertiary">{item.domain}</span>
                  <span data-on={isSaved} className="m-fx m-fx-fade ml-auto flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground">
                    <Check aria-hidden className="size-3" /> <span className="hidden sm:inline">Saved</span>
                  </span>
                </span>
                <span className="hidden truncate text-[12px] text-foreground md:block">{item.title}</span>

                {/* Hubble for Chrome, saving the conversation on screen. */}
                {index === 0 && (
                  <span
                    data-on={saving}
                    aria-hidden
                    className="m-fx absolute top-[calc(100%+6px)] left-2 z-10 w-[220px] rounded-[8px] border border-strong bg-[var(--m-ground-3)] p-2.5 shadow-[0_20px_40px_-12px_rgb(0_0_0/0.9)] md:top-1 md:left-[calc(100%+10px)]"
                  >
                    <span className="flex items-center gap-1.5 text-[11.5px] text-foreground">
                      <BrandMark className="size-3.5" /> Save to Hubble
                    </span>
                    <span className="mt-1 block truncate text-[10.5px] text-tertiary">
                      {item.title} · {item.turns} turns
                    </span>
                    <span className="mt-2 flex h-6 items-center justify-between rounded-[4px] border border-subtle px-2 text-[11px] text-muted-foreground">
                      History IA <span className="text-tertiary">Project</span>
                    </span>
                    <span className="mt-1.5 flex h-6 items-center justify-center rounded-[4px] bg-foreground text-[11px] text-background">Save</span>
                  </span>
                )}
              </li>
            )
          })}
        </ul>

        {/* The lines from each tab to where it now lives */}
        <svg aria-hidden className="pointer-events-none hidden w-full md:block" style={{ height: COLUMN_H }} viewBox={`0 0 100 ${COLUMN_H}`} preserveAspectRatio="none">
          {SOURCES.map((id, index) => {
            const from = cardY(index)
            const to = rowY(index)
            return (
              <path
                key={id}
                d={`M0 ${from} C 55 ${from}, 45 ${to}, 100 ${to}`}
                pathLength={1}
                data-on={saved(index)}
                className="m-draw"
                fill="none"
                stroke="var(--m-line-strong)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ transitionDelay: `${(index % 3) * 140}ms` } as CSSProperties}
              />
            )
          })}
        </svg>

        {/* The project, filling up */}
        <div className="m-window">
          <div className="m-window-bar">
            <span aria-hidden className="m-window-dots">
              <span />
              <span />
              <span />
            </span>
            <span className="flex-1 truncate pr-[42px] text-center">Hubble — History IA</span>
          </div>
          <div className="flex h-[58px] items-center gap-3 px-4">
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] leading-tight tracking-[-0.01em] text-foreground">History IA</span>
              <span className="block truncate text-[11.5px] text-tertiary">{SAMPLE_WORKSPACE.brief?.description}</span>
            </span>
            <span className="shrink-0 text-[11px] text-tertiary tabular-nums">
              {SOURCES.filter((_, index) => saved(index)).length + (frame >= DONE ? 1 : 0)} items
            </span>
          </div>
          <ul aria-label="Saved to History IA" className="relative border-t border-subtle">
            {frame === 0 && <li className="absolute inset-x-0 top-0 flex h-10 items-center px-4 text-[12px] text-tertiary">Nothing saved yet</li>}
            {[...SOURCES.map((id) => byId.get(id)), note].map((item, index) => {
              if (!item) return null
              const on = index < SOURCES.length ? saved(index) : frame >= DONE
              return (
                <li key={item.id} data-on={on} className="m-fx flex h-10 items-center gap-2.5 border-b border-subtle px-4 last:border-b-0" style={{ transitionDelay: `${(index % 3) * 140 + 380}ms` } as CSSProperties}>
                  <SourceMark item={item} size={14} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{item.title}</span>
                  <span className="hidden shrink-0 text-[11px] text-tertiary sm:inline">
                    {item.provider ? aiProviderName(item.provider) : item.type === "note" ? "Your words" : item.domain} · {KNOWLEDGE_TYPE_LABEL[item.type]}
                  </span>
                </li>
              )
            })}
          </ul>
          {/* What runs through it — counted by the project's own search. */}
          <div data-on={frame >= DONE} className="m-grow">
            <div>
              <div className="border-t border-subtle px-4 py-3">
                <p className="text-[11px] text-tertiary">
                  From {[...providers].map((id) => aiProviderName(id)).join(", ")} — and found in more than one place
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {threads.map((thread, index) => (
                    <span
                      key={thread.query}
                      data-on={frame >= DONE}
                      className="m-fx flex h-6 items-center gap-1.5 rounded-full border border-subtle bg-[var(--m-ground-3)] px-2.5 text-[11px] text-foreground"
                      style={{ transitionDelay: `${500 + index * 120}ms` } as CSSProperties}
                    >
                      “{thread.query}” <span className="text-tertiary tabular-nums">{thread.count} items</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </figure>
  )
}

function SourceMark({ item, size }: { item: KnowledgeItem; size: number }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center text-muted-foreground")} style={{ width: size, height: size }}>
      {item.provider ? <ProviderMark provider={item.provider} size={size} /> : <KindGlyph kind={itemKind(item)} type={item.type} className="size-full" />}
    </span>
  )
}
