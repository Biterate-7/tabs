"use client"

import type { CSSProperties, ReactNode } from "react"
import { Globe, Layers, Monitor } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"
import { ProviderMark } from "@/components/memory/provider-mark"
import { AI_PROVIDER_IDS, AI_PROVIDERS, type AiProvider } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"

/*
 * The page's quieter sections: the row of apps Hubble works with, the loop
 * band, and the cards for the app and its Chrome companion. Claims come from the provider
 * registry (lib/providers/registry.ts) — the only place Hubble records what
 * it can do with each AI app — so this page cannot say more than the product
 * does.
 */

/** What Hubble does with an AI app, in the fewest words, from its registry entry. */
export function capabilityLine(provider: AiProvider): string {
  const { pageCapture, exportImport, insert, connector } = provider.capabilities
  return [pageCapture.supported && "Save", exportImport.supported && "Import", insert.supported && "Use in AI", connector.supported && "Connector"].filter(Boolean).join(" · ")
}

export function WorksWith() {
  const tiles: { name: string; note: string; mark: ReactNode }[] = [
    ...AI_PROVIDER_IDS.map((id) => ({ name: AI_PROVIDERS[id].name, note: capabilityLine(AI_PROVIDERS[id]), mark: <ProviderMark provider={id} size={22} /> })),
    { name: "Desktop", note: "The Hubble app", mark: <Monitor aria-hidden className="size-[22px] text-foreground" strokeWidth={1.5} /> },
    { name: "Chrome", note: "Companion extension", mark: <Globe aria-hidden className="size-[22px] text-foreground" strokeWidth={1.5} /> },
  ]
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <li key={tile.name} className="m-tile flex h-[124px] flex-col items-center justify-center gap-2 px-3 text-center" data-works-with={tile.name}>
          <span className="flex items-center gap-2.5 text-foreground">
            {tile.mark}
            <span className="text-[18px] leading-none tracking-[-0.02em] whitespace-nowrap">{tile.name}</span>
          </span>
          <span className="m-small flex min-h-[2lh] items-start text-[12px] leading-[1.45] text-balance text-tertiary">{tile.note}</span>
        </li>
      ))}
    </ul>
  )
}

export const LOOP_STEPS = [
  { name: "Workspace", body: "Conversations, sources and notes, kept in projects on your device." },
  { name: "Context", body: "Choose what matters. Hubble writes it up, quoted with where it came from." },
  { name: "Agent", body: "ChatGPT, Claude, Gemini or Perplexity picks up from there." },
  { name: "Action", body: "Connected apps save notes and decisions, and propose changes." },
  { name: "Review", body: "Nothing is reorganised until you approve it. Every call is logged." },
] as const

/** Workspace → Context → Agent → Action → Review, with a light travelling through it. */
export function LoopBand() {
  return (
    <div className="relative">
      <div aria-hidden className="relative mb-3 hidden h-px overflow-hidden bg-[var(--m-line)] lg:block">
        <span className="m-loop-runner absolute inset-y-0 left-0 w-1/5 bg-[linear-gradient(90deg,transparent,var(--m-ink),transparent)] opacity-70" />
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {LOOP_STEPS.map((step, index) => (
          <li
            key={step.name}
            className="m-loop-step relative flex min-h-[180px] flex-col rounded-[4px] bg-[var(--card)] p-5 lg:min-h-[232px]"
            style={{ "--m-step": index } as CSSProperties}
          >
            <span className="flex items-center gap-2.5">
              <span aria-hidden className="m-loop-dot size-1.5 rounded-full bg-[var(--m-ink-4)]" />
              <span className="m-small text-tertiary tabular-nums">0{index + 1}</span>
            </span>
            <h3 className="m-title mt-auto text-foreground">{step.name}</h3>
            <p className="m-small mt-1.5 min-h-[3lh] text-muted-foreground">{step.body}</p>
            <p aria-hidden={index !== LOOP_STEPS.length - 1} className={cn("m-small mt-3 text-tertiary", index !== LOOP_STEPS.length - 1 && "invisible")}>
              → back to the workspace
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** One of the places Hubble runs: words above, a small piece of the product below. */
export function SurfaceCard({ title, body, link, children }: { title: string; body: string; link?: ReactNode; children: ReactNode }) {
  return (
    <article className="m-tile flex flex-col p-[18px]">
      <h3 className="m-body text-foreground">{title}</h3>
      <p className="m-body text-muted-foreground md:min-h-[2lh]">{body}</p>
      {link && <div className="mt-3">{link}</div>}
      <div className="m-stage mt-5 flex h-[260px] items-center justify-center p-5 sm:h-[300px] sm:p-6">{children}</div>
    </article>
  )
}

/** Hubble for Chrome's popup on an AI conversation. */
export function ExtensionVisual() {
  return (
    <div aria-hidden className="m-app m-window w-full max-w-[260px] p-3">
      <p className="flex items-center gap-2 text-[12px] text-foreground">
        <BrandMark className="size-4" /> Hubble
        <span className="ml-auto flex items-center gap-1 text-[10.5px] text-tertiary">
          <ProviderMark provider="chatgpt" size={11} /> chatgpt.com
        </span>
      </p>
      <span className="mt-3 flex h-7 items-center justify-center rounded-[4px] bg-foreground text-[11.5px] text-background">Save to Hubble</span>
      <span className="mt-1.5 flex h-7 items-center justify-center gap-1.5 rounded-[4px] border border-strong text-[11.5px] text-foreground">
        <Layers className="size-3" /> Save tabs as a session
      </span>
      <p className="mt-2.5 text-[10.5px] text-tertiary">Only this page, only when you ask.</p>
    </div>
  )
}

/** Hubble Desktop's window. */
export function DesktopVisual() {
  return (
    <div aria-hidden className="m-app m-window w-full max-w-[300px]">
      <div className="flex h-7 items-center gap-2 border-b border-subtle px-2.5 text-[10.5px] text-tertiary">
        <BrandMark className="size-3.5" /> Hubble
        <span className="ml-auto flex gap-2.5 text-[11px]">
          <span>—</span>
          <span>□</span>
          <span>×</span>
        </span>
      </div>
      <div className="grid grid-cols-[72px_1fr]">
        <div className="flex flex-col gap-1 border-r border-subtle p-2">
          {["Home", "Graph", "AI", "Library"].map((label, index) => (
            <span key={label} className={cn("rounded-[3px] px-1.5 py-0.5 text-[10px]", index === 0 ? "bg-[var(--m-ground-5)] text-foreground" : "text-muted-foreground")}>
              {label}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 p-2.5">
          <span className="text-[12px] text-foreground">Projects</span>
          {["History IA", "Physics coursework", "Extended essay"].map((name) => (
            <span key={name} className="flex h-6 items-center rounded-[4px] border border-subtle bg-[var(--m-ground-2)] px-2 text-[10.5px] text-muted-foreground">
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
