import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BACKFILL, clearFailures, embeddingCoverage, planBackfill, readFailures, recordKey, resetBackfillForTests, runBackfill } from "./backfill"
import { recordFingerprint } from "./canonical"
import { intelligenceEvents, resetIntelligenceDiagnosticsForTests } from "./diagnostics"
import { extractConversation } from "./extract"
import { DEFAULT_INTELLIGENCE_SETTINGS } from "./settings"
import { EXTRACTIONS, FAILURES, forgetDerived, readDerived, readRun, resetDerivedStoreForTests, runKey, writeDerived, writeRun } from "./store"
import { EXTRACTOR_VERSION } from "./types"
import { NOW, a, photosynthesisChat, record, storageChoiceChat, syncBugChat, u } from "./__fixtures__/conversations"
import { syntheticCorpus } from "./__fixtures__/synthetic"
import type { BackfillReport } from "./backfill"
import type { CachedExtraction, FailureEntry } from "./store"
import type { ConversationRecord } from "./types"

/**
 * The historical backfill: every saved conversation is analysed once, a run
 * can stop anywhere and the next carries on, failures are kept with why
 * (never the text), and nothing current is redone or duplicated.
 */

const SETTINGS = { enabled: true, providers: {}, excluded: [] as string[] }
let owner = ""
let counter = 0

beforeEach(() => {
  resetDerivedStoreForTests()
  resetBackfillForTests()
  resetIntelligenceDiagnosticsForTests()
  // Each test its own account: fake-indexeddb keeps one database for the file.
  owner = `acct${++counter}`
})
afterEach(() => vi.restoreAllMocks())

const fast = { pause: () => Promise.resolve(), sleep: () => Promise.resolve() }
const corpus = () => [syncBugChat(), storageChoiceChat(), photosynthesisChat()]

describe("planning", () => {
  it("classifies every conversation, with why it is or isn't analysed", () => {
    const current = syncBugChat()
    const changed = storageChoiceChat()
    const outdated = photosynthesisChat()
    const cachedChanged = extractConversation(changed)
    const cached = new Map<string, CachedExtraction>([
      [recordKey(owner, current), { key: recordKey(owner, current), owner, fingerprint: recordFingerprint(current), version: EXTRACTOR_VERSION, extraction: extractConversation(current) }],
      // Analysed from an earlier save: the fingerprint no longer matches.
      [recordKey(owner, changed), { key: recordKey(owner, changed), owner, fingerprint: "old", version: EXTRACTOR_VERSION, extraction: { ...cachedChanged, fingerprint: "old" } }],
      [recordKey(owner, outdated), { key: recordKey(owner, outdated), owner, fingerprint: recordFingerprint(outdated), version: EXTRACTOR_VERSION - 1, extraction: { ...extractConversation(outdated), version: EXTRACTOR_VERSION - 1 } }],
    ])
    const missing = record("new-one", [u("How do I configure Vite aliases?"), a("Use resolve.alias in vite.config.ts.")])
    const excluded = record("left-out", [u("Private thing")], { identity: "chatgpt:chat:left-out" })
    const noText = { ...record("no-text", []), ingestion: "needs-text" as const }
    const unreadable = { ...record("unreadable", []), ingestion: "unreadable" as const }
    const lost = record("lost", []) // the project says text was saved; the store has none
    const otherProject = record("waiting", [u("Hello there")], { workspaceId: "w9" })
    const perplexity = record("pplx", [u("Search for flights")], { provider: "perplexity" })
    const plan = planBackfill({
      records: [current, changed, outdated, missing, excluded, noText, unreadable, lost, otherProject, perplexity],
      owner,
      settings: { enabled: true, providers: { perplexity: false }, excluded: ["chatgpt:chat:left-out"] },
      cached,
      failures: new Map(),
      loaded: (id) => id !== "w9",
    })
    const state = Object.fromEntries(plan.entries.map((entry) => [entry.recordId, entry.state]))
    expect(state).toEqual({
      [current.id]: "current",
      [changed.id]: "changed",
      [outdated.id]: "outdated",
      [missing.id]: "missing",
      [excluded.id]: "excluded",
      [noText.id]: "needs-text",
      [unreadable.id]: "unreadable",
      [lost.id]: "text-missing",
      [otherProject.id]: "waiting",
      [perplexity.id]: "provider-off",
    })
    expect(plan.todo.map((entry) => entry.id).sort()).toEqual([changed.id, missing.id, outdated.id].sort())
    expect([...plan.known.keys()]).toEqual([current.id])
  })

  it("turns everything off when analysis is off, and counts the same conversation saved twice once", () => {
    const inW1 = syncBugChat()
    const inW2 = syncBugChat({ workspaceId: "w2" })
    expect(inW1.identity).toBe(inW2.identity)
    const off = planBackfill({ records: [inW1, inW2], owner, settings: { ...SETTINGS, enabled: false }, cached: new Map(), failures: new Map() })
    expect(off.counts["analysis-off"]).toBe(2)
    expect(off.todo).toEqual([])
    expect(off.duplicates).toEqual({ identities: 1, extraCopies: 1 })
  })
})

