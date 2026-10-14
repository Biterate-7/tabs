"use client"

import { useMemo, type ReactNode } from "react"
import { Check, ClipboardCopy, FileText, NotebookPen, Search } from "lucide-react"
import { ProviderBadge, ProviderMark } from "@/components/memory/provider-mark"
import { Highlighted } from "@/components/project/project-home"
import { buildMemoryBundle } from "@/lib/memory/bundle"
import { KNOWLEDGE_TYPE_LABEL, knowledgeItemsOf } from "@/lib/memory/items"
import { searchKnowledge } from "@/lib/memory/search"
import { describeLocation, searchTerms } from "@/lib/resources/search"
import { cn } from "@/lib/utils"
import { SAMPLE_CONTENTS, SAMPLE_WORKSPACE } from "./sample-knowledge"

/**
 * The landing page's product illustrations: small windows drawn with the
 * app's own palette (app-theme.tsx) and components, over a fixed sample
 * project (./sample-knowledge.ts). Search and the context text are computed
 * by the product's own code — nothing is mocked up by hand — and nothing on
 * the page reads or writes anyone's data.
 */

const SAMPLE_CONTENT_MAP = new Map([[SAMPLE_WORKSPACE.id, SAMPLE_CONTENTS]])

function Window({ label, title, className, children }: { label: string; title: string; className?: string; children: ReactNode }) {
  return (
    <figure aria-label={label} data-hubble-illustration="" className={cn("m-app m-demo-window flex-col", className)}>
      <figcaption className="flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-3 text-meta text-tertiary">
        <span aria-hidden className="flex gap-1">
          <span className="size-2 rounded-full bg-surface-active" />
          <span className="size-2 rounded-full bg-surface-active" />
          <span className="size-2 rounded-full bg-surface-active" />
        </span>
        <span className="truncate">{title}</span>
        <span className="ml-auto rounded-xs border border-subtle px-1.5 text-[11px]">Sample</span>
      </figcaption>
      <div className="min-h-0 flex-1 overflow-hidden p-4">{children}</div>
    </figure>
  )
}

