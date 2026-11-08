"use client"

import { useState } from "react"
import { Check, ChevronDown, MoreHorizontal, X } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProviderMark } from "@/components/memory/provider-mark"
import { attributionLabel, roleName } from "@/lib/conversations/intelligence/extract"
import { FACT_RULE_REASON, RELATION_LEVEL_LABEL } from "@/lib/conversations/intelligence/types"
import { aiProviderName } from "@/lib/providers/registry"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { FactCorrection } from "@/lib/conversations/intelligence/settings"
import type { ConversationRecord, Evidence, Fact, Insight, Relation } from "@/lib/conversations/intelligence/types"

/**
 * The pieces every conversation-intelligence surface shares: a fact with who
 * it belongs to and the controls to correct it, and an insight with why it
 * is shown. Who said something is always words ("You decided", "Claude
 * suggested"), never colour alone; an AI's words are never styled as the
 * person's.
 */

export function confidenceWords(confidence: number): string {
  return confidence >= 0.8 ? "High confidence" : confidence >= 0.6 ? "Likely" : "Possible"
}

const KIND_WORDS: Record<Fact["kind"], string> = { decision: "Decision", task: "Task", knowledge: "Knowledge", question: "Open question" }

/** A small "Why?" toggle: the reasoning behind something Hubble inferred, on request. */
function WhyToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="inline-flex items-center gap-0.5 text-meta text-tertiary underline-offset-2 hover:text-foreground hover:underline" aria-expanded={open} aria-label={label} onClick={onToggle}>
      Why?
      <ChevronDown className={cn("size-3 transition-transform duration-(--duration-fast)", open && "rotate-180")} />
    </button>
  )
}

/**
 * Why Hubble holds a fact: what kind of thing it is, the rule that found it,
 * how sure that rule is, the messages it rests on, and whether it is still
 * only Hubble's reading or the person's word.
 */
function FactWhy({ fact, record, correction }: { fact: Fact; record?: ConversationRecord; correction?: FactCorrection }) {
  const ai = aiProviderName(record?.provider)
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-subtle bg-card px-3 py-2 text-meta" data-fact-why>
      <dt className="text-tertiary">Category</dt>
      <dd className="text-foreground">
        {KIND_WORDS[fact.kind]} · {attributionLabel(fact, ai)}
      </dd>
      <dt className="text-tertiary">How Hubble knows</dt>
      <dd className="text-foreground">{FACT_RULE_REASON[fact.rule]}</dd>
      <dt className="text-tertiary">Confidence</dt>
      <dd className="text-foreground">
        {Math.round(fact.confidence * 100)}% — how reliable that rule is, not a probability
      </dd>
      <dt className="text-tertiary">Status</dt>
      <dd className="text-foreground">{correction?.verdict === "confirmed" ? "Confirmed by you" : correction?.status ? "Corrected by you" : "Inferred by Hubble — not confirmed"}</dd>
      {fact.supersededBy && (
        <>
          <dt className="text-tertiary">Now</dt>
          <dd className="text-foreground">Replaced by a later decision — kept here as history</dd>
        </>
      )}
      <dt className="text-tertiary">From</dt>
      <dd className="flex min-w-0 flex-col gap-1">
        {fact.evidence.map((entry, index) => (
          <span key={index} className="min-w-0 text-muted-foreground">
            <span className="text-tertiary">{roleName(entry.role, ai)}, message {entry.messageIndex + 1}:</span> “{entry.quote}”
          </span>
        ))}
      </dd>
    </dl>
  )
}

const TONE: Record<Fact["attribution"], string> = {
  user: "bg-surface-selected text-foreground",
  "user-accepted": "bg-surface-selected text-foreground",
  assistant: "border border-subtle text-muted-foreground",
}

export function AttributionTag({ fact, provider }: { fact: Pick<Fact, "kind" | "status" | "attribution">; provider?: string }) {
  const ai = aiProviderName(provider)
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-meta", TONE[fact.attribution])}>
      {fact.attribution !== "user" && provider ? <ProviderMark provider={provider} size={11} /> : null}
      {attributionLabel(fact, ai)}
    </span>
  )
}

