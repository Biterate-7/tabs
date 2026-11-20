"use client"

import { useState, type CSSProperties } from "react"
import { Check, ShieldCheck } from "lucide-react"
import { ProviderMark } from "@/components/memory/provider-mark"
import { ACTIVITY_KIND_LABEL, ACTIVITY_OUTCOME_LABEL } from "@/lib/integrations/activity-labels"
import type { ActivityKind, ActivityOutcome } from "@/lib/integrations/records"
import { planStepLine } from "@/lib/knowledge/workspace/plan"
import { AI_PROVIDER_IDS, AI_PROVIDERS, type AiProviderId } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import { at, useTimeline } from "./use-timeline"
import { DemoWindow } from "./window"

/*
 * Control: Settings → AI connectors, where Hubble keeps every AI app that can
 * reach a project. Each connection has its own permission and its own list
 * of projects; every call it makes is written to the activity log; and a
 * reorganisation it proposes waits here until the person approves it.
 *
 * The apps listed are the ones the provider registry says can connect; the
 * log uses the product's own labels and tool names; the proposal's lines are
 * the product's own wording (planStepLine).
 */

type Row = { who: string; provider?: AiProviderId; kind: ActivityKind; operation: string; outcome: ActivityOutcome; at: number }

const DURATIONS = [1700, 1700, 1900, 2400, 4200, 4400] as const
const WAITING = 4
const APPLIED = 5

const CONNECTED: readonly AiProviderId[] = AI_PROVIDER_IDS.filter((id) => AI_PROVIDERS[id].capabilities.connector.supported)
const PERMISSION: Partial<Record<AiProviderId, { label: string; projects: string }>> = {
  chatgpt: { label: "Read and save", projects: "History IA" },
  claude: { label: "Read and save", projects: "History IA · Extended essay" },
  gemini: { label: "Read only", projects: "History IA" },
}

const ROWS: Row[] = [
  { who: "Gemini", provider: "gemini", kind: "read", operation: "search_workspace", outcome: "ok", at: 0 },
  { who: "ChatGPT", provider: "chatgpt", kind: "write", operation: "save_workspace_note", outcome: "ok", at: 1 },
  { who: "Claude", provider: "claude", kind: "read", operation: "get_project_context", outcome: "ok", at: 2 },
  { who: "Claude", provider: "claude", kind: "proposal", operation: "propose_organization", outcome: "pending", at: 3 },
]

