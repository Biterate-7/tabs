"use client"

import { useMemo, useState } from "react"
import { ArrowLeft, Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ProviderMark } from "@/components/memory/provider-mark"
import { FactRow } from "./parts"
import { threadContext } from "@/lib/conversations/intelligence/context"
import { aiProviderName } from "@/lib/providers/registry"
import { subjectName } from "@/lib/product/subjects"
import { formatRelativeTime } from "@/lib/time-format"
import type { FactCorrection, IntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { ConversationIndex, ConversationRecord, ConversationThread, Evidence, Fact } from "@/lib/conversations/intelligence/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * One objective, across AI apps: the conversations about it in order, then
 * what was decided, what each AI suggested, where they disagree, what is
 * open and what is next — every line with its source. "Copy as context"
 * writes the same structure up for the next chat (lib/conversations/
 * intelligence/context.ts): quoted, attributed, and framed as reference.
 */
export function ThreadView({
  thread,
  index,
  settings,
  workspaces,
  now,
  onBack,
  onOpenRecord,
  onCorrect,
}: {
  thread: ConversationThread
  index: ConversationIndex
  settings: IntelligenceSettings
  workspaces: readonly Workspace[]
  now: number
  onBack: () => void
  onOpenRecord: (recordId: string, evidence?: Evidence) => void
  onCorrect: (factId: string, correction: Omit<FactCorrection, "at">) => void
}) {
  const [preview, setPreview] = useState(false)
  const records = thread.recordIds.map((id) => index.records.find((record) => record.id === id)).filter((record): record is ConversationRecord => !!record)
  const byId = new Map(records.map((record) => [record.id, record]))
  const facts = index.facts.filter((fact) => byId.has(fact.recordId))
  const context = useMemo(() => threadContext(thread, index), [thread, index])
  const contradictions = index.contradictions.filter((entry) => byId.has(entry.earlier.recordId) && byId.has(entry.later.recordId))
  const opening = records[0]?.messages.find((message) => message.role === "user")

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(context)
      toast.success("Copied — paste it into any AI chat")
    } catch {
      setPreview(true)
      toast.error("Couldn't copy. Select the text below and copy it yourself.")
    }
  }

  const section = (title: string, list: readonly Fact[]) =>
    list.length === 0 ? null : (
      <section aria-label={title}>
        <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">{title}</h3>
        <ul className="mt-1 flex flex-col">
          {list.map((fact) => (
            <FactRow key={fact.id} fact={fact} record={byId.get(fact.recordId)!} {...(settings.facts[fact.id] ? { correction: settings.facts[fact.id] } : {})} onCorrect={(correction) => onCorrect(fact.id, correction)} onShowMessage={(evidence) => onOpenRecord(evidence.recordId, evidence)} showSource />
          ))}
        </ul>
      </section>
    )

  return (
    <div className="flex flex-col gap-5 animate-enter" data-thread={thread.id}>
      <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={onBack}>
        <ArrowLeft /> All conversations
      </Button>
      <div>
        <p className="text-meta text-tertiary">Thread · {thread.providers.map(aiProviderName).join(", ")}</p>
        <h2 className="text-h1 text-foreground">{thread.label}</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          {thread.recordIds.length} conversations from {formatRelativeTime(thread.startedAt, now)} to {formatRelativeTime(thread.updatedAt, now)} · in {thread.workspaceIds.map((id) => subjectName(workspaces.find((workspace) => workspace.id === id) ?? { name: "a project" })).join(", ")}. Grouped by Hubble from shared words and names — not something you set.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="lg" onClick={() => void copy()}>
            <Copy /> Copy as context
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={() => setPreview((value) => !value)}>
            {preview ? "Hide the text" : "See the text"}
          </Button>
        </div>
        {preview && <pre className="mt-3 max-h-80 overflow-auto rounded-md border border-subtle bg-background p-3 text-body-sm whitespace-pre-wrap text-muted-foreground select-text">{context}</pre>}
      </div>

      {opening && records[0] && (
        <section aria-label="The original problem">
          <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">The original problem</h3>
          <p className="mt-2 px-2 text-body text-foreground">{opening.text.slice(0, 400)}</p>
          <p className="px-2 text-meta text-tertiary">You, in {aiProviderName(records[0].provider)} · {records[0].title}</p>
        </section>
      )}

      <section aria-label="Conversations">
        <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">Conversations, oldest first</h3>
        <ol className="mt-1 flex flex-col">
          {records.map((record) => (
            <li key={record.id}>
              <button type="button" className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-hover" onClick={() => onOpenRecord(record.id)}>
                <ProviderMark provider={record.provider} size={14} />
                <span className="min-w-0 flex-1 truncate text-body text-foreground">{record.title}</span>
                <span className="shrink-0 text-meta text-tertiary">{formatRelativeTime(record.updatedAt, now)}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {section("What you decided", facts.filter((fact) => fact.kind === "decision" && (fact.status === "decided" || fact.status === "accepted")))}
      {section("What the AIs suggested — not confirmed", facts.filter((fact) => fact.kind === "decision" && fact.status === "suggested"))}
      {section("What you turned down", facts.filter((fact) => fact.kind === "decision" && fact.status === "rejected"))}
      {contradictions.length > 0 && (
        <section aria-label="Where they disagree">
          <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">Where they disagree</h3>
          <p className="px-2 pt-2 text-meta text-tertiary">Hubble doesn&apos;t pick a winner. Mark the one that no longer stands as wrong.</p>
          <ul className="mt-1 flex flex-col">
            {contradictions.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-0.5 border-l-2 border-subtle py-1 pl-3">
                <p className="text-meta text-tertiary">{entry.reason}</p>
                <ul className="flex flex-col">
                  {[entry.earlier, entry.later].map((fact) => (
                    <FactRow key={fact.id} fact={fact} record={byId.get(fact.recordId)!} {...(settings.facts[fact.id] ? { correction: settings.facts[fact.id] } : {})} onCorrect={(correction) => onCorrect(fact.id, correction)} onShowMessage={(evidence) => onOpenRecord(evidence.recordId, evidence)} showSource />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
      {section("Found and confirmed", facts.filter((fact) => fact.kind === "knowledge" && fact.status === "confirmed"))}
      {section("Still open", facts.filter((fact) => fact.kind === "question"))}
      {section("Next", facts.filter((fact) => fact.kind === "task" && fact.status !== "done"))}
      {section("Done", facts.filter((fact) => fact.kind === "task" && fact.status === "done"))}
    </div>
  )
}
