"use client"

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { useSharedIntelligence } from "@/hooks/use-intelligence-processor"
import { errorMessage, intelligenceEvents, intelligenceStatus, subscribeIntelligence } from "@/lib/conversations/intelligence/diagnostics"
import { derivedOwner, readRun } from "@/lib/conversations/intelligence/store"
import { formatRelativeTime } from "@/lib/time-format"
import { FieldRow, GroupBlock, GroupLabel, SectionStack } from "./section-ui"
import type { BackfillReport } from "@/lib/conversations/intelligence/backfill"
import type { IntelligenceStatus } from "@/lib/conversations/intelligence/diagnostics"

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`
}

/** What the model is doing, in a sentence — never "ready" unless the worker said it loaded. */
function modelWords(model: IntelligenceStatus["model"], semanticOn: boolean): string {
  if (!semanticOn) return "Not started — Compare by meaning is off."
  switch (model.state) {
    case "not-requested":
      return "Waiting to start."
    case "idle":
      return "Every vector is up to date; the model loads when a question needs it."
    case "loading":
      return "Loading the on-device model…"
    case "ready":
      return `Ready — ${model.source ?? "on-device model"}${model.loadMs !== undefined ? `, loaded in ${seconds(model.loadMs)}` : ""}.`
    case "unavailable":
      return `Unavailable: ${model.reason ?? "it couldn't start here"}. Conversations are linked and searched by words and names.`
  }
}

/**
 * Settings → Conversations → Processing: what the background processor
 * actually did — the last run's counts, each failure with its reason, the
 * model's and the cache's state, and recent warnings. Read from the run's
 * own report and the diagnostics log; nothing here is assumed.
 */
export function IntelligenceStatusPanel({ semanticOn, now }: { semanticOn: boolean; now: number }) {
  const status = useSyncExternalStore(subscribeIntelligence, intelligenceStatus, intelligenceStatus)
  const processor = useSharedIntelligence()
  // A report from an earlier session, until this one's first run reports.
  const [stored, setStored] = useState<BackfillReport | undefined>()
  const [storedError, setStoredError] = useState<string | undefined>()
  useEffect(() => {
    let cancelled = false
    readRun<BackfillReport>(derivedOwner())
      .then((checkpoint) => {
        if (!cancelled && checkpoint) setStored({ ...checkpoint.report, state: checkpoint.state })
      })
      .catch((error) => {
        if (!cancelled) setStoredError(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [])
  const report = (processor?.report ?? (status.report as BackfillReport | undefined)) ?? stored
  const running = processor?.running ?? status.running
  const titles = useMemo(() => new Map((processor?.records ?? []).map((record) => [record.id, record.title])), [processor?.records])
  const failures = useMemo(() => [...(processor?.failed ?? new Map()).entries()].sort((a, b) => b[1].lastAt - a[1].lastAt), [processor?.failed])
  const problems = intelligenceEvents()
    .filter((event) => event.level !== "info")
    .slice(-5)
    .reverse()

  const skipped = report ? Object.values(report.skipped).reduce((sum, value) => sum + value, 0) : 0
  const skippedWhy = report
    ? [
        report.skipped.analysisOff && `${report.skipped.analysisOff} with analysis off`,
        report.skipped.providerOff && `${report.skipped.providerOff} from apps you left out`,
        report.skipped.excluded && `${report.skipped.excluded} you left out`,
        report.skipped.needsText && `${report.skipped.needsText} saved without text`,
        report.skipped.unreadable && `${report.skipped.unreadable} unreadable`,
        report.skipped.textMissing && `${report.skipped.textMissing} whose text isn't on this device`,
        report.skipped.waiting && `${report.skipped.waiting} not loaded yet`,
      ].filter(Boolean)
    : []

  return (
    <>
      <GroupLabel className="mt-6">Processing</GroupLabel>
      <SectionStack>
        <FieldRow
          label={running ? "Working…" : report ? `Last run ${formatRelativeTime(report.finishedAt ?? report.startedAt, now) ?? ""}` : "No run yet"}
          description={
            report
              ? `${plural(report.discovered, "conversation")} found in ${plural(report.projects, "project")}: ${report.alreadyProcessed} already analysed, ${report.processed} analysed${running ? " so far" : ""}${report.failed > 0 ? `, ${report.failed} failed` : ""}${report.backlog > 0 && !running ? `, ${report.backlog} still to do` : ""}.${report.durationMs > 0 && report.processed > 0 ? ` Took ${seconds(report.durationMs)} (${report.throughput}/s).` : ""}${report.state === "cancelled" ? " Stopped early; the rest is done next time." : ""}${report.resumedFrom ? " Picked up after a run that was interrupted." : ""}`
              : storedError
                ? `Couldn't read the last run: ${storedError}`
                : "Hubble analyses saved conversations in the background after it starts."
          }
        >
          {processor && (
            <span className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={running} onClick={() => processor.processNow()}>
                Process now
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={running || failures.length === 0} onClick={() => void processor.retryFailed()}>
                Retry failed
              </Button>
            </span>
          )}
        </FieldRow>
        {report && (skipped > 0 || report.duplicates.identities > 0 || report.unsaved > 0 || report.cacheError) && (
          <GroupBlock>
            <ul className="flex flex-col gap-1 text-body-sm text-muted-foreground">
              {skipped > 0 && <li>Not analysed: {skippedWhy.join(", ")}.</li>}
              {report.skipped.textMissing > 0 && <li>A conversation whose text isn&apos;t on this device is still listed; saving it again from its AI app brings the text back.</li>}
              {report.duplicates.identities > 0 && <li>{plural(report.duplicates.identities, "conversation")} saved in more than one project ({plural(report.duplicates.extraCopies, "extra copy", "extra copies")}) — analysed as one.</li>}
              {report.unsaved > 0 && <li className="text-warning">{plural(report.unsaved, "analysis", "analyses")} couldn&apos;t be kept on this device and will be redone next start.</li>}
              {report.cacheError && <li className="text-warning">The analysis cache couldn&apos;t be read ({report.cacheError}); everything was analysed again.</li>}
            </ul>
          </GroupBlock>
        )}
        <FieldRow label="Meaning vectors" description={`${modelWords(status.model, semanticOn)}${semanticOn && report?.embeddings ? ` ${report.embeddings.current} conversations have current vectors${report.embeddings.missing + report.embeddings.stale > 0 ? `, ${report.embeddings.missing + report.embeddings.stale} still to embed` : ""}.` : ""}`}>
          <span className="text-meta text-tertiary">{semanticOn ? status.model.state.replace("-", " ") : "off"}</span>
        </FieldRow>
        <FieldRow label="Kept across restarts" description={status.storage.lastError ? `Last storage error: ${status.storage.lastError}` : status.storage.persistent ? "Analysis, vectors and this report are kept on this device (IndexedDB) and survive a restart." : "This browser keeps nothing between visits: analysis is redone each time."}>
          <span className={status.storage.lastError ? "text-meta text-warning" : "text-meta text-tertiary"}>{status.storage.lastError ? "error" : status.storage.persistent ? "yes" : "no"}</span>
        </FieldRow>
        {failures.length > 0 && (
          <GroupBlock>
            <p className="mb-1 text-body-sm text-foreground">Couldn&apos;t be analysed</p>
            <ul className="flex flex-col gap-1.5">
              {failures.slice(0, 10).map(([recordId, failure]) => (
                <li key={recordId} className="text-body-sm">
                  <span className="block truncate text-foreground">{titles.get(recordId) ?? recordId}</span>
                  <span className="block text-meta text-tertiary">
                    {failure.code}: {failure.message} · {plural(failure.attempts, "attempt")} · {formatRelativeTime(failure.lastAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          </GroupBlock>
        )}
        {problems.length > 0 && (
          <GroupBlock>
            <p className="mb-1 text-body-sm text-foreground">Recent warnings</p>
            <ul className="flex flex-col gap-1">
              {problems.map((event) => (
                <li key={`${event.at}:${event.kind}:${event.event}`} className="text-meta text-tertiary">
                  {formatRelativeTime(event.at, now)} · {event.kind}/{event.event}
                  {event.message ? `: ${event.message}` : ""}
                </li>
              ))}
            </ul>
          </GroupBlock>
        )}
      </SectionStack>
    </>
  )
}
