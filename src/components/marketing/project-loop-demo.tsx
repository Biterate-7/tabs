"use client"

import { useEffect, useState } from "react"
import { ArrowRight, Check, ChevronLeft, ChevronRight, FileText, Globe, Pause, Play, PlayCircle, ShieldCheck } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { cn } from "@/lib/utils"

/**
 * The project loop, as a walkthrough (Hubble 2.0):
 *
 *   create History IA → drop four sources from Chrome → they are read →
 *   Claude is given the project → approve → Claude answers →
 *   switch to Gemini → Gemini challenges Claude from the same project
 *
 * A **simulation**, and it says so on screen: nothing here talks to an agent
 * or a runtime. Every step depicts something the product does — the same
 * sources, statuses, wording and handoff the app shows — and nothing it does
 * not. The live product windows elsewhere on the page are the real interface;
 * this is the story of one task through it.
 */

type Source = { title: string; site: string; kind: "pdf" | "youtube" | "webpage"; status: string }

const SOURCES: Source[] = [
  { title: "Cuban Missile Crisis — declassified documents", site: "jfklibrary.org", kind: "pdf", status: "Ready · 12 pages of text" },
  { title: "Cuban Missile Crisis Explained", site: "youtube.com", kind: "youtube", status: "Ready · Transcript · 214 lines" },
  { title: "Cuban missile crisis | Britannica", site: "britannica.com", kind: "webpage", status: "Ready · 3,120 words" },
  { title: "Kennedy and the quarantine — Foreign Affairs", site: "foreignaffairs.com", kind: "webpage", status: "Ready · 5,480 words" },
]

type Step = {
  label: string
  /** How many sources are in the project at this step. */
  sources: number
  /** Sources still being read. */
  reading?: boolean
  agent?: "claude-code" | "gemini"
  panel: "empty" | "drop" | "composer" | "approval" | "answer" | "switch" | "challenge" | "history"
}

const STEPS: Step[] = [
  { label: "Create the project “History IA”", sources: 0, panel: "empty" },
  { label: "Drag a PDF, a video and two articles in from Chrome", sources: 4, reading: true, panel: "drop" },
  { label: "Hubble reads each source — PDF pages, the transcript you added, article text", sources: 4, panel: "drop" },
  { label: "Open the Command Centre and choose Claude — it starts from the project", sources: 4, agent: "claude-code", panel: "composer" },
  { label: "Claude asks before it changes anything — here, grouping its evidence; you approve", sources: 4, agent: "claude-code", panel: "approval" },
  { label: "Claude reads the sources and answers, citing pages", sources: 4, agent: "claude-code", panel: "answer" },
  { label: "Switch to Gemini — same project, Claude’s answer passed on", sources: 4, agent: "gemini", panel: "switch" },
  { label: "Gemini challenges Claude’s conclusions from the same sources", sources: 4, agent: "gemini", panel: "challenge" },
  { label: "Both pieces of work stay in the project, for whenever you come back", sources: 4, panel: "history" },
]

const STEP_MS = 3200

function KindIcon({ kind }: { kind: Source["kind"] }) {
  const Icon = kind === "pdf" ? FileText : kind === "youtube" ? PlayCircle : Globe
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
}