export function FactRow({
  fact,
  record,
  correction,
  onCorrect,
  onShowMessage,
  showSource = false,
  note,
}: {
  fact: Fact
  record?: ConversationRecord
  correction?: FactCorrection
  onCorrect?: (correction: Omit<FactCorrection, "at">) => void
  onShowMessage?: (evidence: Evidence) => void
  /** Name the conversation it came from (lists that span conversations). */
  showSource?: boolean
  /** One more line about it (why an answer included it). */
  note?: string
}) {
  const evidence = fact.evidence[fact.evidence.length - 1]
  const [why, setWhy] = useState(false)
  return (
    <li className="group flex flex-col gap-1.5 rounded-md px-2 py-2 transition-[background-color] duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover" data-fact={fact.kind} data-status={fact.status}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <AttributionTag fact={fact} {...(record?.provider ? { provider: record.provider } : {})} />
        {correction?.verdict === "confirmed" && <span className="text-meta text-muted-foreground">· You confirmed this</span>}
        {correction?.status && <span className="text-meta text-muted-foreground">· Corrected by you</span>}
        {!correction && <span className="text-meta text-tertiary">· {confidenceWords(fact.confidence)}</span>}
        {fact.replaces && <span className="text-meta text-tertiary">· replaces “{fact.replaces}”</span>}
        {fact.openReason === "did-not-work" && <span className="text-meta text-tertiary">· tried, didn&apos;t work yet</span>}
        {fact.supersededBy && <span className="text-meta text-warning">· replaced later</span>}
        <WhyToggle open={why} onToggle={() => setWhy((value) => !value)} label={`Why Hubble thinks this: ${fact.text.slice(0, 60)}`} />
        {onCorrect && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={`Correct: ${fact.text.slice(0, 60)}`} />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuItem onClick={() => onCorrect({ verdict: "confirmed" })}>
                <Check /> That&apos;s right
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCorrect({ verdict: "rejected" })}>
                <X /> That&apos;s wrong — remove it
              </DropdownMenuItem>
              {fact.kind === "decision" && fact.status !== "suggested" && <DropdownMenuItem onClick={() => onCorrect({ status: "suggested" })}>It was only the AI&apos;s suggestion</DropdownMenuItem>}
              {fact.kind === "decision" && fact.status !== "decided" && <DropdownMenuItem onClick={() => onCorrect({ status: "decided" })}>I did decide this</DropdownMenuItem>}
              {fact.kind === "task" && fact.status !== "done" && <DropdownMenuItem onClick={() => onCorrect({ status: "done" })}>Mark done</DropdownMenuItem>}
              {correction && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onCorrect({})}>Undo my correction</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <p className={cn("text-body", fact.supersededBy ? "text-muted-foreground" : "text-foreground")}>{fact.text}</p>
      {note && <p className="text-meta text-tertiary">{note}</p>}
      {why && <FactWhy fact={fact} {...(record ? { record } : {})} {...(correction ? { correction } : {})} />}
      {(showSource || (evidence && onShowMessage)) && (
        <p className="flex min-w-0 items-center gap-1.5 text-meta text-tertiary">
          {showSource && record && (
            <span className="flex min-w-0 items-center gap-1 truncate">
              <ProviderMark provider={record.provider} size={11} />
              <span className="truncate">{record.title}</span>
            </span>
          )}
          {evidence && onShowMessage && (
            <button type="button" className="shrink-0 underline-offset-2 hover:text-foreground hover:underline" onClick={() => onShowMessage(evidence)}>
              {fact.evidence.length > 1 ? `Show the ${fact.evidence.length} messages` : "Show the message"}
            </button>
          )}
        </p>
      )}
    </li>
  )
}

