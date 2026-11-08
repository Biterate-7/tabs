"use client"

import { useMemo, useState } from "react"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProviderMark } from "@/components/memory/provider-mark"
import { methodsOf, reviewMetrics, reviewOf, reviewQueue } from "@/lib/conversations/intelligence/review"
import { RELATION_LEVEL_LABEL } from "@/lib/conversations/intelligence/types"
import { aiProviderName } from "@/lib/providers/registry"
import { formatRelativeTime } from "@/lib/time-format"
import type { ReviewItem, Rate } from "@/lib/conversations/intelligence/review"
import type { PairReview } from "@/lib/conversations/intelligence/settings"
import type { ConversationIndex, ConversationRecord, RelationLevel } from "@/lib/conversations/intelligence/types"
import type { SemanticStatus } from "@/lib/conversations/intelligence/semantic-client"

/**
 * "Check Hubble's links": the person's own history, reviewed by the person.
 * Hubble shows a pair it linked (or nearly linked) and asks whether they are
 * really related; the answer corrects that pair and counts towards the
 * figures — how often Hubble's links are right, how often it misses one,
 * and how words alone and meaning alone would have done.
 *
 * Opt-in by being opened; everything stays on this device; no conversation
 * moves between projects whatever the answer.
 */
export function LinkReview({
  index,
  reviews,
  records,
  workspaceName,
  semanticStatus,
  semanticOn,
  now,
  onReview,
  onClearReviews,
  onBack,
}: {
  index: ConversationIndex
  reviews: Readonly<Record<string, PairReview>>
  records: ReadonlyMap<string, ConversationRecord>
  workspaceName: (id: string) => string
  semanticStatus: SemanticStatus
  semanticOn: boolean
  now: number
  onReview: (a: string, b: string, review: Omit<PairReview, "at">) => void
  onClearReviews: () => void
  onBack: () => void
}) {
  const [started, setStarted] = useState(Object.keys(reviews).length > 0)
  const queue = useMemo(() => reviewQueue(index, reviews, 12), [index, reviews])
  const metrics = useMemo(() => reviewMetrics(reviews), [reviews])
  const analyzed = [...index.processing.values()].filter((state) => state === "analyzed").length
  const links = index.relations.filter((relation) => !relation.sameConversation && relation.level !== "shared-entity")
  const counts = { words: 0, meaning: 0, both: 0 }
  for (const relation of links) {
    const methods = methodsOf(relation)
    if (methods.length === 2) counts.both += 1
    else if (methods[0] === "words") counts.words += 1
    else if (methods[0] === "meaning") counts.meaning += 1
  }
  const item = queue[0]

  return (
    <div className="flex flex-col gap-6 animate-enter" data-link-review>
      <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={onBack}>
        <ArrowLeft /> All conversations
      </Button>
      <div>
        <h2 className="text-h1 text-foreground">Check Hubble&apos;s links</h2>
        <p className="mt-1 max-w-2xl text-body-sm text-muted-foreground">
          Hubble shows you pairs of your saved conversations it linked, and some it nearly linked. Say whether each pair is really related. Your answers stay on this device, correct those links, and show how accurate Hubble is on your own history.
        </p>
      </div>

      <section aria-label="What was analysed" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Conversations analysed" value={String(analyzed)} />
        <Figure label="Links found" value={String(links.length)} />
        <Figure label="By words only · meaning only · both" value={`${counts.words} · ${counts.meaning} · ${counts.both}`} />
        <Figure label="On-device meaning" value={!semanticOn ? "Off" : semanticStatus.state === "ready" ? "On" : semanticStatus.state === "unavailable" ? "Unavailable" : "Working…"} />
      </section>

      {!started ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-body-sm text-muted-foreground">It takes about a minute for ten pairs. Accuracy figures need a few dozen answers before they mean much.</p>
          <Button type="button" onClick={() => setStarted(true)} disabled={links.length === 0 && index.nearMisses.length === 0}>
            Start checking
          </Button>
          {links.length === 0 && index.nearMisses.length === 0 && <p className="text-meta text-tertiary">Hubble hasn&apos;t linked any of your conversations yet, so there is nothing to check.</p>}
        </div>
      ) : item ? (
        <ReviewCard key={item.key} item={item} records={records} workspaceName={workspaceName} now={now} onAnswer={(verdict, level) => onReview(item.kind === "link" ? item.relation.a : item.nearMiss.a, item.kind === "link" ? item.relation.b : item.nearMiss.b, reviewOf(item, verdict, level))} />
      ) : (
        <p className="text-body-sm text-muted-foreground">Nothing left to check right now. New links appear as you save more conversations.</p>
      )}

      <section aria-label="Accuracy on your history" className="flex flex-col gap-3">
        <h3 className="border-b border-subtle pb-2 text-eyebrow text-tertiary">Accuracy on your history</h3>
        {metrics.reviewed === 0 ? (
          <p className="text-body-sm text-tertiary">No answers yet.</p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
              <Line label="Links that were right" rate={metrics.precision} />
              <Line label="Links that were wrong" rate={metrics.falseLinkRate} />
              <Line label="Near misses that were related (links Hubble missed)" rate={metrics.missed} />
              <Line label="Right kind of link (same problem, project or topic)" rate={metrics.levelAgreement} />
            </dl>
            <table className="w-full max-w-xl text-left text-body-sm" aria-label="By method">
              <thead className="text-meta text-tertiary">
                <tr>
                  <th className="py-1 font-normal">Would have been shown by</th>
                  <th className="py-1 font-normal">Right</th>
                  <th className="py-1 font-normal">Based on</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Words and names alone", metrics.byMethod.words],
                    ["Meaning alone (on-device model)", metrics.byMethod.meaning],
                    ["Hubble (both, with project context)", metrics.byMethod.hybrid],
                  ] as [string, Rate][]
                ).map(([label, rate]) => (
                  <tr key={label} className="border-t border-subtle">
                    <td className="py-1.5 text-foreground">{label}</td>
                    <td className="py-1.5 text-foreground">{rate.value === null ? "—" : `${Math.round(rate.value * 100)}%`}</td>
                    <td className="py-1.5 text-tertiary">{rate.of} answer{rate.of === 1 ? "" : "s"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-meta text-tertiary">
              From {metrics.reviewed} answer{metrics.reviewed === 1 ? "" : "s"}. {metrics.reviewed < 30 ? "Too few to rely on yet." : ""}{" "}
              <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={onClearReviews}>
                Clear my answers
              </button>{" "}
              (the corrections they made stay).
            </p>
          </>
        )}
      </section>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-subtle bg-card px-3 py-2">
      <p className="text-meta text-tertiary">{label}</p>
      <p className="mt-0.5 text-body font-medium text-foreground">{value}</p>
    </div>
  )
}

