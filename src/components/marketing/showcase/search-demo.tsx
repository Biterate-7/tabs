"use client"

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { Search } from "lucide-react"
import { ProviderMark } from "@/components/memory/provider-mark"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { KNOWLEDGE_TYPE_LABEL, type KnowledgeItem } from "@/lib/memory/items"
import { itemKind } from "@/lib/memory/kinds"
import { searchKnowledge, type KnowledgeHit } from "@/lib/memory/search"
import { aiProviderName } from "@/lib/providers/registry"
import { describeLocation, markMatches, searchTerms } from "@/lib/resources/search"
import { cn } from "@/lib/utils"
import { SAMPLE_CONTENT_MAP, SAMPLE_CONTENTS, SAMPLE_WORKSPACE } from "../sample-knowledge"
import { useTimeline } from "./use-timeline"
import { DemoWindow, Kbd } from "./window"

/*
 * Workspace intelligence: one search across every conversation, page, PDF
 * and note in the project, whichever AI app they came from. Each query is
 * run by the product's own search (lib/memory/search.ts) over the sample
 * project; the preview opens the result at the passage that matched.
 *
 * It types its way through four questions on its own; the chips under the
 * field let the visitor ask any of them.
 */

const QUERIES = ["alliance system", "July Crisis", "Italy", "Sarajevo"] as const
const DURATIONS = [5200, 5200, 4600, 4800] as const