/** A project's knowledge: conversations from two AI apps beside a reading and a note. */
export function KnowledgeIllustration({ className }: { className?: string }) {
  const items = useMemo(() => knowledgeItemsOf(SAMPLE_WORKSPACE), [])
  return (
    <Window label="Sample Hubble project with AI conversations from ChatGPT and Claude, a PDF and a note." title="History IA" className={className}>
      <p className="text-h1 text-foreground">{SAMPLE_WORKSPACE.name}</p>
      <p className="text-body-sm text-muted-foreground">{SAMPLE_WORKSPACE.brief?.description}</p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0 items-start gap-2.5 rounded-md border border-subtle bg-card p-3">
            {item.provider ? (
              <ProviderMark provider={item.provider} size={16} className="mt-0.5 text-muted-foreground" />
            ) : item.type === "note" ? (
              <NotebookPen aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-body-sm text-foreground">{item.title}</span>
              <span className="flex items-center gap-1 text-meta text-tertiary">
                {item.provider ? <ProviderBadge provider={item.provider} /> : <span>{item.domain ?? "Your words"}</span>}
                <span>· {KNOWLEDGE_TYPE_LABEL[item.type]}</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Window>
  )
}

/** Saving the conversation on screen with Hubble for Chrome. */
export function CaptureIllustration({ className }: { className?: string }) {
  return (
    <Window label="Hubble for Chrome on a ChatGPT conversation, saving it to a project." title="chatgpt.com — Causes of WW1" className={className}>
      <div className="flex h-full gap-4">
        <div className="hidden min-w-0 flex-1 flex-col gap-2 sm:flex" aria-hidden>
          <p className="ml-auto max-w-[80%] rounded-md bg-surface-hover px-3 py-2 text-body-sm text-foreground">What were the main causes of the First World War?</p>
          <p className="max-w-[90%] rounded-md border border-subtle px-3 py-2 text-body-sm text-muted-foreground">Historians usually group them as militarism, alliances, imperialism and nationalism…</p>
        </div>
        <div className="w-full shrink-0 rounded-md border border-strong bg-popover p-3 shadow-sm sm:w-64">
          <p className="flex items-center gap-1.5 text-body-sm text-foreground">
            <ProviderMark provider="chatgpt" size={14} /> Save to Hubble
          </p>
          <p className="mt-2 truncate text-meta text-muted-foreground">Causes of WW1 · 4 turns</p>
          <p className="mt-2 text-meta text-tertiary">Project</p>
          <p className="rounded-xs border border-subtle px-2 py-1 text-body-sm text-foreground">History IA</p>
          <p className="mt-3 flex items-center gap-1.5 text-meta text-foreground">
            <Check aria-hidden className="size-3.5" /> Saved to History IA
          </p>
          <p className="mt-1 text-meta text-tertiary">Only this conversation, only when you ask.</p>
        </div>
      </div>
    </Window>
  )
}

const SAMPLE_QUERY = "alliance system"

/** One search, across both AI apps — run by the product's own search. */
export function SearchIllustration({ className }: { className?: string }) {
  const hits = useMemo(() => searchKnowledge({ query: SAMPLE_QUERY, workspaces: [SAMPLE_WORKSPACE], contents: SAMPLE_CONTENT_MAP, limit: 4 }), [])
  const terms = searchTerms(SAMPLE_QUERY)
  return (
    <Window label="Hubble search finding 'alliance system' in conversations from ChatGPT and Claude, a PDF and a note." title="Search your knowledge" className={className}>
      <p className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-body text-foreground">
        <Search aria-hidden className="size-4 text-tertiary" /> {SAMPLE_QUERY}
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-subtle rounded-md border border-subtle">
        {hits.map((hit) => (
          <li key={hit.item?.id} className="flex flex-col gap-0.5 p-3">
            <span className="flex items-center gap-2 text-body-sm text-foreground">
              <span className="truncate">{hit.item?.title}</span>
              <span className="shrink-0 text-meta text-tertiary">{describeLocation(hit.location)}</span>
            </span>
            <span className="text-meta text-muted-foreground">
              <Highlighted text={hit.snippet} terms={terms} />
            </span>
            <span className="flex items-center gap-2 text-meta text-tertiary">
              {hit.item?.provider ? <ProviderBadge provider={hit.item.provider} /> : null}
              <span>{hit.item ? KNOWLEDGE_TYPE_LABEL[hit.item.type] : ""}</span>
            </span>
          </li>
        ))}
      </ul>
    </Window>
  )
}

/** The context text Hubble prepares for the next AI chat — built by the product's own bundle code. */
export function ReuseIllustration({ className }: { className?: string }) {
  const bundle = useMemo(
    () =>
      buildMemoryBundle({
        workspace: SAMPLE_WORKSPACE,
        refs: [
          { kind: "note", noteId: "note-thesis" },
          { kind: "source", tabId: "chat-gpt" },
          { kind: "source", tabId: "chat-claude" },
          { kind: "source", tabId: "pdf-clark" },
        ],
        contents: SAMPLE_CONTENTS,
        request: "Help me argue that the alliance system was not the main cause",
        budget: 5_000,
      }),
    []
  )
  return (
    <Window label="Context prepared by Hubble for a new AI chat, quoting a note, a ChatGPT and a Claude conversation and a PDF, each with where it came from." title="Use in an AI chat" className={className}>
      <div className="flex h-full flex-col gap-2">
        <pre className="min-h-0 flex-1 overflow-hidden rounded-md border border-subtle bg-background p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{bundle.text}</pre>
        <p className="flex items-center justify-between gap-2 text-meta text-tertiary">
          <span>You choose what goes in, and see exactly what the AI app receives.</span>
          <span className="flex shrink-0 items-center gap-1 rounded-xs bg-primary px-2 py-1 text-primary-foreground">
            <ClipboardCopy aria-hidden className="size-3" /> Copy
          </span>
        </p>
      </div>
    </Window>
  )
}
