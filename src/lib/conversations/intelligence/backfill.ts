import { recordFingerprint as fingerprintOf, storageItemId } from "./canonical";
import { isCurrent } from "./corpus";
import { errorMessage, logIntelligence, updateIntelligenceStatus } from "./diagnostics";
import { extractConversation } from "./extract";
import { isProviderAnalyzed } from "./settings";
import { EXTRACTIONS, FAILURES, commitDerived, derivedKey, onDerivedForgotten, readDerived, readRun, runKey, writeRun } from "./store";
import { EXTRACTOR_VERSION } from "./types";
import type { IntelligenceSettings } from "./settings";
import type { CachedEmbedding, CachedExtraction, FailureEntry, RecordedFailure, RunCheckpoint } from "./store";
import type { ConversationExtraction, ConversationRecord } from "./types";

/**
 * Processing every saved conversation — the ones saved today and the ones
 * saved before Hubble could read them — through extraction, once, and
 * keeping a record of what happened.
 *
 * ## What a run does
 *
 *     plan       every conversation in every project, classified: already
 *                current, missing, changed since it was read, read by an
 *                older extractor, failed before, or skipped (and why)
 *     process    what needs it, a slice at a time (`BACKFILL.batchChars`),
 *                yielding between slices so the app stays responsive
 *     commit     each slice's analysis, and the failures it cleared, in one
 *                IndexedDB transaction (retried on a transient error)
 *     checkpoint the run's counts after every slice (store `runs`)
 *     report     what was found, done, failed, skipped, duplicated, left
 *
 * ## Idempotent and resumable
 *
 * A conversation's analysis is keyed like its text (`<account>|<project>|
 * <item>`) and stamped with its fingerprint and the extractor version, so a
 * second run over the same data does nothing, and a run that stops halfway
 * (the app closed, the machine slept) loses at most one slice: the next run
 * finds everything committed before it current, and carries on from there.
 * A run that finds the last one still marked "running" says it resumed it.
 *
 * Existing analysis is never overwritten unless its conversation changed or
 * the extractor did; nothing here deletes a conversation or its text.
 *
 * ## Failures are kept, with why
 *
 * An extraction that throws is recorded per conversation (store `failures`:
 * stage, code, the error's message, attempts, first/last time) — never its
 * text — and the conversation stays saved and searchable. It is tried again
 * on the next run up to `maxAttempts` times for the same save; a new save or
 * a new extractor resets the count. A later success clears the record.
 */

export const BACKFILL = {
  /** Characters analysed per slice before yielding — ~0.1-0.4 s of work. */
  batchChars: 400_000,
  /** Tries per conversation per save, across runs. */
  maxAttempts: 3,
  /** Backoff for a cache write the database refused (ms). */
  writeRetries: [50, 250, 1_000] as readonly number[],
  /** Extractions kept in memory for this page (the device's cache holds the rest). */
  sessionCacheMax: 10_000,
} as const;

export type PlanState =
  | "current"
  | "missing"
  | "changed"
  | "outdated"
  | "retry"
  | "forced"
  | "failed"
  | "analysis-off"
  | "provider-off"
  | "excluded"
  | "needs-text"
  | "unreadable"
  | "text-missing"
  | "waiting";

const TODO_STATES: ReadonlySet<PlanState> = new Set(["missing", "changed", "outdated", "retry", "forced"]);

export type PlanEntry = { recordId: string; key: string; state: PlanState; failure?: RecordedFailure };

export type BackfillPlan = {
  entries: PlanEntry[];
  todo: ConversationRecord[];
  /** Records whose analysis is current, by record id. */
  known: Map<string, ConversationExtraction>;
  counts: Record<PlanState, number>;
  duplicates: { identities: number; extraCopies: number };
};