describe("running", () => {
  it("analyses what is missing, keeps it, and does nothing the second time (idempotent)", async () => {
    const records = corpus()
    const first = await runBackfill({ records, owner, settings: SETTINGS, deps: fast, checkpoint: true })
    expect(first).toMatchObject({ state: "complete", discovered: 3, eligible: 3, alreadyProcessed: 0, needed: 3, processed: 3, failed: 0, backlog: 0, unsaved: 0 })
    expect((await readDerived<CachedExtraction>(EXTRACTIONS, owner)).length).toBe(3)

    // A new page (restart): nothing in memory, everything on the device.
    resetBackfillForTests()
    const extract = vi.fn(extractConversation)
    const second = await runBackfill({ records: corpus(), owner, settings: SETTINGS, deps: { ...fast, extract }, checkpoint: true })
    expect(second).toMatchObject({ state: "complete", alreadyProcessed: 3, needed: 0, processed: 0 })
    expect(extract).not.toHaveBeenCalled()
    expect((await readDerived<CachedExtraction>(EXTRACTIONS, owner)).length).toBe(3)
    expect((await readRun<BackfillReport>(owner))?.state).toBe("complete")
  })

  it("redoes only what changed or what an older extractor read", async () => {
    const records = corpus()
    await runBackfill({ records, owner, settings: SETTINGS, deps: fast })
    const [sync, storage, photo] = records as [ConversationRecord, ConversationRecord, ConversationRecord]
    const grown = record("sync-bug", [...sync.messages.map((message) => ({ role: message.role, text: message.text })), u("It works now on Safari too.")], { title: sync.title })
    const old = { ...extractConversation(photo), version: EXTRACTOR_VERSION - 1 }
    await writeDerived(EXTRACTIONS, [{ key: recordKey(owner, photo), owner, fingerprint: old.fingerprint, version: old.version, extraction: old }])
    resetBackfillForTests()
    const extract = vi.fn(extractConversation)
    const report = await runBackfill({ records: [grown, storage, photo], owner, settings: SETTINGS, deps: { ...fast, extract } })
    expect(report.reasons).toMatchObject({ changed: 1, outdated: 1, missing: 0 })
    expect(extract.mock.calls.map(([entry]) => entry.id).sort()).toEqual([grown.id, photo.id].sort())
    // Updated in place: still one entry per conversation.
    expect((await readDerived<CachedExtraction>(EXTRACTIONS, owner)).length).toBe(3)
  })

  it("stops between slices when cancelled, and the next run carries on without redoing or duplicating", async () => {
    const { records } = syntheticCorpus(60, 3)
    let slices = 0
    const first = await runBackfill({ records, owner, settings: SETTINGS, batchChars: 5_000, deps: { ...fast, pause: async () => void (slices += 1) }, cancelled: () => slices >= 2, checkpoint: true })
    expect(first.state).toBe("cancelled")
    expect(first.processed).toBeGreaterThan(0)
    expect(first.processed).toBeLessThan(60)
    expect(first.backlog).toBe(60 - first.processed)

    resetBackfillForTests()
    const extract = vi.fn(extractConversation)
    const second = await runBackfill({ records, owner, settings: SETTINGS, deps: { ...fast, extract }, checkpoint: true })
    expect(second.alreadyProcessed).toBe(first.processed)
    expect(second.processed).toBe(60 - first.processed)
    expect(extract).toHaveBeenCalledTimes(60 - first.processed)
    const stored = await readDerived<CachedExtraction>(EXTRACTIONS, owner)
    expect(stored.length).toBe(60)
    expect(new Set(stored.map((entry) => entry.key)).size).toBe(60)
  })

  it("says when it picks up after a run that crashed mid-way", async () => {
    // What a run leaves behind if the app is killed: its checkpoint still says "running".
    await writeRun({ key: runKey(owner), owner, runId: "crashed-run", state: "running", startedAt: NOW, updatedAt: NOW, report: { processed: 7, needed: 20 } as BackfillReport })
    const report = await runBackfill({ records: corpus(), owner, settings: SETTINGS, deps: fast, checkpoint: true })
    expect(report.resumedFrom).toBe("crashed-run")
    expect(intelligenceEvents().some((event) => event.event === "resumed-interrupted-run")).toBe(true)
    const stored = await readRun<BackfillReport>(owner)
    expect(stored).toMatchObject({ state: "complete", resumedFrom: "crashed-run" })
  })
})