export function ReviewDemo() {
  const { attach, frame, go: goTo } = useTimeline({ durations: DURATIONS, restFrame: WAITING, startFrame: 0 })
  const [declined, setDeclined] = useState(false)
  const decided = frame >= APPLIED
  const rows: Row[] = [
    ...ROWS.map((row) => (row.outcome === "pending" && decided ? { ...row, outcome: "ok" as const } : row)),
    ...(decided
      ? declined
        ? [{ who: "You", kind: "decline" as const, operation: "propose_organization", outcome: "ok" as const, at: APPLIED }]
        : [
            { who: "You", kind: "approval" as const, operation: "propose_organization", outcome: "ok" as const, at: APPLIED },
            { who: "Claude", provider: "claude" as const, kind: "apply" as const, operation: "apply_organization", outcome: "ok" as const, at: APPLIED },
          ]
      : []),
  ]
  const go = (next: number) => {
    if (next < APPLIED) setDeclined(false)
    goTo(next)
  }

  return (
    <DemoWindow
      label="Hubble's AI connectors settings: ChatGPT, Claude and Gemini connected with their own permissions, a log of what each did, and a change Claude proposed waiting for approval."
      title="Hubble — Settings"
      className="h-[500px] md:h-[560px]"
    >
      <div ref={attach} className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]" data-review-demo="" data-frame={frame}>
        {/* Connections */}
        <div className="hidden min-h-0 flex-col border-r border-subtle bg-[var(--m-ground-2)] p-4 md:flex">
          <p className="text-[13px] text-foreground">AI connectors</p>
          <p className="mt-0.5 text-[11px] text-tertiary">What each AI app can reach, and do.</p>
          <ul className="mt-4 flex flex-col gap-2">
            {CONNECTED.map((id) => {
              const permission = PERMISSION[id] ?? { label: "Read only", projects: "History IA" }
              const active = rows.some((row, index) => row.provider === id && index === rows.length - 1)
              return (
                <li key={id} className={cn("m-glow rounded-[7px] border p-2.5", active ? "border-strong bg-[var(--m-ground-4)]" : "border-subtle bg-[var(--m-ground-3)]")}>
                  <span className="flex items-center gap-2 text-[12.5px] text-foreground">
                    <ProviderMark provider={id} size={15} /> {AI_PROVIDERS[id].name}
                    <span className="ml-auto flex items-center gap-1 text-[10.5px] text-muted-foreground">
                      <span aria-hidden className="size-1.5 rounded-full bg-foreground/70" /> Connected
                    </span>
                  </span>
                  <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ShieldCheck aria-hidden className="size-3" /> {permission.label}
                  </span>
                  <span className="mt-0.5 block truncate pl-[18px] text-[11px] text-tertiary">{permission.projects}</span>
                </li>
              )
            })}
          </ul>
          <p className="mt-auto text-[11px] leading-relaxed text-tertiary">Change a permission or disconnect, and it applies to the next request.</p>
        </div>

        {/* Proposals and activity */}
        <div className="flex min-h-0 flex-col p-4">
          <div data-on={at(frame, 3)} className="m-grow">
            <div>
              <p className="text-[11px] text-tertiary">Changes proposed by AI clients</p>
              <div className={cn("m-glow mt-2 mb-4 rounded-[8px] border p-3", frame === WAITING ? "border-strong bg-[var(--m-ground-3)]" : "border-subtle bg-[var(--m-ground-2)]")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="flex items-center gap-2 text-[12.5px] leading-snug text-foreground">
                    <ProviderMark provider="claude" size={14} /> Claude proposed 2 changes in “History IA”
                  </p>
                  <span className={cn("m-glow shrink-0 rounded-full border px-2 py-px text-[10.5px]", decided ? "border-strong text-foreground" : "border-subtle text-muted-foreground")}>
                    {decided ? (declined ? "Declined" : "Applied") : "Waiting for you"}
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1 pl-[22px]">
                  <li className="text-[11.5px] text-foreground">{planStepLine({ kind: "create_collection", subject: "July Crisis", tabCount: 3, tabs: [], movesFrom: [] })}</li>
                  <li className="text-[11.5px] text-foreground">{planStepLine({ kind: "add_tabs_to_collection", subject: "Historians' views", tabCount: 2, tabs: [], movesFrom: [] })}</li>
                </ul>
                <div className="mt-3 flex items-center gap-1.5 pl-[22px]">
                  {decided ? (
                    <span className="flex h-6 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                      <Check aria-hidden className="size-3.5" /> {declined ? "Nothing was changed." : "Applied, all at once, and checked."}
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={frame !== WAITING}
                        onClick={() => go(APPLIED)}
                        className="m-glow h-6 rounded-[4px] bg-foreground px-2.5 text-[11.5px] text-background outline-none hover:bg-[var(--accent-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={frame !== WAITING}
                        onClick={() => {
                          setDeclined(true)
                          goTo(APPLIED)
                        }}
                        className="m-glow h-6 rounded-[4px] border border-strong px-2.5 text-[11.5px] text-foreground outline-none hover:bg-[var(--m-ground-4)] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                      >
                        Decline
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-tertiary">Recent activity</p>
          <ul aria-label="Recent AI connector activity" className="mt-1 flex flex-col-reverse">
            {rows.map((row, index) => (
              <li
                key={`${row.kind}-${row.operation}-${row.who}`}
                data-on={frame >= row.at}
                className="m-grow"
                style={{ transitionDelay: row.at === APPLIED ? `${(index - ROWS.length) * 260}ms` : "0ms" } as CSSProperties}
              >
                <div>
                <div className="flex items-center justify-between gap-3 border-b border-subtle py-2">
                <span className="flex min-w-0 items-center gap-2">
                  {row.provider ? <ProviderMark provider={row.provider} size={13} /> : <span aria-hidden className="size-[13px] rounded-full border border-strong" />}
                  <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                    <span className="text-foreground">{row.who}</span> · {ACTIVITY_KIND_LABEL[row.kind]}: {row.operation.replaceAll("_", " ")}
                  </span>
                </span>
                <span className={cn("shrink-0 text-[11px]", row.outcome === "pending" ? "text-foreground" : "text-tertiary")}>{ACTIVITY_OUTCOME_LABEL[row.outcome]}</span>
                </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-tertiary md:hidden">
            {CONNECTED.map((id) => (
              <span key={id} className="flex items-center gap-1">
                <ProviderMark provider={id} size={12} /> {PERMISSION[id]?.label ?? "Read only"}
              </span>
            ))}
          </div>
        </div>
      </div>
    </DemoWindow>
  )
}
