"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useProjectContents } from "@/hooks/use-project-contents"
import { conversationRecordsOf, recordFingerprint, storageItemId } from "@/lib/conversations/intelligence/canonical"
import { buildCorpus, deriveIndex, isAnalyzable, isCurrent } from "@/lib/conversations/intelligence/corpus"
import { extractConversation } from "@/lib/conversations/intelligence/extract"
import { embeddingChunks } from "@/lib/conversations/intelligence/semantic"
import { createSemanticClient } from "@/lib/conversations/intelligence/semantic-client"
import { loadIntelligenceSettings, pruneSettings, saveIntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import { EXTRACTIONS, derivedKey, derivedOwner, forgetDerived, readDerived, writeDerived } from "@/lib/conversations/intelligence/store"
import { EXTRACTOR_VERSION } from "@/lib/conversations/intelligence/types"
import type { ConversationExtraction, ConversationIndex, ConversationRecord } from "@/lib/conversations/intelligence/types"
import type { CorpusSettings } from "@/lib/conversations/intelligence/corpus"
import type { IntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { SemanticClient, SemanticResult, SemanticStatus } from "@/lib/conversations/intelligence/semantic-client"
import type { CachedExtraction } from "@/lib/conversations/intelligence/store"
import type { ProjectContents } from "@/hooks/use-project-contents"
import type { Workspace } from "@/lib/workspace/types"

/**
 * Conversation intelligence for the projects given — analysed on this
 * device, in the background, without holding up the page.
 *
 *   ingestion   the conversation is saved, with its text (Save to Hubble, an export)
 *   processing  Hubble has read it for topics, decisions, tasks… (here)
 *
 * The two are separate: a conversation whose analysis failed is still saved
 * and searchable, and analysing it again never means saving it again.
 *
 * ## Only what changed is processed again
 *
 * Each conversation's extraction is cached on this device (store.ts), keyed
 * like its text and stamped with its fingerprint and the extractor version:
 * an unchanged conversation is read from the cache, a changed one (or one
 * read by an older extractor) is analysed again. New analysis runs a slice
 * at a time (`BATCH_CHARS`), yielding to the page; progress after each slice
 * is a checkpoint the view shows.
 *
 * The index is built in two stages: the corpus (relations, threads) is
 * rebuilt only when conversations, their analysis or which ones are in
 * change; facts, memory and insights are derived again on every correction —
 * so correcting a fact never re-scores a pair.
 *
 * ## Meaning, when the person turned it on
 *
 * With `settings.semantic`, a worker embeds conversations on this device and
 * reports each one's nearest others (semantic-client.ts). Until it has, and
 * wherever it can't run, relations rest on words and names alone.
 */

const BATCH_CHARS = 400_000
const CACHE_MAX = 10_000

const memory = new Map<string, ConversationExtraction>()

function hasBody(record: ConversationRecord): boolean {
  return record.messages.length > 0 || !!record.text
}

function keyOf(owner: string, record: ConversationRecord): string {
  return derivedKey(owner, record.workspaceId, storageItemId(record))
}

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
}

export function useConversationIntelligence(workspaces: readonly Workspace[], now: number): ConversationIntelligence {
  const contents = useProjectContents(workspaces)
  const [settings, setSettings] = useState<IntelligenceSettings>(() => loadIntelligenceSettings())
  const records = useMemo(() => conversationRecordsOf(workspaces, contents), [workspaces, contents])
  const [extractions, setExtractions] = useState<ReadonlyMap<string, ConversationExtraction>>(() => new Map())
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [running, setRunning] = useState(false)
  const [fresh, setFresh] = useState(0)
  const [generation, setGeneration] = useState(0)
  // Every change goes through updateSettings, which keeps this current.
  const settingsRef = useRef(settings)
  // Records the person asked to analyse again: their cached analysis is ignored once.
  const forced = useRef(new Set<string>())

  const updateSettings = useCallback((change: (settings: IntelligenceSettings) => IntelligenceSettings) => {
    const next = change(settingsRef.current)
    if (next === settingsRef.current) return true
    settingsRef.current = next
    setSettings(next)
    return saveIntelligenceSettings(next)
  }, [])

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

  // Analysis: the device's cache first, then what is new or changed, a slice at a time.
  const { enabled, providers, excluded } = settings
  useEffect(() => {
    let cancelled = false
    let timer = 0
    const owner = derivedOwner()
    const queue = records.filter((record) => isAnalyzable(record, { enabled, providers, excluded }) && hasBody(record))
    const known = new Map<string, ConversationExtraction>()
    const failures = new Set<string>()
    let analyzedHere = 0
    const publish = (done: boolean) => {
      if (cancelled) return
      setExtractions(new Map(known))
      setFailed(new Set(failures))
      setFresh(analyzedHere)
      setRunning(!done)
    }
    void (async () => {
      let stored = new Map<string, CachedExtraction>()
      try {
        stored = new Map((await readDerived<CachedExtraction>(EXTRACTIONS, owner)).map((entry) => [entry.key, entry]))
      } catch {
        // No cache on this device (storage blocked): everything is analysed here.
      }
      if (cancelled) return
      const todo: ConversationRecord[] = []
      for (const record of queue) {
        const key = keyOf(owner, record)
        if (forced.current.has(record.id)) {
          todo.push(record)
          continue
        }
        const cached = memory.get(key) ?? stored.get(key)?.extraction
        if (cached && cached.recordId === record.id && cached.version === EXTRACTOR_VERSION && isCurrent(record, cached)) {
          known.set(record.id, cached)
          continue
        }
        todo.push(record)
      }
      if (known.size > 0) publish(todo.length === 0)
      let position = 0
      const step = () => {
        if (cancelled) return
        let spent = 0
        const written: CachedExtraction[] = []
        while (position < todo.length && spent < BATCH_CHARS) {
          const record = todo[position++]!
          try {
            const extraction = extractConversation(record)
            const key = keyOf(owner, record)
            if (memory.size >= CACHE_MAX) memory.delete(memory.keys().next().value!)
            memory.set(key, extraction)
            written.push({ key, owner, fingerprint: extraction.fingerprint, version: extraction.version, extraction })
            forced.current.delete(record.id)
            known.set(record.id, extraction)
            analyzedHere += 1
            spent += extraction.analyzedChars + 1
          } catch {
            failures.add(record.id)
          }
        }
        void writeDerived(EXTRACTIONS, written).catch(() => undefined)
        const done = position >= todo.length
        publish(done)
        if (!done) timer = window.setTimeout(step, 0)
      }
      timer = window.setTimeout(step, 0)
    })()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [records, enabled, providers, excluded, generation])

  const reanalyze = useCallback(
    (recordIds?: readonly string[]) => {
      const wanted = recordIds ? new Set(recordIds) : undefined
      const owner = derivedOwner()
      for (const record of records) {
        if (wanted && !wanted.has(record.id)) continue
        memory.delete(keyOf(owner, record))
        forced.current.add(record.id)
      }
      setGeneration((value) => value + 1)
    },
    [records]
  )

  // ── Meaning (opt-in) ──────────────────────────────────────────────────────
  const [semantic, setSemantic] = useState<SemanticResult | undefined>(undefined)
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus>({ state: "off", done: 0, total: 0 })
  const [client, setClient] = useState<SemanticClient | null>(null)
  useEffect(() => {
    if (!settings.semantic) return
    const created = createSemanticClient({ status: setSemanticStatus, result: setSemantic })
    // Handing the client to the effect below is this effect's purpose.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(created)
    return () => {
      created.dispose()
      setClient(null)
      setSemantic(undefined)
      setSemanticStatus({ state: "off", done: 0, total: 0 })
    }
  }, [settings.semantic])
  // Only analysed conversations are embedded: excluded ones never reach the model.
  const embeddable = useMemo(() => records.filter((record) => extractions.has(record.id) && isCurrent(record, extractions.get(record.id))), [records, extractions])
  useEffect(() => {
    if (!client || running) return
    const owner = derivedOwner()
    const byKey = new Map(embeddable.map((record) => [keyOf(owner, record), record]))
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

  const forgetEmbeddings = useCallback(async () => {
    const owner = derivedOwner()
    if (client) await client.forget(owner)
    else {
      const { EMBEDDINGS, clearDerived } = await import("@/lib/conversations/intelligence/store")
      await clearDerived(EMBEDDINGS, owner)
    }
    setSemantic(undefined)
  }, [client])

  // A conversation left out of analysis keeps nothing derived from it on the device.
  useEffect(() => {
    const owner = derivedOwner()
    const keys = records.filter((record) => excluded.includes(record.identity)).map((record) => keyOf(owner, record))
    if (keys.length > 0) void forgetDerived(keys).catch(() => undefined)
  }, [records, excluded])

  // ── The index, in two stages ──────────────────────────────────────────────
  const { unrelated, related, reviews } = settings
  const corpusSettings = useMemo<CorpusSettings>(() => ({ enabled, providers, excluded, unrelated, related, reviews }), [enabled, providers, excluded, unrelated, related, reviews])
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces])
  const semanticInput = settings.semantic ? semantic : undefined
  const corpus = useMemo(
    () => buildCorpus({ records, extractions, settings: corpusSettings, failed, workspaceNames, ...(semanticInput ? { semantic: semanticInput } : {}) }),
    [records, extractions, corpusSettings, failed, workspaceNames, semanticInput]
  )
  const index = useMemo(() => deriveIndex(corpus, settings, now), [corpus, settings, now])

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

  return { index, records, contents, settings, updateSettings, progress, semanticStatus, reanalyze, forgetEmbeddings }
}