export type BackfillReport = {
  runId: string;
  state: RunCheckpoint["state"];
  startedAt: number;
  finishedAt?: number;
  durationMs: number;
  /** The run this one picked up after, when that one was interrupted. */
  resumedFrom?: string;
  projects: number;
  /** Saved conversations found, in every project. */
  discovered: number;
  /** Ones analysis covers (on, app on, not left out, text saved). */
  eligible: number;
  /** Current when the run began. */
  alreadyProcessed: number;
  /** Needing analysis when the run began, and why. */
  needed: number;
  reasons: { missing: number; changed: number; outdated: number; retry: number; forced: number };
  processed: number;
  /** Failed in this run. */
  failed: number;
  /** Failed and given up on for this save (`maxAttempts` reached). */
  givenUp: number;
  skipped: { analysisOff: number; providerOff: number; excluded: number; needsText: number; unreadable: number; textMissing: number; waiting: number };
  duplicates: { identities: number; extraCopies: number };
  /** Analysed, but the device's cache wouldn't keep it (it is used for this session). */
  unsaved: number;
  /** Still to do when the run ended (cancelled, or the cache was unreadable). */
  backlog: number;
  /** Conversations analysed per second of run time, when any were. */
  throughput: number;
  /** The cache couldn't be read: everything was treated as new. */
  cacheError?: string;
  embeddings?: EmbeddingCoverage;
};

export type EmbeddingCoverage = { current: number; missing: number; stale: number };

export type BackfillProgress = {
  known: ReadonlyMap<string, ConversationExtraction>;
  failed: ReadonlyMap<string, RecordedFailure>;
  report: BackfillReport;
  done: boolean;
};

