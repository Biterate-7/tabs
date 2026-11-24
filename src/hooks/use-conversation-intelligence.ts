"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useIntelligenceProcessor, useSharedIntelligence } from "@/hooks/use-intelligence-processor"
import { buildCorpus, deriveIndex } from "@/lib/conversations/intelligence/corpus"
import { loadIntelligenceSettings, onIntelligenceSettingsSaved, pruneSettings, saveIntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { BackfillReport } from "@/lib/conversations/intelligence/backfill"
import type { CorpusSettings } from "@/lib/conversations/intelligence/corpus"
import type { IntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { SemanticHits, SemanticStatus } from "@/lib/conversations/intelligence/semantic-client"
import type { RecordedFailure } from "@/lib/conversations/intelligence/store"
import type { ConversationIndex, ConversationRecord } from "@/lib/conversations/intelligence/types"
import type { ProjectContents } from "@/hooks/use-project-contents"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Conversation intelligence for the projects given — analysed on this
 * device, in the background, without holding up the page.
 *
 *   ingestion   the conversation is saved, with its text (Save to Hubble, an export)
 *   processing  Hubble has read it for topics, decisions, tasks…
 *               (hooks/use-intelligence-processor → the backfill)
 *
 * The two are separate: a conversation whose analysis failed is still saved
 * and searchable, and analysing it again never means saving it again.
 *
 * Processing is the app's shared processor when the shell provides one (it
 * runs for every project from start-up, so this view opens on analysis that
 * is already done); otherwise this hook runs its own, with the same code.
 *
 * ## The index, in two stages
 *
 * The corpus (relations, threads) is rebuilt only when conversations, their
 * analysis or which ones are in change; facts, memory and insights are
 * derived again on every correction — so correcting a fact never re-scores a
 * pair. The index is never stored: it is rebuilt from the stored analysis,
 * so it is the same after a restart.
 */

export type IntelligenceProgress = {
  /** Conversations with text that analysis covers (not excluded). */
  total: number
  analyzed: number
  failed: number
  /** Analysed this session rather than read from the device's cache. */
  fresh: number
  running: boolean
}

export type ConversationIntelligence = {
  index: ConversationIndex
  records: ConversationRecord[]
  contents: ProjectContents
  settings: IntelligenceSettings
  /** Changes and stores the person's settings; false when the browser would not keep them. */
  updateSettings: (change: (settings: IntelligenceSettings) => IntelligenceSettings) => boolean
  progress: IntelligenceProgress
  /** Where meaning-level matching stands: off, starting, embedding, ready or unavailable (with why). */
  semanticStatus: SemanticStatus
  /** Forget the cached analysis of these records (or all) and read them again. */
  reanalyze: (recordIds?: readonly string[]) => void
  /** Deletes this account's stored embeddings (turning the feature off keeps them until this). */
  forgetEmbeddings: () => Promise<void>
  /** The question's closest conversations by meaning, when the on-device model is ready; undefined otherwise. */
  searchByMeaning: (text: string) => Promise<SemanticHits | undefined>
  /** Why each failed conversation failed. */
  failures: ReadonlyMap<string, RecordedFailure>
  /** The latest processing run's report. */
  report?: BackfillReport
}

const NO_WORKSPACES: readonly Workspace[] = []

export function useConversationIntelligence(workspaces: readonly Workspace[], now: number): ConversationIntelligence {
  const shared = useSharedIntelligence()
  const own = useIntelligenceProcessor(shared ? NO_WORKSPACES : workspaces, { background: false })
  const processor = shared ?? own

  const [settings, setSettings] = useState<IntelligenceSettings>(() => loadIntelligenceSettings())
  // Every change goes through updateSettings (or a save elsewhere), which keeps this current.
  const settingsRef = useRef(settings)
  useEffect(
    () =>
      onIntelligenceSettingsSaved((next) => {
        settingsRef.current = next
        setSettings(next)
      }),
    []
  )

  const updateSettings = useCallback((change: (settings: IntelligenceSettings) => IntelligenceSettings) => {
    const next = change(settingsRef.current)
    if (next === settingsRef.current) return true
    settingsRef.current = next
    setSettings(next)
    return saveIntelligenceSettings(next)
  }, [])

  // The shared processor covers every project; this view shows the ones it was given.
  const shown = useMemo(() => new Set(workspaces.map((workspace) => workspace.id)), [workspaces])
  const records = useMemo(() => (shared ? processor.records.filter((record) => shown.has(record.workspaceId)) : processor.records), [shared, processor.records, shown])
  const failedIds = useMemo(() => new Set(processor.failed.keys()), [processor.failed])

  // What the person said about conversations that are gone goes with them.
  const liveKey = useMemo(() => records.map((record) => `${record.id}=${record.identity}`).join("\n"), [records])
  useEffect(() => {
    const live = { recordIds: new Set<string>(), identities: new Set<string>() }
    for (const line of liveKey.split("\n")) {
      if (!line) continue
      const [id, identity] = line.split("=") as [string, string]
      live.recordIds.add(id)
      live.identities.add(identity)
    }
    const timer = window.setTimeout(() => updateSettings((current) => pruneSettings(current, live)), 0)
    return () => window.clearTimeout(timer)
  }, [liveKey, updateSettings])

  // ── The index, in two stages ──────────────────────────────────────────────
  const { enabled, providers, excluded, unrelated, related, reviews } = settings
  const corpusSettings = useMemo<CorpusSettings>(() => ({ enabled, providers, excluded, unrelated, related, reviews }), [enabled, providers, excluded, unrelated, related, reviews])
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces])
  const semanticInput = settings.semantic ? processor.semantic : undefined
  const extractions = processor.extractions
  const corpus = useMemo(
    () => buildCorpus({ records, extractions, settings: corpusSettings, failed: failedIds, workspaceNames, ...(semanticInput ? { semantic: semanticInput } : {}) }),
    [records, extractions, corpusSettings, failedIds, workspaceNames, semanticInput]
  )
  const index = useMemo(() => deriveIndex(corpus, settings, now), [corpus, settings, now])

  const { running, fresh } = processor
  const progress = useMemo<IntelligenceProgress>(() => {
    let total = 0
    let analyzed = 0
    let failures = 0
    for (const record of records) {
      const state = index.processing.get(record.id)
      if (state === "excluded" || record.ingestion !== "ready") continue
      total += 1
      if (state === "analyzed") analyzed += 1
      if (state === "failed") failures += 1
    }
    return { total, analyzed, failed: failures, fresh, running }
  }, [records, index, running, fresh])

  return {
    index,
    records,
    contents: processor.contents,
    settings,
    updateSettings,
    progress,
    semanticStatus: processor.semanticStatus,
    reanalyze: processor.reanalyze,
    forgetEmbeddings: processor.forgetEmbeddings,
    searchByMeaning: processor.searchByMeaning,
    failures: processor.failed,
    ...(processor.report ? { report: processor.report } : {}),
  }
}
