"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, MessageSquareShare } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { ProviderMark } from "@/components/memory/provider-mark"
import { KindGlyph } from "@/components/ui/kind-glyph"
import { buildMemoryBundle } from "@/lib/memory/bundle"
import { findKnowledgeItem, type KnowledgeItemRef } from "@/lib/memory/items"
import { itemKind } from "@/lib/memory/kinds"
import { AI_PROVIDER_IDS, AI_PROVIDERS, type AiProviderId } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import { SAMPLE_CONTENTS, SAMPLE_WORKSPACE } from "../sample-knowledge"
import { useTimeline } from "./use-timeline"
import { AddressBar, DemoWindow } from "./window"

/*
 * Handing off: the person picks what to bring, and Hubble writes it up for
 * whichever AI app they choose — the same text every time, built by the
 * product's own bundle code (lib/memory/bundle.ts), with each app's own new
 * chat address and Hubble's own size bound for it from the provider
 * registry. The text lands in the app's message box; sending is the
 * person's choice.
 */

const CHOSEN: KnowledgeItemRef[] = [
  { kind: "note", noteId: "note-thesis" },
  { kind: "source", tabId: "chat-gpt" },
  { kind: "source", tabId: "chat-claude" },
  { kind: "source", tabId: "pdf-clark" },
]
const REQUEST = "Help me argue that the alliance system was not the main cause"
const TARGETS: readonly AiProviderId[] = AI_PROVIDER_IDS.filter((id) => AI_PROVIDERS[id].capabilities.insert.supported)
const DURATIONS = TARGETS.map(() => 4800)

export function HandoffDemo() {
  const { attach, frame, animated, run, go: goTo } = useTimeline({ durations: DURATIONS, restFrame: 1 % Math.max(1, TARGETS.length), startFrame: 0 })
  const target = TARGETS[frame] ?? TARGETS[0]!
  const provider = AI_PROVIDERS[target]
  const bundle = useMemo(() => buildMemoryBundle({ workspace: SAMPLE_WORKSPACE, refs: CHOSEN, contents: SAMPLE_CONTENTS, request: REQUEST, budget: 5_000 }), [])
  const lines = useMemo(() => bundle.text.split("\n"), [bundle.text])
  const shown = useLines(lines.length, animated, run)
  const home = new URL(provider.homeUrl)
  const fits = bundle.chars <= provider.transfer.messageChars

  return (
    <div ref={attach} className="flex flex-col gap-4" data-handoff-demo="" data-target={target}>
      <div role="group" aria-label="Choose the AI app" className="flex flex-wrap justify-center gap-1.5">
        {TARGETS.map((id, index) => (
          <button
            key={id}
            type="button"
            onClick={() => goTo(index)}
            aria-pressed={id === target}
            className={cn(
              "m-glow flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              id === target ? "border-strong bg-[var(--m-ground-5)] text-foreground" : "border-subtle bg-[var(--m-ground-2)] text-muted-foreground hover:text-foreground"
            )}
          >
            <ProviderMark provider={id} size={14} />
            {AI_PROVIDERS[id].name}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-4">
        {/* Hubble: what goes in */}
        <DemoWindow label={`Hubble's Use in AI, preparing four items from History IA for ${provider.name}.`} title="Hubble — Use in AI" className="h-[300px] lg:h-[440px]">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <p className="flex items-center gap-2 text-[13px] text-foreground">
              <MessageSquareShare aria-hidden className="size-4 text-muted-foreground" /> Use in AI
            </p>
            <ul className="mt-3 flex flex-col gap-1">
              {CHOSEN.map((ref) => {
                const item = findKnowledgeItem(SAMPLE_WORKSPACE, ref)
                if (!item) return null
                return (
                  <li key={item.id} className="flex h-8 items-center gap-2.5 rounded-[5px] bg-[var(--m-ground-3)] px-2.5">
                    <span aria-hidden className="flex size-3.5 items-center justify-center rounded-[3px] bg-foreground">
                      <Check className="size-2.5 text-background" strokeWidth={3} />
                    </span>
                    <span aria-hidden className="flex size-4 items-center justify-center text-muted-foreground">
                      {item.provider ? <ProviderMark provider={item.provider} size={14} /> : <KindGlyph kind={itemKind(item)} type={item.type} className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{item.title}</span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-3 text-[11px] text-tertiary">What do you want to do?</p>
            <p className="mt-1 rounded-[5px] border border-subtle px-2.5 py-1.5 text-[12px] text-foreground">{REQUEST}</p>
            <div className="mt-auto hidden flex-col gap-2 pt-3 lg:flex">
              <p className="flex items-center justify-between text-[11px] text-tertiary">
                <span>{bundle.chars.toLocaleString("en-US")} characters</span>
                <span>{fits ? "Fits in one message" : "Too long for one message"}</span>
              </p>
              <span key={target} className="m-rise flex h-8 items-center justify-center gap-2 rounded-[5px] bg-foreground text-[12.5px] text-background">
                <ProviderMark provider={target} size={13} /> Open in {provider.name}
              </span>
            </div>
          </div>
        </DemoWindow>

        {/* The AI app: what arrives */}
        <DemoWindow
          label={`${provider.name} in Chrome, a new chat with Hubble's context typed into the message box and not yet sent.`}
          title={provider.name}
          bar={<AddressBar host={home.host} path={home.pathname === "/" ? "" : home.pathname} />}
          className="h-[380px] lg:h-[440px]"
        >
          <div className="flex min-h-0 flex-1 flex-col bg-[var(--m-ground)] p-4">
            <div key={target} className="m-rise flex items-center gap-2 text-[13px] text-foreground">
              <ProviderMark provider={target} size={18} /> New chat
            </div>
            <div className="mt-3 flex min-h-0 flex-1 flex-col rounded-[12px] border border-strong bg-[var(--m-ground-2)] p-3">
              <pre className="m-mono min-h-0 flex-1 overflow-hidden text-[10.5px] leading-[1.6] whitespace-pre-wrap text-muted-foreground [mask-image:linear-gradient(to_bottom,transparent,#000_28%)]">
                {lines.slice(Math.max(0, shown - 18), shown).join("\n")}
                {animated && shown < lines.length && <span className="m-caret" />}
              </pre>
              <div className="mt-2 flex items-center gap-2 border-t border-subtle pt-2">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <BrandMark className="size-3.5" /> {shown >= lines.length ? "Typed in by Hubble — checked it arrived" : "Typing…"}
                </span>
                <span className="ml-auto text-[11px] text-tertiary">You press send</span>
              </div>
            </div>
          </div>
        </DemoWindow>
      </div>
    </div>
  )
}

/** Lines of the context appearing a few at a time, as Hubble types them; all at once without motion. */
function useLines(total: number, animated: boolean, run: number): number {
  const [count, setCount] = useState(total)
  useEffect(() => {
    if (!animated) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no motion: the whole text at once
      setCount(total)
      return
    }
    setCount(0)
    let n = 0
    const id = window.setInterval(() => {
      n += 1
      setCount(n)
      if (n >= total) window.clearInterval(id)
    }, 62)
    return () => window.clearInterval(id)
  }, [total, animated, run])
  return count
}