export type BackfillDeps = {
  extract: (record: ConversationRecord) => ConversationExtraction;
  readExtractions: (owner: string) => Promise<CachedExtraction[]>;
  readFailures: (owner: string) => Promise<FailureEntry[]>;
  commit: (store: typeof EXTRACTIONS | typeof FAILURES, put: readonly (CachedExtraction | FailureEntry)[], remove: readonly string[]) => Promise<void>;
  readRun: (owner: string) => Promise<RunCheckpoint<BackfillReport> | undefined>;
  writeRun: (checkpoint: RunCheckpoint<BackfillReport>) => Promise<void>;
  now: () => number;
  /** Yields between slices; resolves when the app may take the next one. */
  pause: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

const defaultDeps: BackfillDeps = {
  extract: extractConversation,
  readExtractions: (owner) => readDerived<CachedExtraction>(EXTRACTIONS, owner),
  readFailures: (owner) => readDerived<FailureEntry>(FAILURES, owner),
  commit: (store, put, remove) => commitDerived(store, put, remove),
  readRun: (owner) => readRun<BackfillReport>(owner),
  writeRun: (checkpoint) => writeRun(checkpoint),
  now: () => Date.now(),
  pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ── This page's memory of analysis (the device's cache holds the rest) ──────

const sessionCache = new Map<string, ConversationExtraction>();
/** Failures this page knows of, so a conversation given up on doesn't send every plan back to the device's cache. */
const sessionFailures = new Map<string, FailureEntry>();

// Deleted from the device (a conversation removed, a project pruned): this page's copy goes too.
onDerivedForgotten((keys) => {
  if (keys === "all") {
    sessionCache.clear();
    sessionFailures.clear();
  } else
    for (const key of keys) {
      sessionCache.delete(key);
      sessionFailures.delete(key);
    }
});

function remember(key: string, extraction: ConversationExtraction) {
  if (sessionCache.size >= BACKFILL.sessionCacheMax) sessionCache.delete(sessionCache.keys().next().value!);
  sessionCache.set(key, extraction);
}

/** Drops this page's copy of some conversations' analysis (asked to analyse again). */
export function forgetSessionAnalysis(keys: readonly string[]): void {
  for (const key of keys) sessionCache.delete(key);
}

/** For tests: a fresh page. */
export function resetBackfillForTests(): void {
  sessionCache.clear();
  sessionFailures.clear();
  liveRuns.clear();
}

export function recordKey(owner: string, record: Pick<ConversationRecord, "workspaceId" | "ref">): string {
  return derivedKey(owner, record.workspaceId, storageItemId(record));
}

function hasBody(record: ConversationRecord): boolean {
  return record.messages.length > 0 || !!record.text;
}

// ── Plan ────────────────────────────────────────────────────────────────────

export function planBackfill(input: {
  records: readonly ConversationRecord[];
  owner: string;
  settings: Pick<IntelligenceSettings, "enabled" | "providers" | "excluded">;
  cached: ReadonlyMap<string, CachedExtraction>;
  failures: ReadonlyMap<string, FailureEntry>;
  /** Whether a project's text has been read from the content store yet. */
  loaded?: (workspaceId: string) => boolean;
  forced?: ReadonlySet<string>;
  maxAttempts?: number;
}): BackfillPlan {
  const { records, owner, settings, cached, failures, forced } = input;
  const maxAttempts = input.maxAttempts ?? BACKFILL.maxAttempts;
  const counts = Object.fromEntries(
    (["current", "missing", "changed", "outdated", "retry", "forced", "failed", "analysis-off", "provider-off", "excluded", "needs-text", "unreadable", "text-missing", "waiting"] as PlanState[]).map((state) => [state, 0])
  ) as Record<PlanState, number>;
  const entries: PlanEntry[] = [];
  const todo: ConversationRecord[] = [];
  const known = new Map<string, ConversationExtraction>();
  const identities = new Map<string, number>();

  for (const record of records) {
    identities.set(record.identity, (identities.get(record.identity) ?? 0) + 1);
    const key = recordKey(owner, record);
    const entry: PlanEntry = { recordId: record.id, key, state: "missing" };
    entry.state = classify();
    counts[entry.state] += 1;
    entries.push(entry);
    if (TODO_STATES.has(entry.state)) todo.push(record);

    function classify(): PlanState {
      if (!settings.enabled) return "analysis-off";
      if (!isProviderAnalyzed(settings as IntelligenceSettings, record.provider)) return "provider-off";
      if (settings.excluded.includes(record.identity)) return "excluded";
      if (record.ingestion === "unreadable") return "unreadable";
      if (record.ingestion !== "ready") return "needs-text";
      if (input.loaded && !input.loaded(record.workspaceId)) return "waiting";
      // The project says this conversation's text was saved, but the content store has none: lost or never written here.
      if (!hasBody(record)) return "text-missing";
      if (forced?.has(record.id)) return "forced";
      const session = sessionCache.get(key);
      const stored = cached.get(key)?.extraction;
      for (const extraction of [session, stored]) {
        if (extraction && extraction.recordId === record.id && isCurrent(record, extraction)) {
          known.set(record.id, extraction);
          return "current";
        }
      }
      const failure = failures.get(key)?.stages.extraction;
      if (failure) {
        entry.failure = failure;
        const sameInput = failure.fingerprint === fingerprintOf(record) && failure.version === EXTRACTOR_VERSION;
        if (sameInput && failure.attempts >= maxAttempts) return "failed";
        return "retry";
      }
      const previous = stored ?? session;
      if (!previous || previous.recordId !== record.id) return "missing";
      return previous.version !== EXTRACTOR_VERSION ? "outdated" : "changed";
    }
  }
  let duplicateIdentities = 0;
  let extraCopies = 0;
  for (const count of identities.values()) {
    if (count > 1) {
      duplicateIdentities += 1;
      extraCopies += count - 1;
    }
  }
  return { entries, todo, known, counts, duplicates: { identities: duplicateIdentities, extraCopies } };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const liveRuns = new Set<string>();
let runCounter = 0;

function newRunId(now: number): string {
  runCounter += 1;
  return `${now.toString(36)}-${runCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyReport(runId: string, startedAt: number): BackfillReport {
  return {
    runId,
    state: "running",
    startedAt,
    durationMs: 0,
    projects: 0,
    discovered: 0,
    eligible: 0,
    alreadyProcessed: 0,
    needed: 0,
    reasons: { missing: 0, changed: 0, outdated: 0, retry: 0, forced: 0 },
    processed: 0,
    failed: 0,
    givenUp: 0,
    skipped: { analysisOff: 0, providerOff: 0, excluded: 0, needsText: 0, unreadable: 0, textMissing: 0, waiting: 0 },
    duplicates: { identities: 0, extraCopies: 0 },
    unsaved: 0,
    backlog: 0,
    throughput: 0,
  };
}

export type RunOptions = {
  records: readonly ConversationRecord[];
  owner: string;
  settings: Pick<IntelligenceSettings, "enabled" | "providers" | "excluded">;
  loaded?: (workspaceId: string) => boolean;
  forced?: ReadonlySet<string>;
  /** Checked between slices: true stops the run (state "cancelled"); what was committed stays. */
  cancelled?: () => boolean;
  onProgress?: (progress: BackfillProgress) => void;
  /** Called for each record analysed here, so the caller can stop forcing it. */
  onAnalyzed?: (record: ConversationRecord) => void;
  /** Whether to write the run's checkpoint (the background processor does; a view's own run doesn't need to). */
  checkpoint?: boolean;
  deps?: Partial<BackfillDeps>;
  batchChars?: number;
  maxAttempts?: number;
};

async function withRetries<T>(deps: BackfillDeps, work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKFILL.writeRetries.length; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const wait = BACKFILL.writeRetries[attempt];
      if (wait === undefined) break;
      await deps.sleep(wait);
    }
  }
  throw lastError;
}

export async function runBackfill(options: RunOptions): Promise<BackfillReport> {
  const deps: BackfillDeps = { ...defaultDeps, ...options.deps };
  const { records, owner, settings } = options;
  const batchChars = options.batchChars ?? BACKFILL.batchChars;
  const maxAttempts = options.maxAttempts ?? BACKFILL.maxAttempts;
  const checkpointing = options.checkpoint ?? false;
  const startedAt = deps.now();
  const runId = newRunId(startedAt);
  liveRuns.add(runId);
  const report = emptyReport(runId, startedAt);
  const failedNow = new Map<string, RecordedFailure>();

  try {
    // An earlier run still marked running, and not running in this page: it was interrupted.
    if (checkpointing) {
      try {
        const previous = await deps.readRun(owner);
        if (previous?.state === "running" && !liveRuns.has(previous.runId)) {
          report.resumedFrom = previous.runId;
          logIntelligence({ level: "warn", kind: "backfill", event: "resumed-interrupted-run", message: "The last processing run stopped before it finished; this one carries on from what it committed.", data: { previousProcessed: previous.report?.processed ?? 0, previousNeeded: previous.report?.needed ?? 0 } });
        }
      } catch (error) {
        logIntelligence({ level: "warn", kind: "store", event: "run-read-failed", message: errorMessage(error) });
      }
    }

    const planWith = (cached: ReadonlyMap<string, CachedExtraction>, failures: ReadonlyMap<string, FailureEntry>) =>
      planBackfill({ records, owner, settings, cached, failures, ...(options.loaded ? { loaded: options.loaded } : {}), ...(options.forced ? { forced: options.forced } : {}), maxAttempts });

    // This page's memory first: when it already covers everything, the device's cache isn't read again
    // (the background processor plans on every edit to a project; reading every stored analysis each time would be the cost).
    let failures = new Map(sessionFailures);
    let plan = planWith(new Map(), failures);
    if (plan.todo.length > 0) {
      let cached = new Map<string, CachedExtraction>();
      try {
        cached = new Map((await deps.readExtractions(owner)).map((entry) => [entry.key, entry]));
        failures = new Map((await deps.readFailures(owner)).map((entry) => [entry.key, entry]));
        for (const [key, entry] of failures) sessionFailures.set(key, entry);
      } catch (error) {
        // Without the cache everything is analysed again here — slower, never wrong. Said, not hidden.
        report.cacheError = errorMessage(error);
        updateIntelligenceStatus({ storage: { persistent: true, lastError: report.cacheError } });
        logIntelligence({ level: "error", kind: "store", event: "cache-read-failed", message: report.cacheError });
      }
      plan = planWith(cached, failures);
      for (const entry of plan.entries) if (entry.state === "current") remember(entry.key, plan.known.get(entry.recordId)!);
    }
    const { counts } = plan;
    report.projects = new Set(records.map((record) => record.workspaceId)).size;
    report.discovered = records.length;
    report.alreadyProcessed = counts.current;
    report.reasons = { missing: counts.missing, changed: counts.changed, outdated: counts.outdated, retry: counts.retry, forced: counts.forced };
    report.needed = plan.todo.length;
    report.givenUp = counts.failed;
    report.eligible = counts.current + plan.todo.length + counts.failed;
    report.skipped = {
      analysisOff: counts["analysis-off"],
      providerOff: counts["provider-off"],
      excluded: counts.excluded,
      needsText: counts["needs-text"],
      unreadable: counts.unreadable,
      textMissing: counts["text-missing"],
      waiting: counts.waiting,
    };
    report.duplicates = plan.duplicates;
    report.backlog = plan.todo.length;
    for (const entry of plan.entries) if (entry.state === "failed" && entry.failure) failedNow.set(entry.recordId, entry.failure);

    if (plan.todo.length > 0 || counts["text-missing"] > 0) {
      logIntelligence({
        level: "info",
        kind: "backfill",
        event: "planned",
        data: { discovered: report.discovered, current: counts.current, todo: plan.todo.length, missing: counts.missing, changed: counts.changed, outdated: counts.outdated, retry: counts.retry, textMissing: counts["text-missing"], givenUp: counts.failed },
      });
    }
    if (counts["text-missing"] > 0) {
      logIntelligence({ level: "warn", kind: "content", event: "text-missing", message: `${counts["text-missing"]} saved conversation${counts["text-missing"] === 1 ? " has" : "s have"} no text on this device; saving again from the AI app restores it.`, data: { count: counts["text-missing"] } });
    }

    const checkpoint = async (state: RunCheckpoint["state"]) => {
      report.state = state;
      report.durationMs = deps.now() - startedAt;
      report.throughput = report.durationMs > 0 && report.processed > 0 ? Math.round((report.processed / report.durationMs) * 1000 * 10) / 10 : 0;
      if (state !== "running") report.finishedAt = deps.now();
      if (!checkpointing) return;
      try {
        await deps.writeRun({ key: runKey(owner), owner, runId, state, startedAt, updatedAt: deps.now(), ...(report.finishedAt ? { finishedAt: report.finishedAt } : {}), ...(report.resumedFrom ? { resumedFrom: report.resumedFrom } : {}), report: { ...report } });
      } catch (error) {
        logIntelligence({ level: "warn", kind: "store", event: "checkpoint-failed", message: errorMessage(error) });
      }
    };

    const known = plan.known;
    const progress = (done: boolean) => options.onProgress?.({ known: new Map(known), failed: new Map(failedNow), report: { ...report }, done });
    await checkpoint("running");
    progress(plan.todo.length === 0);

    let position = 0;
    while (position < plan.todo.length) {
      if (options.cancelled?.()) {
        report.backlog = plan.todo.length - position;
        await checkpoint("cancelled");
        logIntelligence({ level: "info", kind: "backfill", event: "cancelled", data: { processed: report.processed, backlog: report.backlog } });
        progress(true);
        return report;
      }
      const written: CachedExtraction[] = [];
      const failedPut: FailureEntry[] = [];
      const cleared: string[] = [];
      let spent = 0;
      while (position < plan.todo.length && spent < batchChars) {
        const record = plan.todo[position++]!;
        const key = recordKey(owner, record);
        const previousFailure = failures.get(key);
        try {
          const extraction = deps.extract(record);
          remember(key, extraction);
          written.push({ key, owner, fingerprint: extraction.fingerprint, version: extraction.version, extraction });
          known.set(record.id, extraction);
          failedNow.delete(record.id);
          options.onAnalyzed?.(record);
          if (previousFailure?.stages.extraction) {
            const rest = { ...previousFailure.stages };
            delete rest.extraction;
            if (Object.keys(rest).length === 0) {
              cleared.push(key);
              sessionFailures.delete(key);
            } else {
              const entry = { ...previousFailure, stages: rest };
              sessionFailures.set(key, entry);
              failedPut.push(entry);
            }
          }
          report.processed += 1;
          spent += extraction.analyzedChars + 1;
        } catch (error) {
          const at = deps.now();
          const fingerprint = fingerprintOf(record);
          const before = previousFailure?.stages.extraction;
          const sameInput = before && before.fingerprint === fingerprint && before.version === EXTRACTOR_VERSION;
          const failure: RecordedFailure = {
            stage: "extraction",
            code: "extract-threw",
            message: errorMessage(error),
            fingerprint,
            version: EXTRACTOR_VERSION,
            attempts: sameInput ? before.attempts + 1 : 1,
            firstAt: sameInput ? before.firstAt : at,
            lastAt: at,
          };
          const entry: FailureEntry = { key, owner, recordId: record.id, stages: { ...(previousFailure?.stages ?? {}), extraction: failure } };
          failures.set(key, entry);
          sessionFailures.set(key, entry);
          failedPut.push(entry);
          failedNow.set(record.id, failure);
          report.failed += 1;
          if (failure.attempts >= maxAttempts) report.givenUp += 1;
          // The id and the error only — never the conversation's words.
          logIntelligence({ level: "error", kind: "extraction", event: "failed", message: failure.message, data: { recordId: record.id, attempts: failure.attempts } });
          spent += 1_000;
        }
      }
      report.backlog = plan.todo.length - position;
      try {
        await withRetries(deps, () => deps.commit(EXTRACTIONS, written, []));
      } catch (error) {
        // Analysed, used for this session, but not kept: the next start analyses these again.
        report.unsaved += written.length;
        const message = errorMessage(error);
        updateIntelligenceStatus({ storage: { persistent: true, lastError: message } });
        logIntelligence({ level: "error", kind: "store", event: "cache-write-failed", message, data: { conversations: written.length } });
      }
      if (failedPut.length > 0 || cleared.length > 0) {
        try {
          await withRetries(deps, () => deps.commit(FAILURES, failedPut, cleared));
        } catch (error) {
          logIntelligence({ level: "error", kind: "store", event: "failure-write-failed", message: errorMessage(error), data: { records: failedPut.length } });
        }
      }
      await checkpoint("running");
      progress(position >= plan.todo.length);
      if (position < plan.todo.length) await deps.pause();
    }
    await checkpoint("complete");
    if (plan.todo.length > 0) {
      logIntelligence({
        level: report.failed > 0 || report.unsaved > 0 ? "warn" : "info",
        kind: "backfill",
        event: "complete",
        data: { processed: report.processed, failed: report.failed, unsaved: report.unsaved, durationMs: report.durationMs, perSecond: report.throughput },
      });
    }
    progress(true);
    return report;
  } catch (error) {
    report.state = "failed";
    report.durationMs = deps.now() - startedAt;
    logIntelligence({ level: "error", kind: "backfill", event: "run-failed", message: errorMessage(error) });
    throw error;
  } finally {
    liveRuns.delete(runId);
  }
}

// ── Embeddings: what's missing ───────────────────────────────────────────────

/** How many analysed conversations have current meaning vectors, from the stored cache. */
export function embeddingCoverage(owner: string, records: readonly ConversationRecord[], analyzed: ReadonlySet<string>, embeddings: readonly CachedEmbedding[], model: string): EmbeddingCoverage {
  const byKey = new Map(embeddings.map((entry) => [entry.key, entry]));
  let current = 0;
  let missing = 0;
  let stale = 0;
  for (const record of records) {
    if (!analyzed.has(record.id)) continue;
    const entry = byKey.get(recordKey(owner, record));
    if (!entry) missing += 1;
    else if (entry.model !== model || entry.fingerprint !== fingerprintOf(record)) stale += 1;
    else current += 1;
  }
  return { current, missing, stale };
}

/** One account's recorded failures, newest first — for inspecting them one by one. */
export async function readFailures(owner: string): Promise<FailureEntry[]> {
  const entries = await readDerived<FailureEntry>(FAILURES, owner);
  const latest = (entry: FailureEntry) => Math.max(...Object.values(entry.stages).map((stage) => stage?.lastAt ?? 0));
  return entries.sort((a, b) => latest(b) - latest(a));
}

/** Forgets the recorded failures of these records, so the next run tries them afresh. */
export async function clearFailures(keys: readonly string[]): Promise<void> {
  for (const key of keys) sessionFailures.delete(key);
  await commitDerived(FAILURES, [], keys);
}