describe("failures", () => {
  const SECRET = "The quarterly numbers are confidential"
  const fragile = () => record("fragile", [u(`${SECRET}. How do I chart them?`), a("Use a bar chart.")], { title: "Private numbers" })
  const failOn = (id: string) => (entry: ConversationRecord) => {
    if (entry.id === id) throw new TypeError("Cannot read properties of undefined (reading 'facts')")
    return extractConversation(entry)
  }

  it("records each failure with its reason — never the conversation's text — and goes on with the rest", async () => {
    const bad = fragile()
    const report = await runBackfill({ records: [...corpus(), bad], owner, settings: SETTINGS, deps: { ...fast, extract: failOn(bad.id) }, checkpoint: true })
    expect(report).toMatchObject({ processed: 3, failed: 1, givenUp: 0 })
    const [entry] = await readFailures(owner)
    expect(entry).toMatchObject({ recordId: bad.id, stages: { extraction: { stage: "extraction", code: "extract-threw", attempts: 1, version: EXTRACTOR_VERSION } } })
    expect(entry!.stages.extraction!.message).toContain("Cannot read properties of undefined")
    // Neither the stored failure, the report nor the log holds what the person wrote.
    expect(JSON.stringify(entry)).not.toContain(SECRET)
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(JSON.stringify(intelligenceEvents())).not.toContain(SECRET)
    expect(JSON.stringify(intelligenceEvents())).not.toContain("Private numbers")
  })

  it("tries again on later runs, gives up after maxAttempts for the same save, and retries a new save", async () => {
    const bad = fragile()
    const extract = vi.fn(failOn(bad.id))
    for (let attempt = 1; attempt <= BACKFILL.maxAttempts; attempt++) {
      resetBackfillForTests()
      const report = await runBackfill({ records: [bad], owner, settings: SETTINGS, deps: { ...fast, extract } })
      expect(report.failed).toBe(1)
      expect((await readFailures(owner))[0]!.stages.extraction!.attempts).toBe(attempt)
    }
    resetBackfillForTests()
    const givenUp = await runBackfill({ records: [bad], owner, settings: SETTINGS, deps: { ...fast, extract } })
    expect(givenUp).toMatchObject({ needed: 0, failed: 0, givenUp: 1 })
    expect(extract).toHaveBeenCalledTimes(BACKFILL.maxAttempts)

    // Saved again with more text: a new fingerprint, tried afresh — and a success clears the record.
    const resaved = record("fragile", [u(`${SECRET}. How do I chart them?`), a("Use a bar chart."), u("Thanks")], { title: "Private numbers" })
    resetBackfillForTests()
    const healed = await runBackfill({ records: [resaved], owner, settings: SETTINGS, deps: fast })
    expect(healed).toMatchObject({ processed: 1, failed: 0 })
    expect(await readFailures(owner)).toEqual([])
  })

  it("Retry failed starts the count again", async () => {
    const bad = fragile()
    for (let attempt = 1; attempt <= BACKFILL.maxAttempts; attempt++) {
      resetBackfillForTests()
      await runBackfill({ records: [bad], owner, settings: SETTINGS, deps: { ...fast, extract: failOn(bad.id) } })
    }
    await clearFailures([recordKey(owner, bad)])
    resetBackfillForTests()
    const report = await runBackfill({ records: [bad], owner, settings: SETTINGS, deps: fast })
    expect(report).toMatchObject({ needed: 1, processed: 1, givenUp: 0 })
  })

  it("retries a write the database refused, and says so when it never takes", async () => {
    let refusals = 2
    const flaky = vi.fn(async (store: string, put: readonly unknown[], remove: readonly string[]) => {
      if (store === EXTRACTIONS && refusals-- > 0) throw new DOMException("The transaction was aborted", "AbortError")
      const { commitDerived } = await import("./store")
      await commitDerived(store as typeof EXTRACTIONS, put as CachedExtraction[], remove)
    })
    const sleep = vi.fn(() => Promise.resolve())
    const retried = await runBackfill({ records: corpus(), owner, settings: SETTINGS, deps: { ...fast, sleep, commit: flaky } })
    expect(retried.unsaved).toBe(0)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect((await readDerived<CachedExtraction>(EXTRACTIONS, owner)).length).toBe(3)

    owner = `${owner}-never`
    const progress: number[] = []
    const never = await runBackfill({
      records: corpus(),
      owner,
      settings: SETTINGS,
      deps: { ...fast, commit: async () => Promise.reject(new DOMException("QuotaExceededError", "QuotaExceededError")) },
      onProgress: (update) => progress.push(update.known.size),
    })
    // Analysed and used this session; not kept, and reported as such.
    expect(never).toMatchObject({ processed: 3, unsaved: 3 })
    expect(progress.at(-1)).toBe(3)
    expect(intelligenceEvents().some((event) => event.event === "cache-write-failed" && event.level === "error")).toBe(true)
  })

  it("analyses everything when the cache can't be read, and reports why", async () => {
    const report = await runBackfill({ records: corpus(), owner, settings: SETTINGS, deps: { ...fast, readExtractions: () => Promise.reject(new Error("Internal error opening backing store")) } })
    expect(report).toMatchObject({ processed: 3, cacheError: "Internal error opening backing store" })
  })
})