function Line({ label, rate }: { label: string; rate: Rate }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{rate.value === null ? "—" : `${Math.round(rate.value * 100)}% (of ${rate.of})`}</dd>
    </>
  )
}

function ReviewCard({
  item,
  records,
  workspaceName,
  now,
  onAnswer,
}: {
  item: ReviewItem
  records: ReadonlyMap<string, ConversationRecord>
  workspaceName: (id: string) => string
  now: number
  onAnswer: (verdict: "related" | "unrelated", level?: RelationLevel) => void
}) {
  const pair = item.kind === "link" ? item.relation : item.nearMiss
  const sides = [records.get(pair.a), records.get(pair.b)].filter((record): record is ConversationRecord => !!record)
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-subtle bg-card p-4" data-review-item={item.kind}>
      <p className="text-meta text-tertiary">
        {item.kind === "link" ? `Hubble linked these: ${RELATION_LEVEL_LABEL[item.relation.level].toLowerCase()}` : "Hubble did not link these, but nearly did"}
        {item.methods.length > 0 ? ` · by ${item.methods.join(" and ")}` : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {sides.map((record) => {
          const first = record.messages.find((message) => message.role === "user")?.text ?? record.text ?? ""
          return (
            <div key={record.id} className="min-w-0">
              <p className="flex min-w-0 items-center gap-1.5 text-body text-foreground">
                <ProviderMark provider={record.provider} size={13} />
                <span className="truncate">{record.title}</span>
              </p>
              <p className="text-meta text-tertiary">
                {aiProviderName(record.provider)} · {workspaceName(record.workspaceId)} · {formatRelativeTime(record.updatedAt, now)}
              </p>
              <p className="mt-1 line-clamp-3 text-body-sm text-muted-foreground">{first.slice(0, 300)}</p>
            </div>
          )
        })}
      </div>
      {item.kind === "link" && item.relation.reasons.length > 0 && <p className="text-meta text-tertiary">Hubble&apos;s reasons: {item.relation.reasons.join(" ")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => onAnswer("related", "same-problem")}>
          Same problem
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onAnswer("related", "same-project")}>
          Same project
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onAnswer("related", "related-topic")}>
          Related topic
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onAnswer("unrelated")}>
          Not related
        </Button>
      </div>
    </article>
  )
}