export function ProjectLoopDemo() {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const step = STEPS[index]!

  useEffect(() => {
    if (!playing) return
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const timer = setTimeout(() => setIndex((current) => (current + 1) % STEPS.length), STEP_MS)
    return () => clearTimeout(timer)
  }, [playing, index])

  return (
    <figure className="m-card overflow-hidden" aria-label="Product walkthrough: a project from Chrome to two agents" data-project-loop-demo>
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="m-small text-muted-foreground">Product walkthrough · simulated, nothing runs</span>
        <span className="m-small ml-auto text-foreground" aria-live="polite">
          {index + 1}/{STEPS.length} · {step.label}
        </span>
      </figcaption>

      <div className="grid min-h-[340px] grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* The project */}
        <div className="flex min-w-0 flex-col gap-2 border-b border-border p-4 md:border-r md:border-b-0">
          <p className="text-[15px] font-medium text-foreground">History IA</p>
          <p className="m-small text-muted-foreground">Investigating the Cuban Missile Crisis and US–Soviet relations.</p>
          <p className="m-small mt-1 text-foreground">
            Context <span className="text-muted-foreground">· {step.sources} sources</span>
          </p>
          {step.sources === 0 ? (
            <div className="m-small mt-1 rounded-md border border-dashed border-border p-4 text-center text-muted-foreground">Drag a link from Chrome here</div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {SOURCES.slice(0, step.sources).map((source) => (
                <li key={source.title} className="flex min-w-0 items-start gap-2 rounded-md border border-border px-2.5 py-2">
                  <KindIcon kind={source.kind} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-foreground">{source.title}</span>
                    <span className="m-small block text-[12px] text-muted-foreground">
                      {source.site} · {step.reading ? "Reading…" : source.status}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* The agent */}
        <div className="flex min-w-0 flex-col gap-3 p-4">
          <p className="m-small flex items-center gap-1.5 text-foreground">
            Command Centre <span className="text-muted-foreground">/ History IA</span>
            {step.agent && (
              <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                <AgentIcon connector={step.agent} size="xs" /> {step.agent === "gemini" ? "Gemini CLI" : "Claude Code"}
              </span>
            )}
          </p>
          <Panel step={step} />
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-2">
        <button type="button" className="m-small rounded-md px-2 py-1 text-foreground hover:bg-[color-mix(in_oklab,var(--foreground)_6%,transparent)]" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause walkthrough" : "Play walkthrough"}>
          {playing ? <Pause aria-hidden className="inline size-3.5" /> : <Play aria-hidden className="inline size-3.5" />} {playing ? "Pause" : "Play"}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="rounded-md p-1 text-foreground disabled:opacity-40" disabled={index === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))} aria-label="Previous step">
            <ChevronLeft aria-hidden className="size-4" />
          </button>
          <ol className="flex gap-1" aria-label="Steps">
            {STEPS.map((entry, position) => (
              <li key={entry.label}>
                <button
                  type="button"
                  aria-label={`Step ${position + 1}: ${entry.label}`}
                  aria-current={position === index ? "step" : undefined}
                  className={cn("block size-2 rounded-full", position === index ? "bg-foreground" : "bg-[color-mix(in_oklab,var(--foreground)_25%,transparent)]")}
                  onClick={() => setIndex(position)}
                />
              </li>
            ))}
          </ol>
          <button type="button" className="rounded-md p-1 text-foreground disabled:opacity-40" disabled={index === STEPS.length - 1} onClick={() => setIndex((value) => Math.min(STEPS.length - 1, value + 1))} aria-label="Next step">
            <ChevronRight aria-hidden className="size-4" />
          </button>
        </div>
      </div>
    </figure>
  )
}

function Bubble({ children, from }: { children: React.ReactNode; from: "you" | "agent" }) {
  return (
    <div className={cn("m-small rounded-md px-3 py-2 text-[13px]", from === "you" ? "self-end bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] text-foreground" : "border border-border text-foreground")}>
      {children}
    </div>
  )
}

function Panel({ step }: { step: Step }) {
  switch (step.panel) {
    case "empty":
      return <p className="m-small text-muted-foreground">Start by adding context. Then choose any agent to work on it.</p>
    case "drop":
      return (
        <div className="m-small flex flex-col gap-1 text-muted-foreground">
          <p className="text-foreground">Added 4 sources to History IA ✓</p>
          <p>{step.reading ? "Hubble is reading them now." : "Each card says what Hubble could read — and what it couldn't."}</p>
        </div>
      )
    case "composer":
      return (
        <div className="flex flex-col gap-2">
          <div className="m-small rounded-md border border-border px-3 py-2 text-[13px] text-foreground">Analyze these sources and identify the three strongest arguments for my IA.</div>
          <p className="m-small text-[12px] text-muted-foreground">Claude Code will use: 4 sources · project brief</p>
        </div>
      )
    case "approval":
      return (
        <div className="m-small flex flex-col gap-2 rounded-md border border-border p-3 text-[13px]">
          <p className="flex items-center gap-1.5 text-foreground">
            <ShieldCheck aria-hidden className="size-4" /> Claude Code wants to create the collection “Evidence for argument 1”
          </p>
          <p className="text-[12px] text-muted-foreground">3 sources · in History IA · reading never asks; changes always do</p>
          <div className="flex gap-2">
            <span className="rounded-md bg-foreground px-2 py-0.5 text-background">Allow</span>
            <span className="rounded-md border border-border px-2 py-0.5 text-muted-foreground">Deny</span>
          </div>
        </div>
      )
    case "answer":
      return (
        <Bubble from="agent">
          Three arguments: (1) the quarantine forced negotiation — <em>declassified documents, p. 4</em>; (2) Khrushchev traded the missiles for a no-invasion
          pledge — <em>p. 7</em>; (3) the secret Jupiter deal mattered — <em>Britannica</em>.
        </Bubble>
      )
    case "switch":
      return (
        <div className="m-small flex flex-col gap-1.5 rounded-md border border-border p-3 text-[13px] text-foreground">
          <p className="flex items-center gap-1.5">
            <AgentIcon connector="claude-code" size="xs" /> <ArrowRight aria-hidden className="size-3.5" /> <AgentIcon connector="gemini" size="xs" /> Gemini takes over
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Check aria-hidden className="size-3.5" /> Same project · 4 sources
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Check aria-hidden className="size-3.5" /> Claude Code&apos;s answer
          </p>
        </div>
      )
    case "challenge":
      return (
        <div className="flex flex-col gap-2">
          <Bubble from="you">Critically challenge Claude&apos;s arguments using the same sources.</Bubble>
          <Bubble from="agent">Argument (3) rests on one secondary source; the Foreign Affairs piece reads the quarantine differently, so (1) is contested too.</Bubble>
        </div>
      )
    case "history":
      return (
        <div className="m-small flex flex-col gap-1.5 text-[13px]">
          <p className="text-muted-foreground">Where you left off</p>
          <p className="flex items-center gap-1.5 text-foreground">
            <AgentIcon connector="gemini" size="xs" /> Gemini challenged Claude&apos;s three arguments
          </p>
          <p className="flex items-center gap-1.5 text-foreground">
            <AgentIcon connector="claude-code" size="xs" /> Claude analyzed 4 sources
          </p>
        </div>
      )
  }
}