export function InsightCard({
  insight,
  records,
  now,
  onOpen,
  onDismiss,
}: {
  insight: Insight
  records: ReadonlyMap<string, ConversationRecord>
  now: number
  onOpen: () => void
  onDismiss: () => void
}) {
  const sources = insight.recordIds.map((id) => records.get(id)).filter((record): record is ConversationRecord => !!record)
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-lg border border-subtle bg-card p-3" data-insight={insight.kind}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-body font-medium text-foreground">{insight.title}</h3>
        <IconButton aria-label={`Dismiss: ${insight.title}`} tooltip="Dismiss" className="-mt-1 -mr-1 size-6" onClick={onDismiss}>
          <X />
        </IconButton>
      </div>
      <p className="text-body-sm text-muted-foreground">{insight.why}</p>
      <ul className="flex flex-col gap-0.5" aria-label="From">
        {sources.slice(0, 3).map((record) => (
          <li key={record.id} className="flex min-w-0 items-center gap-1.5 text-meta text-tertiary">
            <ProviderMark provider={record.provider} size={11} />
            <span className="truncate">{record.title}</span>
            <span className="shrink-0">· {formatRelativeTime(record.updatedAt, now)}</span>
          </li>
        ))}
        {sources.length > 3 && <li className="text-meta text-tertiary">and {sources.length - 3} more</li>}
      </ul>
      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button type="button" size="sm" variant="secondary" onClick={onOpen}>
          {insight.threadId ? "Open the thread" : "Open"}
        </Button>
        <span className="truncate text-meta text-tertiary" title={insight.suggestion}>
          {confidenceWords(insight.confidence)}
        </span>
      </div>
    </article>
  )
}

export type MeaningMatch = { a: Evidence; b: Evidence; score: number }

/**
 * One related conversation: how it relates (the level), how sure Hubble is,
 * and — on request — every reason, the scores behind them, and, when the
 * on-device model took part, the two messages closest in meaning.
 */
export function RelationRow({
  relation,
  other,
  now,
  sharedNames,
  onOpen,
  onRelated,
  onUnrelated,
  explainMeaning,
}: {
  relation: Relation
  other: ConversationRecord
  now: number
  /** The shared names and words, in the conversations' own spelling. */
  sharedNames: string[]
  onOpen: () => void
  onRelated?: () => void
  onUnrelated?: () => void
  /** Loads the closest messages by meaning (reads the stored vectors). */
  explainMeaning?: () => Promise<MeaningMatch | undefined>
}) {
  const [why, setWhy] = useState(false)
  const [match, setMatch] = useState<{ state: "idle" | "loading" | "done"; found?: MeaningMatch }>({ state: "idle" })
  const toggle = () => {
    setWhy((value) => !value)
    if (match.state === "idle" && explainMeaning && relation.semantic !== undefined) {
      setMatch({ state: "loading" })
      void explainMeaning()
        .then((found) => setMatch(found ? { state: "done", found } : { state: "done" }))
        .catch(() => setMatch({ state: "done" }))
    }
  }
  return (
    <li className="group flex flex-col gap-1.5 rounded-md px-2 py-2 hover:bg-surface-hover" data-relation={relation.level}>
      <div className="flex items-center gap-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onOpen}>
          <ProviderMark provider={other.provider} size={14} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-foreground">{other.title}</span>
            <span className="block truncate text-meta text-tertiary">
              {[RELATION_LEVEL_LABEL[relation.level], relation.confirmed ? "you confirmed" : confidenceWords(relation.score).toLowerCase(), sharedNames.slice(0, 4).join(", ") || undefined, formatRelativeTime(other.updatedAt, now)].filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
        <WhyToggle open={why} onToggle={toggle} label={`Why related: ${other.title}`} />
        {onRelated && !relation.confirmed && (
          <Button type="button" size="sm" variant="ghost" className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" onClick={onRelated}>
            Yes, related
          </Button>
        )}
        {onUnrelated && (
          <Button type="button" size="sm" variant="ghost" className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" onClick={onUnrelated}>
            Not related
          </Button>
        )}
      </div>
      {why && (
        <div className="ml-7 flex flex-col gap-1.5 rounded-md border border-subtle bg-card px-3 py-2 text-meta" data-relation-why>
          <ul className="flex flex-col gap-0.5 text-foreground">
            {relation.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="text-tertiary">
            Words and names {Math.round(relation.lexical * 100)}%{relation.semantic !== undefined ? ` · meaning ${Math.round(relation.semantic * 100)}%` : " · meaning not compared (on-device model off or not run yet)"} · overall {Math.round(relation.score * 100)}%. {relation.confirmed ? "You confirmed this." : "Inferred by Hubble — not confirmed."}
          </p>
          {match.state === "loading" && <p className="text-tertiary">Looking for the closest messages…</p>}
          {match.found && (
            <p className="text-muted-foreground">
              Closest in meaning: “{match.found.a.quote}” ↔ “{match.found.b.quote}”
            </p>
          )}
        </div>
      )}
    </li>
  )
}