describe("the device's cache", () => {
  it("upgrades a version-1 database without losing what it held", async () => {
    // A database exactly as version 1 left it.
    const name = "hubble-intelligence"
    await new Promise<void>((resolve, reject) => {
      const deleting = indexedDB.deleteDatabase(name)
      deleting.onsuccess = () => resolve()
      deleting.onerror = () => reject(deleting.error)
      deleting.onblocked = () => resolve()
    })
    resetDerivedStoreForTests()
    const legacy = syncBugChat()
    const entry: CachedExtraction = { key: recordKey(owner, legacy), owner, fingerprint: recordFingerprint(legacy), version: EXTRACTOR_VERSION, extraction: extractConversation(legacy) }
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1)
      open.onupgradeneeded = () => {
        for (const store of ["extractions", "embeddings"]) open.result.createObjectStore(store, { keyPath: "key" }).createIndex("owner", "owner", { unique: false })
      }
      open.onsuccess = () => {
        const tx = open.result.transaction("extractions", "readwrite")
        tx.objectStore("extractions").put(entry)
        tx.oncomplete = () => {
          open.result.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      open.onerror = () => reject(open.error)
    })

    const extract = vi.fn(extractConversation)
    const report = await runBackfill({ records: [legacy], owner, settings: SETTINGS, deps: { ...fast, extract }, checkpoint: true })
    expect(report).toMatchObject({ alreadyProcessed: 1, processed: 0 })
    expect(extract).not.toHaveBeenCalled()
    expect((await readRun(owner))?.state).toBe("complete")
  })

  it("deletes a conversation's failure record with its text", async () => {
    const bad = record("fragile2", [u("Something")])
    await runBackfill({ records: [bad], owner, settings: SETTINGS, deps: { ...fast, extract: () => { throw new Error("boom") } } })
    expect((await readDerived<FailureEntry>(FAILURES, owner)).length).toBe(1)
    await forgetDerived([recordKey(owner, bad)])
    expect(await readDerived<FailureEntry>(FAILURES, owner)).toEqual([])
  })
})

describe("embedding coverage", () => {
  it("counts current, missing and stale vectors from what is stored", () => {
    const [sync, storage, photo] = corpus() as [ConversationRecord, ConversationRecord, ConversationRecord]
    const vector = { vectors: new Int8Array(0), conversation: new Float32Array(0), chunks: [] }
    const coverage = embeddingCoverage(owner, [sync, storage, photo], new Set([sync.id, storage.id, photo.id]), [
      { key: recordKey(owner, sync), owner, fingerprint: recordFingerprint(sync), model: "m", ...vector },
      { key: recordKey(owner, storage), owner, fingerprint: "older", model: "m", ...vector },
    ], "m")
    expect(coverage).toEqual({ current: 1, stale: 1, missing: 1 })
  })
})

describe("scale", () => {
  it("backfills 1,500 conversations in slices, resumably, and reports throughput", async () => {
    const { records } = syntheticCorpus(1_500, 11)
    let slices = 0
    const started = performance.now()
    const report = await runBackfill({ records, owner, settings: DEFAULT_INTELLIGENCE_SETTINGS, deps: { ...fast, pause: async () => void (slices += 1) }, checkpoint: true })
    const ms = performance.now() - started
    expect(report).toMatchObject({ discovered: 1_500, processed: 1_500, failed: 0, unsaved: 0, backlog: 0 })
    expect(slices).toBeGreaterThan(1)
    expect(report.throughput).toBeGreaterThan(0)
    console.info(`[backfill scale] 1,500 conversations: ${Math.round(ms)} ms, ${report.throughput}/s, ${slices + 1} slices`)

    // Two runs at once over the same data (a view and the background): same result, nothing duplicated.
    resetBackfillForTests()
    const [x, y] = await Promise.all([runBackfill({ records, owner, settings: SETTINGS, deps: fast }), runBackfill({ records, owner, settings: SETTINGS, deps: fast })])
    expect(x.alreadyProcessed + y.alreadyProcessed).toBe(3_000)
    expect((await readDerived<CachedExtraction>(EXTRACTIONS, owner)).length).toBe(1_500)
  }, 120_000)
})