export function SearchDemo() {
  const { attach, frame, animated, run, go: goTo } = useTimeline({ durations: DURATIONS, restFrame: 0, startFrame: 0 })
  const query = QUERIES[frame] ?? QUERIES[0]
  const typed = useTyped(query, animated, run)
  const done = typed === query
  const results = useMemo(
    () =>
      QUERIES.map((q) => ({
        query: q,
        hits: searchKnowledge({ query: q, workspaces: [SAMPLE_WORKSPACE], contents: SAMPLE_CONTENT_MAP, limit: 5 }),
      })),
    []
  )
  const hits = results[frame]?.hits ?? []
  const terms = searchTerms(query)
  const top = hits[0]

  return (
    <DemoWindow
      label={`Hubble search over the sample project, finding “${query}” in conversations from ChatGPT, Claude, Gemini and Perplexity, a PDF, a web page and a note.`}
      title="Hubble — Search"
      className="h-[540px] md:h-[560px]"
    >
      <div ref={attach} className="flex min-h-0 flex-1 flex-col" data-search-demo="" data-query={query}>
        <div className="border-b border-subtle p-3 sm:p-4">
          <div className="flex h-10 items-center gap-2.5 rounded-[7px] border border-strong bg-[var(--m-ground-2)] px-3 text-[13.5px]">
            <Search aria-hidden className="size-4 shrink-0 text-tertiary" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {typed}
              {animated && <span className="m-caret" />}
            </span>
            <span className="hidden shrink-0 text-[11px] text-tertiary sm:inline">All projects</span>
            <span className="hidden sm:inline">
              <Kbd>Enter</Kbd>
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Try a search">
            {QUERIES.map((q, index) => (
              <button
                key={q}
                type="button"
                onClick={() => goTo(index)}
                aria-pressed={q === query}
                className={cn(
                  "m-glow h-6 rounded-full border px-2.5 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  q === query ? "border-strong bg-[var(--m-ground-5)] text-foreground" : "border-subtle text-muted-foreground hover:border-strong hover:text-foreground"
                )}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
          <div className="min-h-0 overflow-hidden">
            <p className="px-4 pt-3 pb-1 text-[11px] text-tertiary">
              <span data-on={done} className="m-fx m-fx-fade inline-block">
                {hits.length} results in History IA
              </span>
            </p>
            <ul key={`${query}-${run}`} className="flex flex-col" aria-label={`Results for ${query}`}>
              {hits.map((hit, index) => (
                <Result key={hit.item?.id ?? index} hit={hit} terms={terms} selected={index === 0} show={done} index={index} />
              ))}
            </ul>
          </div>
          <div className="hidden min-h-0 border-l border-subtle bg-[var(--m-ground-2)] lg:block">
            {top?.item && (
              <Preview key={`${query}-${run}`} hit={top} item={top.item} terms={terms} show={done} />
            )}
          </div>
        </div>
      </div>
    </DemoWindow>
  )
}

function Result({ hit, terms, selected, show, index }: { hit: KnowledgeHit; terms: readonly string[]; selected: boolean; show: boolean; index: number }) {
  const item = hit.item
  if (!item) return null
  const where = describeLocation(hit.location)
  return (
    <li
      data-on={show}
      className={cn("m-fx flex gap-2.5 border-b border-subtle px-4 py-2.5", selected && "bg-[var(--m-ground-3)]")}
      style={{ transitionDelay: `${index * 70}ms` } as CSSProperties}
    >
      <Mark item={item} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[12.5px] text-foreground">{item.title}</span>
          {where && <span className="shrink-0 text-[11px] text-tertiary">{where}</span>}
        </span>
        <span className="mt-0.5 line-clamp-2 text-[11.5px] leading-[1.5] text-muted-foreground">
          <Marked text={hit.snippet} terms={terms} />
        </span>
        <span className="mt-0.5 block text-[10.5px] text-tertiary">
          {item.provider ? aiProviderName(item.provider) : item.type === "note" ? "Your words" : item.domain} · {KNOWLEDGE_TYPE_LABEL[item.type]}
        </span>
      </span>
    </li>
  )
}

/** The result opened where it matched: the turn of the conversation, the page of the PDF. */
function Preview({ hit, item, terms, show }: { hit: KnowledgeHit; item: KnowledgeItem; terms: readonly string[]; show: boolean }) {
  const passage = passageOf(hit, item)
  return (
    <div data-on={show} className="m-fx flex h-full flex-col p-4" style={{ transitionDelay: "160ms" }}>
      <div className="flex items-center gap-2">
        <Mark item={item} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{item.title}</span>
      </div>
      <p className="mt-0.5 pl-[26px] text-[11px] text-tertiary">
        {item.provider ? aiProviderName(item.provider) : item.domain ?? "Your note"} · {KNOWLEDGE_TYPE_LABEL[item.type]}
      </p>
      {passage.context && <p className="mt-4 text-[11.5px] leading-relaxed text-tertiary">{passage.context}</p>}
      <div className={cn("mt-3 rounded-[10px] px-3 py-2.5 text-[12px] leading-relaxed", passage.speaker === "user" ? "ml-6 bg-[var(--m-ground-5)] text-foreground" : "border border-subtle bg-[var(--m-ground)] text-muted-foreground")}>
        {passage.label && <span className="mb-1 block text-[10.5px] text-tertiary">{passage.label}</span>}
        <Marked text={passage.text} terms={terms} />
      </div>
      <p className="mt-auto pt-3 text-[11px] text-tertiary">Opens here in Hubble, or in {item.provider ? aiProviderName(item.provider) : "its page"}.</p>
    </div>
  )
}

function passageOf(hit: KnowledgeHit, item: KnowledgeItem): { text: string; label?: string; context?: string; speaker?: "user" | "assistant" } {
  const content = SAMPLE_CONTENTS.get(item.id)
  if (!content) return { text: hit.snippet }
  if (content.kind === "conversation") {
    const turns = content.turns ?? []
    const index = hit.location.kind === "turn" ? hit.location.turn : Math.max(0, turns.findIndex((turn) => turn.role === "assistant"))
    const turn = turns[index] ?? turns[0]
    if (!turn) return { text: hit.snippet }
    const previous = index > 0 ? turns[index - 1] : undefined
    const name = item.provider ? aiProviderName(item.provider) : "AI"
    return {
      text: turn.text,
      label: turn.role === "user" ? "You" : name,
      context: previous && previous.role === "user" ? `You: ${previous.text}` : undefined,
      speaker: turn.role === "user" ? "user" : "assistant",
    }
  }
  if (content.kind === "pdf") {
    const page = hit.location.kind === "page" ? hit.location.page : 1
    const pages = content.pages ?? []
    return { text: pages[page - 1] ?? pages[0] ?? hit.snippet, label: `Page ${page}` }
  }
  if ("text" in content && typeof content.text === "string") return { text: content.text, label: item.type === "note" ? "Your note" : undefined }
  return { text: hit.snippet }
}

function Mark({ item }: { item: KnowledgeItem }) {
  return (
    <span aria-hidden className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      {item.provider ? <ProviderMark provider={item.provider} size={15} /> : <KindGlyph kind={itemKind(item)} type={item.type} className="size-3.5" />}
    </span>
  )
}

/** The product's match marking (lib/resources/search.ts markMatches), drawn as the app draws it. */
function Marked({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  return markMatches(text, terms).map((part, index) =>
    part.match ? (
      <mark key={index} className="rounded-xs bg-[var(--m-ground-5)] px-0.5 text-foreground">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    )
  )
}

/**
 * Types `text` out a character at a time while motion is on; everyone else
 * sees it whole. Restarts whenever `run` changes.
 */
function useTyped(text: string, animated: boolean, run: number): string {
  const [count, setCount] = useState(text.length)
  useEffect(() => {
    if (!animated) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no motion: the whole query at once
      setCount(text.length)
      return
    }
    setCount(0)
    let n = 0
    const id = window.setInterval(() => {
      n += 1
      setCount(n)
      if (n >= text.length) window.clearInterval(id)
    }, 55)
    return () => window.clearInterval(id)
  }, [text, animated, run])
  return text.slice(0, count)
}
