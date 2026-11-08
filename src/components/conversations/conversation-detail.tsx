"use client"

import { useMemo, useState } from "react"
import { ArrowLeft, ExternalLink, FolderOpen, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { ConversationView, captureLine } from "@/components/memory/conversation-view"
import { ProviderMark } from "@/components/memory/provider-mark"
import { FactRow, RelationRow, confidenceWords } from "./parts"
import type { MeaningMatch } from "./parts"
import { relevantConversations } from "@/lib/conversations/intelligence/retrieve"
import { pairKey } from "@/lib/conversations/intelligence/settings"
import { INTENT_LABEL } from "@/lib/conversations/intelligence/types"
import { aiProviderName } from "@/lib/providers/registry"
import { subjectName } from "@/lib/product/subjects"
import { formatRelativeTime } from "@/lib/time-format"
import type { FactCorrection, IntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { ConversationIndex, ConversationRecord, Evidence, Fact } from "@/lib/conversations/intelligence/types"
import type { Workspace } from "@/lib/workspace/types"

type Tab = "insights" | "messages" | "related"

const PROCESSING_WORDS = {
  analyzed: undefined,
  pending: "Analysing on this device…",
  excluded: "Left out of analysis",
  failed: "Couldn't be analysed — saved and searchable as usual",
} as const

/**
 * One saved conversation: what was said, and what Hubble understood from it
 * — each item with who it belongs to, how sure Hubble is, the message it
 * rests on, and a way to correct it. Corrections are the person's and win
 * over extraction everywhere (memory, threads, insights, answers).
 */
export function ConversationDetail({
  record,
  index,
  settings,
  workspaces,
  now,
  onBack,
  onOpenRecord,
  onOpenInProject,
  onOpenUrl,
  onCorrect,
  onExclude,
  onUnrelated,
  onRelated,
  explainMeaning,
  onReanalyze,
  onDelete,
}: {
  record: ConversationRecord
  index: ConversationIndex
  settings: IntelligenceSettings
  workspaces: readonly Workspace[]
  now: number
  onBack: () => void
  onOpenRecord: (recordId: string) => void
  onOpenInProject: (turn?: number) => void
  onOpenUrl: (url: string) => void
  onCorrect: (factId: string, correction: Omit<FactCorrection, "at">) => void
  onExclude: (excluded: boolean) => void
  onUnrelated: (otherId: string) => void
  onRelated?: (otherId: string) => void
  /** The two messages closest in meaning between this conversation and another, from the stored vectors. */
  explainMeaning?: (otherId: string) => Promise<MeaningMatch | undefined>
  onReanalyze: () => void
  onDelete: () => void
}) {
  const [tab, setTab] = useState<Tab>("insights")
  const [focusTurn, setFocusTurn] = useState<number | undefined>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ai = aiProviderName(record.provider)
  const extraction = index.extractions.get(record.id)
  const state = index.processing.get(record.id) ?? "pending"
  const workspace = workspaces.find((entry) => entry.id === record.workspaceId)
  const copies = index.records.filter((other) => other.identity === record.identity && other.id !== record.id)
  const recordById = useMemo(() => new Map(index.records.map((entry) => [entry.id, entry])), [index.records])

  // Facts as the index holds them (corrections applied, done-in-a-later-chat applied); the extraction's for a copy the index speaks for elsewhere.
  const facts = useMemo(() => {
    const own = index.facts.filter((fact) => fact.recordId === record.id)
    if (own.length > 0 || !extraction) return own
    const primary = copies.find((copy) => index.facts.some((fact) => fact.recordId === copy.id))
    return primary ? index.facts.filter((fact) => fact.recordId === primary.id) : extraction.facts.filter((fact) => settings.facts[fact.id]?.verdict !== "rejected")
  }, [index.facts, record.id, extraction, copies, settings.facts])

  const showMessage = (evidence: Evidence) => {
    if (evidence.recordId !== record.id && !copies.some((copy) => copy.id === evidence.recordId)) {
      onOpenRecord(evidence.recordId)
      return
    }
    setFocusTurn(evidence.messageIndex)
    setTab("messages")
  }

  const related = useMemo(() => {
    const ids = new Set([record.id, ...copies.map((copy) => copy.id)])
    const out = index.relations
      .filter((relation) => !relation.sameConversation && (ids.has(relation.a) || ids.has(relation.b)))
      .map((relation) => ({ relation, other: recordById.get(ids.has(relation.a) ? relation.b : relation.a) }))
      .filter((entry): entry is { relation: typeof entry.relation; other: ConversationRecord } => !!entry.other)
      .sort((a, b) => b.relation.score - a.relation.score)
    return out
  }, [index.relations, record.id, copies, recordById])
  const thread = index.threads.find((entry) => entry.recordIds.includes(record.id) || copies.some((copy) => entry.recordIds.includes(copy.id)))
  const memories = index.memories.filter((memory) => memory.recordIds.includes(record.id) || copies.some((copy) => memory.recordIds.includes(copy.id)))
  const suggested = useMemo(() => {
    if (related.length > 0) return []
    const exclude = new Set([record.id, ...copies.map((copy) => copy.id)])
    return relevantConversations(index, `${record.title} ${(index.topics.get(record.id) ?? []).map((topic) => topic.label).join(" ")}`, now, exclude, 3)
  }, [related.length, record.id, record.title, copies, index, now])

  const groups: { title: string; facts: Fact[]; empty: string }[] = [
    { title: "Decisions", facts: facts.filter((fact) => fact.kind === "decision"), empty: "No decisions or recommendations found." },
    { title: "Tasks", facts: facts.filter((fact) => fact.kind === "task"), empty: "Nothing to do was mentioned." },
    { title: "Knowledge", facts: facts.filter((fact) => fact.kind === "knowledge"), empty: "No findings or fixes found." },
    { title: "Open questions", facts: facts.filter((fact) => fact.kind === "question"), empty: "Nothing left open." },
  ]
  const entities = (extraction?.entities ?? []).filter((entity) => entity.kind !== "resource").slice(0, 12)
  // A topic that is one of the named things is shown once, as the name.
  const named = new Set(entities.map((entity) => entity.name.toLowerCase().replace(/[^a-z0-9]/g, "")))
  const topics = (index.topics.get(record.id) ?? []).filter((topic) => !named.has(topic.label.toLowerCase().replace(/[^a-z0-9]/g, "")))
  const resources = (extraction?.entities ?? []).filter((entity) => entity.kind === "resource").slice(0, 8)

  return (
    <div className="flex flex-col gap-5 animate-enter" data-conversation-detail={record.id}>
      <div className="flex flex-col gap-3">
        <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={onBack}>
          <ArrowLeft /> All conversations
        </Button>
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-md border border-subtle bg-card">
            <ProviderMark provider={record.provider} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-h1 text-foreground">{record.title}</h2>
            <p className="mt-1 text-body-sm text-muted-foreground">
              {[
                ai,
                workspace ? subjectName(workspace) : undefined,
                captureLine(record.capture, record.syncedAt),
                record.messages.length > 0 ? `${record.messages.length} messages` : undefined,
                `updated ${formatRelativeTime(record.updatedAt, now)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {copies.length > 0 && <p className="mt-0.5 text-meta text-tertiary">Also saved in {copies.map((copy) => subjectName(workspaces.find((entry) => entry.id === copy.workspaceId) ?? { name: "another project" })).join(", ")}</p>}
            {record.ingestion !== "ready" && <p className="mt-1 text-body-sm text-warning">{record.problem ?? "Hubble has only this conversation's address. Save it from the page with Hubble for Chrome to bring in its messages."}</p>}
            {PROCESSING_WORDS[state] && record.ingestion === "ready" && <p className="mt-1 text-meta text-tertiary">{PROCESSING_WORDS[state]}</p>}
            {extraction?.truncated && <p className="mt-1 text-meta text-tertiary">A long conversation: Hubble analysed the first {Math.round(extraction.analyzedChars / 1000)}k characters. All of it is saved and searchable.</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {record.url && (
            <Button type="button" variant="secondary" size="lg" onClick={() => onOpenUrl(record.url!)}>
              <ExternalLink /> Continue in {ai}
            </Button>
          )}
          <Button type="button" variant="secondary" size="lg" onClick={() => onOpenInProject()}>
            <FolderOpen /> Open in project
          </Button>
          {record.ingestion === "ready" && (
            <Button type="button" variant="ghost" size="lg" onClick={() => onExclude(state !== "excluded")}>
              {state === "excluded" ? "Include in analysis" : "Leave out of analysis"}
            </Button>
          )}
          {state === "analyzed" && (
            <Button type="button" variant="ghost" size="lg" onClick={onReanalyze}>
              <RotateCcw /> Analyse again
            </Button>
          )}
          {confirmDelete ? (
            <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
              Delete it and everything Hubble read from it?
              <Button type="button" variant="destructive" size="lg" onClick={onDelete}>
                Delete
              </Button>
              <Button type="button" variant="ghost" size="lg" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button type="button" variant="ghost" size="lg" className="text-muted-foreground" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete from Hubble
            </Button>
          )}
        </div>
      </div>

      <SegmentedControl
        label="Show"
        value={tab}
        onValueChange={setTab}
        options={[
          { value: "insights", label: "What Hubble understood" },
          { value: "messages", label: "Messages" },
          { value: "related", label: related.length > 0 ? `Related · ${related.length}` : "Related" },
        ]}
      />

      {tab === "messages" && <ConversationView turns={record.messages} {...(record.text ? { text: record.text } : {})} {...(record.provider ? { provider: record.provider } : {})} {...(focusTurn !== undefined ? { focusTurn } : {})} className="max-h-[70vh]" />}

      {tab === "insights" &&
        (state !== "analyzed" ? (
          <p className="text-body-sm text-muted-foreground">{record.ingestion !== "ready" ? "Nothing to analyse until its messages are saved." : state === "excluded" ? "Include it in analysis to see what Hubble understood from it." : (PROCESSING_WORDS[state] ?? "Analysing…")}</p>
        ) : (
          <div className="flex flex-col gap-6">
            <section aria-label="About" className="flex flex-col gap-2">
              <p className="text-body-sm text-muted-foreground">
                {extraction?.intent.primary ? (
                  <>
                    Mostly <span className="text-foreground">{INTENT_LABEL[extraction.intent.primary].toLowerCase()}</span>
                    {extraction.intent.secondary ? <> and {INTENT_LABEL[extraction.intent.secondary].toLowerCase()}</> : null} · {confidenceWords(extraction.intent.confidence).toLowerCase()}
                  </>
                ) : (
                  "Too short to tell what kind of work this was."
                )}
              </p>
              {topics.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Topics">
                  {topics.map((topic) => (
                    <li key={topic.term} className="rounded-sm bg-surface-hover px-2 py-0.5 text-body-sm text-foreground">
                      {topic.label}
                    </li>
                  ))}
                </ul>
              )}
              {entities.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Names">
                  {entities.map((entity) => (
                    <li key={entity.id} className="rounded-sm border border-subtle px-2 py-0.5 text-body-sm text-muted-foreground" title={entity.confidence < 1 ? "Found as a repeated name in the text" : undefined}>
                      {entity.name}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {groups.map((group) => (
              <section key={group.title} aria-label={group.title}>
                <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">{group.title}</h3>
                {group.facts.length === 0 ? (
                  <p className="px-2 py-2 text-body-sm text-tertiary">{group.empty}</p>
                ) : (
                  <ul className="mt-1 flex flex-col">
                    {group.facts.map((fact) => (
                      <FactRow key={fact.id} fact={fact} record={recordById.get(fact.recordId) ?? record} {...(settings.facts[fact.id] ? { correction: settings.facts[fact.id] } : {})} onCorrect={(correction) => onCorrect(fact.id, correction)} onShowMessage={showMessage} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
            {resources.length > 0 && (
              <section aria-label="References">
                <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">References</h3>
                <ul className="mt-2 flex flex-col gap-1">
                  {resources.map((entity) => (
                    <li key={entity.id} className="truncate text-body-sm text-muted-foreground">
                      {entity.name}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {memories.length > 0 && (
              <section aria-label="Kept in memory">
                <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">Kept in memory</h3>
                <ul className="mt-1 flex flex-col">
                  {memories.slice(0, 8).map((memory) => (
                    <li key={memory.id} className="flex items-baseline gap-2 px-2 py-1.5 text-body-sm">
                      <span className="w-24 shrink-0 text-meta text-tertiary">{MEMORY_LABEL[memory.category]}</span>
                      <span className="min-w-0 flex-1 text-foreground">{memory.text}</span>
                      {memory.superseded ? <span className="shrink-0 text-meta text-tertiary">History — replaced later</span> : memory.conflict && <span className="shrink-0 text-meta text-warning">A later conversation disagrees</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ))}

      {tab === "related" && (
        <div className="flex flex-col gap-4">
          {thread && (
            <p className="text-body-sm text-muted-foreground">
              Part of <span className="text-foreground">{thread.label}</span> — {thread.recordIds.length} conversations across {thread.providers.map(aiProviderName).join(", ")}.
            </p>
          )}
          {related.length === 0 && suggested.length === 0 && <p className="text-body-sm text-tertiary">No other saved conversation is about the same work.</p>}
          {related.length > 0 && (
            <ul className="flex flex-col">
              {related.map(({ relation, other }) => (
                <RelationRow
                  key={pairKey(relation.a, relation.b)}
                  relation={relation}
                  other={other}
                  now={now}
                  sharedNames={[...relation.sharedEntities.map((id) => index.entities.find((entity) => entity.id === id)?.name ?? id), ...relation.sharedTerms.map((term) => index.extractions.get(other.id)?.spelling[term] ?? term)]}
                  onOpen={() => onOpenRecord(other.id)}
                  onUnrelated={() => onUnrelated(other.id)}
                  {...(onRelated ? { onRelated: () => onRelated(other.id) } : {})}
                  {...(explainMeaning ? { explainMeaning: () => explainMeaning(other.id) } : {})}
                />
              ))}
            </ul>
          )}
          {suggested.length > 0 && (
            <div>
              <p className="mb-1 text-meta text-tertiary">Might be relevant</p>
              <ul className="flex flex-col">
                {suggested.map((entry) => (
                  <li key={entry.record.id}>
                    <button type="button" className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-hover" onClick={() => onOpenRecord(entry.record.id)}>
                      <ProviderMark provider={entry.record.provider} size={14} />
                      <span className="min-w-0 flex-1 truncate text-body text-foreground">{entry.record.title}</span>
                      <span className="shrink-0 text-meta text-tertiary">{entry.why[0]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const MEMORY_LABEL = { working: "Working on", project: "Project", "long-term": "Long-term", episodic: "Milestone" } as const
