"use client"

import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import { ArrowRight, ChevronDown, Search, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/ui/page-header"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ProviderMark } from "@/components/memory/provider-mark"
import { ConversationDetail } from "./conversation-detail"
import { LinkReview } from "./link-review"
import { FactRow, InsightCard } from "./parts"
import { ThreadView } from "./thread-view"
import { useConversationIntelligence } from "@/hooks/use-conversation-intelligence"
import { answerQuery, parseQuery } from "@/lib/conversations/intelligence/retrieve"
import { closestMessages } from "@/lib/conversations/intelligence/explain"
import { clearReviews, correctFact, dismissInsight, markRelated, markUnrelated, reviewPair, setExcluded } from "@/lib/conversations/intelligence/settings"
import { INTENT_LABEL } from "@/lib/conversations/intelligence/types"
import { aiProviderName } from "@/lib/providers/registry"
import { subjectName } from "@/lib/product/subjects"
import { formatRelativeTime } from "@/lib/time-format"
import { cn } from "@/lib/utils"
import type { KnowledgeItemRef } from "@/lib/memory/items"
import type { AiProviderId } from "@/lib/providers/registry"
import type { FactCorrection } from "@/lib/conversations/intelligence/settings"
import type { ConversationRecord, Evidence } from "@/lib/conversations/intelligence/types"
import type { QueryAnswer } from "@/lib/conversations/intelligence/retrieve"
import type { SemanticStatus } from "@/lib/conversations/intelligence/semantic-client"
import type { Workspace } from "@/lib/workspace/types"

type Selection = { kind: "record"; id: string; focus?: number } | { kind: "thread"; id: string } | { kind: "review" } | undefined
type Sort = "newest" | "oldest"

/** Where on-device meaning stands, in a few words for the status line. */
function SEMANTIC_WORDS(status: SemanticStatus): string {
  switch (status.state) {
    case "off":
    case "starting":
      return "comparing by meaning…"
    case "loading-model":
      return status.total > 0 ? `getting the on-device model (${Math.round((status.done / status.total) * 100)}%)…` : "getting the on-device model…"
    case "embedding":
      return `comparing by meaning: ${status.done} of ${status.total}…`
    case "ready":
      return "compared by meaning on this device"
    case "unavailable":
      return "meaning comparison unavailable here — linking by words and names"
  }
}

const EXAMPLES = ["What did I decide this week?", "Which questions are still open?", "What did Claude suggest that I later discussed with ChatGPT?"]

/**
 * Conversations: what Hubble understands from the AI conversations the person
 * saved, across every AI app — not which AI sites they visited.
 *
 *     Ask about your conversations ……………………………… [Ask]
 *     Analysed 41 of 42 on this device · nothing leaves it      Settings
 *     ┌ insight ┐ ┌ insight ┐ ┌ insight ┐        why, sources, confidence, dismiss
 *     Across your AI apps: threads              one objective, several apps
 *     All conversations   [app] [project] [newest]   rows → detail
 *
 * Analysis runs on this device (hooks/use-conversation-intelligence). Every
 * answer, insight and fact names the conversation and message it came from;
 * corrections are the person's and win everywhere.
 */
export function ConversationsView({
  workspaces,
  now,
  onOpenItem,
  onOpenUrl,
  onRemoveItem,
  onOpenSettings,
  onSaveFromAi,
  onOpenSidebar,
}: {
  workspaces: readonly Workspace[]
  now: number
  onOpenItem: (workspaceId: string, ref: KnowledgeItemRef, turn?: number) => void
  onOpenUrl: (url: string) => void
  /** Removes the conversation from its project (with the shell's Undo); its text and everything derived go with it. */
  onRemoveItem: (workspaceId: string, ref: KnowledgeItemRef) => void
  onOpenSettings?: () => void
  onSaveFromAi?: () => void
  onOpenSidebar?: () => void
}) {
  const intelligence = useConversationIntelligence(workspaces, now)
  const { index, records, settings, updateSettings, progress, semanticStatus } = intelligence
  const [selection, setSelection] = useState<Selection>()
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState<QueryAnswer | undefined>()
  const [filter, setFilter] = useState("")
  const [provider, setProvider] = useState<AiProviderId | "all">("all")
  const [project, setProject] = useState<string>("all")
  const [sort, setSort] = useState<Sort>("newest")
  const [allInsights, setAllInsights] = useState(false)

  const recordById = useMemo(() => new Map(records.map((record) => [record.id, record])), [records])
  const providers = useMemo(() => [...new Set(records.map((record) => record.provider).filter((id): id is AiProviderId => !!id))], [records])
  const projects = useMemo(() => workspaces.map((workspace) => ({ id: workspace.id, name: subjectName(workspace) })), [workspaces])
  const names = useMemo(() => new Map(projects.map((entry) => [entry.id, entry.name])), [projects])
  const workspaceName = (id: string) => names.get(id) ?? "Project"

  const correct = (factId: string, correction: Omit<FactCorrection, "at">) => {
    if (!updateSettings((current) => correctFact(current, factId, correction, Date.now()))) toast.error("Your correction couldn't be saved in this browser.")
  }
  const open = (recordId: string, evidence?: Evidence) => setSelection({ kind: "record", id: recordId, ...(evidence ? { focus: evidence.messageIndex } : {}) })

  const ask = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setAnswer(undefined)
      return
    }
    setAnswer(answerQuery(index, parseQuery(trimmed, now, projects)))
  }

  const shown = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const list = records.filter((record) => {
      if (provider !== "all" && record.provider !== provider) return false
      if (project !== "all" && record.workspaceId !== project) return false
      if (terms.length === 0) return true
      const haystack = [record.title, aiProviderName(record.provider), names.get(record.workspaceId) ?? "", ...(index.topics.get(record.id) ?? []).map((topic) => topic.label)].join(" ").toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    return sort === "newest" ? list : [...list].reverse()
  }, [records, provider, project, filter, sort, index.topics, names])

  const selectedRecord = selection?.kind === "record" ? recordById.get(selection.id) : undefined
  const selectedThread = selection?.kind === "thread" ? index.threads.find((thread) => thread.id === selection.id) : undefined

  let body: ReactNode
  if (selectedRecord) {
    body = (
      <ConversationDetail
        key={`${selectedRecord.id}:${selection?.kind === "record" ? (selection.focus ?? "") : ""}`}
        record={selectedRecord}
        index={index}
        settings={settings}
        workspaces={workspaces}
        now={now}
        onBack={() => setSelection(undefined)}
        onOpenRecord={(id) => open(id)}
        onOpenInProject={(turn) => onOpenItem(selectedRecord.workspaceId, selectedRecord.ref, turn)}
        onOpenUrl={onOpenUrl}
        onCorrect={correct}
        onExclude={(excluded) => updateSettings((current) => setExcluded(current, selectedRecord.identity, excluded))}
        onUnrelated={(otherId) => updateSettings((current) => markUnrelated(current, selectedRecord.id, otherId))}
        onRelated={(otherId) => updateSettings((current) => markRelated(current, selectedRecord.id, otherId))}
        explainMeaning={async (otherId) => {
          const other = recordById.get(otherId)
          return other ? closestMessages(selectedRecord, other) : undefined
        }}
        onReanalyze={() => intelligence.reanalyze([selectedRecord.id])}
        onDelete={() => {
          setSelection(undefined)
          onRemoveItem(selectedRecord.workspaceId, selectedRecord.ref)
        }}
      />
    )
  } else if (selection?.kind === "review") {
    body = (
      <LinkReview
        index={index}
        reviews={settings.reviews}
        records={recordById}
        workspaceName={workspaceName}
        semanticStatus={semanticStatus}
        semanticOn={settings.semantic}
        now={now}
        onReview={(a, b, review) => {
          if (!updateSettings((current) => reviewPair(current, a, b, review, Date.now()))) toast.error("Your answer couldn't be saved in this browser.")
        }}
        onClearReviews={() => updateSettings((current) => clearReviews(current))}
        onBack={() => setSelection(undefined)}
      />
    )
  } else if (selectedThread) {
    body = <ThreadView thread={selectedThread} index={index} settings={settings} workspaces={workspaces} now={now} onBack={() => setSelection(undefined)} onOpenRecord={open} onCorrect={correct} />
  } else {
    const insights = allInsights ? index.insights : index.insights.slice(0, 3)
    body = (
      <div className="flex flex-col gap-8">
        <section aria-label="Ask">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              ask(question)
            }}
          >
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Ask about your conversations</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
              <Input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about your conversations — what you decided, what's open, where you discussed something" className="h-9 pl-8" />
            </label>
            <Button type="submit" size="lg" disabled={!question.trim()}>
              Ask <ArrowRight />
            </Button>
          </form>
          {!answer && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="rounded-full border border-subtle px-2.5 py-0.5 text-body-sm text-muted-foreground transition-colors duration-(--duration-fast) hover:border-strong hover:text-foreground"
                  onClick={() => {
                    setQuestion(example)
                    ask(example)
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          )}
          {answer && <AnswerPanel answer={answer} recordById={recordById} settings={settings.facts} now={now} onOpen={open} onCorrect={correct} onClear={() => setAnswer(undefined)} workspaceName={workspaceName} />}
        </section>

        <p className="flex flex-wrap items-center gap-x-2 text-meta text-tertiary" role="status">
          {!settings.enabled
            ? "Analysis is off. Your saved conversations are kept and searchable as usual."
            : progress.total === 0
              ? "Nothing to analyse yet."
              : `Analysed ${progress.analyzed} of ${progress.total} conversation${progress.total === 1 ? "" : "s"} on this device${progress.running ? " — working…" : ""} · nothing is sent anywhere`}
          {progress.failed > 0 && <span className="text-warning">· {progress.failed} couldn&apos;t be analysed</span>}
          {settings.enabled && settings.semantic && <span>· {SEMANTIC_WORDS(semanticStatus)}</span>}
          {settings.enabled && progress.analyzed > 1 && (
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setSelection({ kind: "review" })}>
              Check Hubble&apos;s links
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={onOpenSettings}>
              <Settings2 className="size-3" aria-hidden /> Settings
            </button>
          )}
        </p>

        {insights.length > 0 && (
          <section aria-label="Worth a look">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-eyebrow text-tertiary">Worth a look</h2>
              {index.insights.length > 3 && (
                <button type="button" className="text-meta text-muted-foreground hover:text-foreground" onClick={() => setAllInsights((value) => !value)}>
                  {allInsights ? "Show fewer" : `Show all ${index.insights.length}`}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {insights.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  records={recordById}
                  now={now}
                  onOpen={() => (insight.threadId ? setSelection({ kind: "thread", id: insight.threadId }) : insight.evidence[0] ? open(insight.evidence[0].recordId, insight.evidence[0]) : open(insight.recordIds[0]!))}
                  onDismiss={() => updateSettings((current) => dismissInsight(current, insight.id))}
                />
              ))}
            </div>
          </section>
        )}

        {index.threads.length > 0 && (
          <section aria-label="Across your AI apps">
            <h2 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">Threads — one piece of work, several conversations</h2>
            <ul className="mt-1 flex flex-col">
              {index.threads.slice(0, 8).map((thread) => (
                <li key={thread.id}>
                  <button type="button" className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-hover" onClick={() => setSelection({ kind: "thread", id: thread.id })}>
                    <span className="flex shrink-0 -space-x-1">
                      {thread.providers.map((id) => (
                        <span key={id} className="grid size-5 place-items-center rounded-full border border-subtle bg-card">
                          <ProviderMark provider={id} size={11} />
                        </span>
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-foreground">{thread.label}</span>
                      <span className="block truncate text-meta text-tertiary">
                        {thread.recordIds.length} conversations · {thread.workspaceIds.map(workspaceName).join(", ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-meta text-tertiary">{formatRelativeTime(thread.updatedAt, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="All conversations">
          <div className="flex flex-wrap items-center gap-2 border-b border-subtle pb-2">
            <h2 className="mr-auto text-eyebrow text-tertiary">All conversations · {records.length}</h2>
            <label className="relative min-w-0 sm:w-56">
              <span className="sr-only">Filter conversations</span>
              <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by title or topic" className="h-7" />
            </label>
            {providers.length > 1 && (
              <div className="flex items-center gap-0.5 rounded-md border border-subtle p-0.5" role="group" aria-label="AI app">
                <button type="button" aria-pressed={provider === "all"} onClick={() => setProvider("all")} className={cn("h-6 rounded-sm px-2 text-body-sm", provider === "all" ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  Any app
                </button>
                {providers.map((id) => (
                  <button key={id} type="button" aria-pressed={provider === id} aria-label={aiProviderName(id)} title={aiProviderName(id)} onClick={() => setProvider(id)} className={cn("grid h-6 w-7 place-items-center rounded-sm", provider === id ? "bg-surface-selected" : "opacity-60 hover:opacity-100")}>
                    <ProviderMark provider={id} size={14} />
                  </button>
                ))}
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="ghost" size="sm" aria-label="Choose project and order">
                    {project === "all" ? "All projects" : workspaceName(project)} · {sort === "newest" ? "Newest" : "Oldest"}
                    <ChevronDown className="opacity-60" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="max-h-80 min-w-52">
                <DropdownMenuRadioGroup value={project} onValueChange={(value) => setProject(String(value))}>
                  <DropdownMenuRadioItem value="all">All projects</DropdownMenuRadioItem>
                  {projects.map((entry) => (
                    <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as Sort)}>
                  <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {records.length === 0 ? (
            <div className="mt-12 flex flex-col items-center gap-2 text-center animate-fade">
              <p className="text-body text-foreground">No AI conversations saved yet</p>
              <p className="max-w-md text-body-sm text-muted-foreground">
                Save a conversation from ChatGPT, Claude, Gemini or Perplexity with Hubble for Chrome, or import a ChatGPT or Claude export into a project. Hubble then reads what you decided, what&apos;s open and how your conversations connect — on this device.
              </p>
              {onSaveFromAi && (
                <Button type="button" variant="secondary" size="lg" className="mt-2" onClick={onSaveFromAi}>
                  How to save conversations
                </Button>
              )}
            </div>
          ) : shown.length === 0 ? (
            <p className="mt-6 text-center text-body-sm text-muted-foreground">Nothing matches that.</p>
          ) : (
            <ul className="mt-1 flex flex-col">
              {shown.map((record) => (
                <li key={record.id}>
                  <ConversationRow record={record} topics={(index.topics.get(record.id) ?? []).slice(0, 3).map((topic) => topic.label)} intent={index.extractions.get(record.id)?.intent.primary} state={index.processing.get(record.id)} project={workspaceName(record.workspaceId)} now={now} onOpen={() => open(record.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="min-h-screen" data-conversations>
      <PageHeader title="Conversations" {...(onOpenSidebar ? { onOpenSidebar } : {})} />
      <main className="mx-auto w-full max-w-[960px] px-4 pt-6 pb-16 sm:px-8">
        <h1 className="sr-only">AI conversations</h1>
        {body}
      </main>
    </div>
  )
}

const STATE_WORDS: Record<string, string | undefined> = { pending: "Analysing…", excluded: "Not analysed", failed: "Couldn't analyse", analyzed: undefined }

function ConversationRow({ record, topics, intent, state, project, now, onOpen }: { record: ConversationRecord; topics: string[]; intent?: keyof typeof INTENT_LABEL; state?: string; project: string; now: number; onOpen: () => void }) {
  const status = record.ingestion !== "ready" ? "Link only — text not saved" : state ? STATE_WORDS[state] : undefined
  return (
    <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-[background-color] duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60">
      <ProviderMark provider={record.provider} size={16} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-foreground">{record.title}</span>
        <span className="block truncate text-meta text-tertiary">{[project, intent ? INTENT_LABEL[intent] : undefined, topics.length > 0 ? topics.join(", ") : undefined, record.messages.length > 0 ? `${record.messages.length} messages` : undefined, status].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="w-20 shrink-0 text-right text-meta text-tertiary max-sm:hidden">{formatRelativeTime(record.updatedAt, now)}</span>
    </button>
  )
}

function AnswerPanel({
  answer,
  recordById,
  settings,
  now,
  onOpen,
  onCorrect,
  onClear,
  workspaceName,
}: {
  answer: QueryAnswer
  recordById: ReadonlyMap<string, ConversationRecord>
  settings: Readonly<Record<string, FactCorrection>>
  now: number
  onOpen: (recordId: string, evidence?: Evidence) => void
  onCorrect: (factId: string, correction: Omit<FactCorrection, "at">) => void
  onClear: () => void
  workspaceName: (id: string) => string
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-subtle bg-card p-4 animate-rise" aria-live="polite" data-answer={answer.enough ? "found" : "none"}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-body text-foreground">{answer.summary}</p>
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
      {answer.facts.length > 0 && (
        <ul className="flex flex-col">
          {answer.facts.map(({ fact, record, why }) => (
            <FactRow key={fact.id} fact={fact} record={record} {...(settings[fact.id] ? { correction: settings[fact.id] } : {})} {...(why ? { note: why } : {})} onCorrect={(correction) => onCorrect(fact.id, correction)} onShowMessage={(evidence) => onOpen(evidence.recordId, evidence)} showSource />
          ))}
        </ul>
      )}
      {answer.query.focus === "conversations" && answer.conversations.length > 0 && (
        <ul className="flex flex-col">
          {answer.conversations.map((entry) => {
            const record = recordById.get(entry.record.id) ?? entry.record
            return (
              <li key={record.id}>
                <button type="button" className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-hover" onClick={() => onOpen(record.id, entry.evidence)}>
                  <ProviderMark provider={record.provider} size={14} className="mt-1" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-foreground">{record.title}</span>
                    <span className="block truncate text-meta text-tertiary">{[workspaceName(record.workspaceId), formatRelativeTime(record.updatedAt, now), ...entry.why].join(" · ")}</span>
                    {entry.evidence && (
                      <span className="mt-1 block line-clamp-2 text-body-sm text-muted-foreground">
                        {entry.evidence.role === "user" ? "You" : aiProviderName(record.provider)}: {entry.evidence.quote}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
