"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useProjectContents } from "@/hooks/use-project-contents"
import { clearFailures, embeddingCoverage, forgetSessionAnalysis, recordKey, runBackfill } from "@/lib/conversations/intelligence/backfill"
import { conversationRecordsOf, recordFingerprint } from "@/lib/conversations/intelligence/canonical"
import { isCurrent } from "@/lib/conversations/intelligence/corpus"
import { errorMessage, intelligenceStatus, logIntelligence, updateIntelligenceStatus } from "@/lib/conversations/intelligence/diagnostics"
import { RETRIEVAL_CONFIG } from "@/lib/conversations/intelligence/retrieve"
import { EMBEDDING_KEY, embeddingChunks } from "@/lib/conversations/intelligence/semantic"
import { createSemanticClient } from "@/lib/conversations/intelligence/semantic-client"
import { loadIntelligenceSettings, onIntelligenceSettingsSaved } from "@/lib/conversations/intelligence/settings"
import { EMBEDDINGS, derivedOwner, derivedStorePersistent, forgetDerived, readDerived } from "@/lib/conversations/intelligence/store"
import type { ProjectContents } from "@/hooks/use-project-contents"
import type { BackfillReport } from "@/lib/conversations/intelligence/backfill"
import type { SemanticClient, SemanticHits, SemanticResult, SemanticStatus } from "@/lib/conversations/intelligence/semantic-client"
import type { IntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { CachedEmbedding, RecordedFailure } from "@/lib/conversations/intelligence/store"
import type { ConversationExtraction, ConversationRecord } from "@/lib/conversations/intelligence/types"
import type { ResourceContent } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The one place saved conversations are processed: extraction (through the
 * resumable backfill, lib/conversations/intelligence/backfill.ts), meaning
 * vectors (the embedding worker, when the person turned it on) and search by
 * meaning.
 *
 * The app runs one, for every project, in the background
 * (`IntelligenceProvider`, mounted by AppShell): conversations saved before
 * — or while Hubble was closed — are analysed after start without opening
 * any view, a run interrupted by quitting carries on at the next start, and
 * every view reads the same results. A view used on its own (a test, a
 * screen outside the shell) runs its own with `background: false`: the same
 * code, without the start-up delay or the stored checkpoint.
 */

export type IntelligenceProcessor = {
  records: ConversationRecord[]
  contents: ProjectContents
  settings: IntelligenceSettings
  extractions: ReadonlyMap<string, ConversationExtraction>
  /** Conversations whose analysis failed, with why — by record id. */
  failed: ReadonlyMap<string, RecordedFailure>
  running: boolean
  /** Analysed this session rather than read from the device's cache. */
  fresh: number
  /** The latest run's report. */
  report?: BackfillReport
  semantic?: SemanticResult
  semanticStatus: SemanticStatus
  /** Asks the on-device model which conversations are closest to the text; undefined where it can't. */
  searchByMeaning: (text: string) => Promise<SemanticHits | undefined>
  reanalyze: (recordIds?: readonly string[]) => void
  /** Forgets recorded failures and tries those conversations again. */
  retryFailed: () => Promise<void>
  /** Starts a run now (it does nothing to what is current). */
  processNow: () => void
  forgetEmbeddings: () => Promise<void>
}

export const IntelligenceContext = createContext<IntelligenceProcessor | null>(null)

/** The app's shared processor, when the shell provides one. */
export function useSharedIntelligence(): IntelligenceProcessor | null {
  return useContext(IntelligenceContext)
}

/** Waits this long after start, and after the last change, before a background run — the app's own start comes first. */
const BACKGROUND_DELAY_MS = 1_500

// Records per project, reused while neither the project nor its loaded text changed: building them hashes every message.
const recordsMemo = new WeakMap<object, { contents: ReadonlyMap<string, ResourceContent> | undefined; records: ConversationRecord[] }>()

function recordsOf(workspaces: readonly Workspace[], contents: ProjectContents): ConversationRecord[] {
  const out: ConversationRecord[] = []
  for (const workspace of workspaces) {
    const own = contents.get(workspace.id)
    const hit = recordsMemo.get(workspace)
    if (hit && hit.contents === own) {
      out.push(...hit.records)
      continue
    }
    const records = conversationRecordsOf([workspace], contents)
    recordsMemo.set(workspace, { contents: own, records })
    out.push(...records)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
}

export function useIntelligenceProcessor(workspaces: readonly Workspace[], options: { background: boolean }): IntelligenceProcessor {
  const { background } = options
  const active = workspaces.length > 0
  const contents = useProjectContents(workspaces)
  const [settings, setSettings] = useState<IntelligenceSettings>(() => loadIntelligenceSettings())
  // The person's choices, wherever they were made (Settings, a conversation's page).
  useEffect(() => onIntelligenceSettingsSaved(setSettings), [])

  const records = useMemo(() => recordsOf(workspaces, contents), [workspaces, contents])
  const loaded = useCallback((workspaceId: string) => contents.has(workspaceId), [contents])
  const [extractions, setExtractions] = useState<ReadonlyMap<string, ConversationExtraction>>(() => new Map())
  const [failed, setFailed] = useState<ReadonlyMap<string, RecordedFailure>>(() => new Map())
  const [running, setRunning] = useState(false)
  const [fresh, setFresh] = useState(0)
  const [report, setReport] = useState<BackfillReport | undefined>()
  const [generation, setGeneration] = useState(0)
  // Records the person asked to analyse again: their cached analysis is ignored once.
  const forced = useRef(new Set<string>())

  // ── Extraction: everything saved, now and before ─────────────────────────
  const { enabled, providers, excluded } = settings
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const timer = window.setTimeout(
      () => {
        if (cancelled) return
        if (background) updateIntelligenceStatus({ running: true, storage: { persistent: derivedStorePersistent() } })
        runBackfill({
          records,
          owner: derivedOwner(),
          settings: { enabled, providers, excluded },
          loaded,
          forced: new Set(forced.current),
          cancelled: () => cancelled,
          checkpoint: background,
          onAnalyzed: (record) => forced.current.delete(record.id),
          onProgress: (progress) => {
            if (cancelled) return
            setExtractions(progress.known)
            setFailed(progress.failed)
            setFresh(progress.report.processed)
            setRunning(!progress.done)
            setReport(progress.report)
          },
        })
          .then((done) => {
            if (background) updateIntelligenceStatus({ running: false, report: done })
          })
          .catch(() => {
            // runBackfill logged why; the views say analysis isn't running rather than "working…" forever.
            if (!cancelled) setRunning(false)
            if (background) updateIntelligenceStatus({ running: false })
          })
      },
      background ? BACKGROUND_DELAY_MS : 0
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, background, records, loaded, enabled, providers, excluded, generation])

  const reanalyze = useCallback(
    (recordIds?: readonly string[]) => {
      const wanted = recordIds ? new Set(recordIds) : undefined
      const owner = derivedOwner()
      const keys: string[] = []
      for (const record of records) {
        if (wanted && !wanted.has(record.id)) continue
        keys.push(recordKey(owner, record))
        forced.current.add(record.id)
      }
      forgetSessionAnalysis(keys)
      setGeneration((value) => value + 1)
    },
    [records]
  )

  const retryFailed = useCallback(async () => {
    const owner = derivedOwner()
    const byId = new Map(records.map((record) => [record.id, record]))
    const keys = [...failed.keys()].map((id) => byId.get(id)).filter((record): record is ConversationRecord => !!record).map((record) => recordKey(owner, record))
    try {
      await clearFailures(keys)
    } catch (error) {
      logIntelligence({ level: "error", kind: "store", event: "clear-failures-failed", message: errorMessage(error) })
    }
    setGeneration((value) => value + 1)
  }, [records, failed])

  const processNow = useCallback(() => setGeneration((value) => value + 1), [])

  // A conversation left out of analysis keeps nothing derived from it on the device.
  useEffect(() => {
    if (!active) return
    const owner = derivedOwner()
    const keys = records.filter((record) => excluded.includes(record.identity)).map((record) => recordKey(owner, record))
    if (keys.length > 0) void forgetDerived(keys).catch((error) => logIntelligence({ level: "error", kind: "store", event: "forget-excluded-failed", message: errorMessage(error) }))
  }, [active, records, excluded])

  // ── Meaning (opt-in) ──────────────────────────────────────────────────────
  const semanticOn = active && settings.semantic
  const [semantic, setSemantic] = useState<SemanticResult | undefined>(undefined)
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus>({ state: "off", done: 0, total: 0 })
  const [client, setClient] = useState<SemanticClient | null>(null)
  useEffect(() => {
    if (!semanticOn) return
    const created = createSemanticClient({
      status: (status) => {
        setSemanticStatus(status)
        if (status.state === "loading-model") updateIntelligenceStatus({ model: { state: "loading" } })
        else if (status.state === "ready" && intelligenceStatus().model.state !== "ready") updateIntelligenceStatus({ model: { state: "idle" } })
        else if (status.state === "unavailable") {
          updateIntelligenceStatus({ model: { state: "unavailable", reason: status.message ?? "The on-device model could not start here." } })
          logIntelligence({ level: "warn", kind: "model", event: "unavailable", message: status.message ?? "The on-device model could not start here." })
        }
      },
      result: setSemantic,
      model: ({ source, loadMs }) => {
        updateIntelligenceStatus({ model: { state: "ready", source, loadMs } })
        logIntelligence({ level: "info", kind: "model", event: "loaded", data: { source, loadMs } })
      },
    })
    // Handing the client to the effects below is this effect's purpose.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(created)
    return () => {
      created.dispose()
      setClient(null)
      setSemantic(undefined)
      setSemanticStatus({ state: "off", done: 0, total: 0 })
    }
  }, [semanticOn])
  // Only analysed conversations are embedded: excluded ones never reach the model.
  const embeddable = useMemo(() => records.filter((record) => extractions.has(record.id) && isCurrent(record, extractions.get(record.id))), [records, extractions])
  useEffect(() => {
    if (!client || running) return
    const owner = derivedOwner()
    const byKey = new Map(embeddable.map((record) => [recordKey(owner, record), record]))
    client.sync(
      owner,
      [...byKey].map(([key, record]) => ({ key, recordId: record.id, fingerprint: recordFingerprint(record) })),
      function* (keys) {
        for (const key of keys) {
          const record = byKey.get(key)
          if (record) yield { key, chunks: embeddingChunks(record) }
        }
      }
    )
  }, [client, embeddable, running])

  // What the stored vectors cover, once the model has caught up — in the report, not a guess.
  const ready = semanticStatus.state === "ready"
  useEffect(() => {
    if (!background || !ready) return
    let cancelled = false
    const owner = derivedOwner()
    readDerived<CachedEmbedding>(EMBEDDINGS, owner)
      .then((stored) => {
        if (cancelled) return
        const coverage = embeddingCoverage(owner, records, new Set(embeddable.map((record) => record.id)), stored, EMBEDDING_KEY)
        setReport((current) => (current ? { ...current, embeddings: coverage } : current))
        logIntelligence({ level: coverage.missing + coverage.stale > 0 ? "warn" : "info", kind: "embedding", event: "coverage", data: coverage })
      })
      .catch((error) => logIntelligence({ level: "error", kind: "store", event: "embedding-read-failed", message: errorMessage(error) }))
    return () => {
      cancelled = true
    }
  }, [background, ready, records, embeddable])
  useEffect(() => {
    if (background && report) updateIntelligenceStatus({ report })
  }, [background, report])

  const searchByMeaning = useCallback(
    async (text: string) => {
      if (!client || semanticStatus.state !== "ready") return undefined
      try {
        const result = await client.search(derivedOwner(), text, { floor: RETRIEVAL_CONFIG.semanticFloor })
        // Never the question's words: how long, how many were searched, how many came close.
        logIntelligence({ level: "info", kind: "search", event: "meaning", data: { ms: result.ms, searched: result.searched, hits: result.hits.size } })
        return result.hits
      } catch (error) {
        logIntelligence({ level: "warn", kind: "search", event: "meaning-failed", message: errorMessage(error) })
        return undefined
      }
    },
    [client, semanticStatus.state]
  )

  const forgetEmbeddings = useCallback(async () => {
    const owner = derivedOwner()
    if (client) await client.forget(owner)
    else {
      const { EMBEDDINGS: store, clearDerived } = await import("@/lib/conversations/intelligence/store")
      await clearDerived(store, owner)
    }
    setSemantic(undefined)
  }, [client])

  return useMemo(
    () => ({
      records,
      contents,
      settings,
      extractions,
      failed,
      running,
      fresh,
      ...(report ? { report } : {}),
      ...(semantic ? { semantic } : {}),
      semanticStatus,
      searchByMeaning,
      reanalyze,
      retryFailed,
      processNow,
      forgetEmbeddings,
    }),
    [records, contents, settings, extractions, failed, running, fresh, report, semantic, semanticStatus, searchByMeaning, reanalyze, retryFailed, processNow, forgetEmbeddings]
  )
}

