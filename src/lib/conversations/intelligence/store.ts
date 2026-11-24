import { getStorageNamespace } from "@/lib/storage/namespace";
import { logIntelligence } from "./diagnostics";
import type { ConversationExtraction } from "./types";

/**
 * What Hubble worked out from saved conversations, kept on this device so an
 * unchanged conversation is never analysed — or embedded — twice.
 *
 * ## Same keys, same lifetime as the text it came from
 *
 * Every entry is keyed exactly like the conversation's text in the content
 * store (lib/resources/content-store.ts):
 *
 *     <account>|<project>|<item>
 *
 * and the content store's own deletion paths — removing a conversation,
 * pruning a project, moving a source — call `forgetDerived` /
 * `pruneDerivedExcept` with the same keys. So nothing derived outlives the
 * conversation it came from, whichever screen deleted it, and one account's
 * analysis is never read by another.
 *
 * A cached entry is used only when its fingerprint (recordFingerprint) and
 * its processing version both match; anything else is a miss, and the entry
 * is overwritten. Without IndexedDB this is a memory cache for the page.
 *
 * Kept in its own database so its schema can change without touching the
 * content store's.
 */

const DB_NAME = "hubble-intelligence";
/**
 * 1: extractions, embeddings.
 * 2: + failures (why a conversation couldn't be processed, per stage, keyed
 *    like the text so it is deleted with it) and runs (the last processing
 *    run's checkpoint and report, per account). The upgrade only adds
 *    stores — nothing in version 1 is touched.
 */
const DB_VERSION = 2;
export const EXTRACTIONS = "extractions";
export const EMBEDDINGS = "embeddings";
export const FAILURES = "failures";
export const RUNS = "runs";
type RecordStore = typeof EXTRACTIONS | typeof EMBEDDINGS | typeof FAILURES;
type StoreName = RecordStore | typeof RUNS;
/** Stores whose entries belong to one conversation (and go with it). */
const RECORD_STORES: readonly RecordStore[] = [EXTRACTIONS, EMBEDDINGS, FAILURES];
const ALL_STORES: readonly StoreName[] = [EXTRACTIONS, EMBEDDINGS, FAILURES, RUNS];
const OWNER_INDEX = "owner";

export type FailureStage = "extraction" | "embedding";

/** One stage's failure for one conversation. Never holds conversation text: `message` is the error Hubble's own code raised. */
export type RecordedFailure = {
  stage: FailureStage;
  /** Short and stable: "extract-threw", "cache-write", "embed-threw"… */
  code: string;
  message: string;
  /** What was being processed: a later save (new fingerprint) or extractor makes it worth trying again. */
  fingerprint: string;
  version: number | string;
  attempts: number;
  firstAt: number;
  lastAt: number;
};

export type FailureEntry = {
  key: string;
  owner: string;
  recordId: string;
  stages: Partial<Record<FailureStage, RecordedFailure>>;
};

/** The last processing run for one account: its checkpoint while it runs, its report once it ends. */
export type RunCheckpoint<Report = unknown> = {
  key: string;
  owner: string;
  runId: string;
  state: "running" | "complete" | "cancelled" | "failed";
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** A run found still "running" when the next began: it was interrupted (closed, crashed) and this one picked up after it. */
  resumedFrom?: string;
  report: Report;
};

export function runKey(owner: string): string {
  // Not `<owner>|…`: that prefix is per-conversation, and pruning would treat this as a deleted conversation's.
  return `run:${owner}`;
}

export type CachedExtraction = {
  key: string;
  owner: string;
  fingerprint: string;
  version: number;
  extraction: ConversationExtraction;
};

export type CachedEmbedding = {
  key: string;
  owner: string;
  fingerprint: string;
  /** Model id + chunker version: a different one is a miss. */
  model: string;
  /** One per chunk, in vector order: which message, and the chunk text's hash (so an unchanged chunk is never embedded again). */
  chunks: { hash: string; messageIndex: number }[];
  /** chunks × dims, int8 (a unit vector × 127). */
  vectors: Int8Array;
  /** The conversation's own unit vector, float. */
  conversation: Float32Array;
};

type Entry = CachedExtraction | CachedEmbedding | FailureEntry | RunCheckpoint;
const memory: Record<StoreName, Map<string, Entry>> = { [EXTRACTIONS]: new Map(), [EMBEDDINGS]: new Map(), [FAILURES]: new Map(), [RUNS]: new Map() };

const forgottenListeners = new Set<(keys: readonly string[] | "all") => void>();

/** Told when derived entries are deleted, so a copy kept in memory (backfill.ts) goes too. */
export function onDerivedForgotten(listener: (keys: readonly string[] | "all") => void): () => void {
  forgottenListeners.add(listener);
  return () => forgottenListeners.delete(listener);
}

function forgotten(keys: readonly string[] | "all") {
  for (const listener of forgottenListeners) listener(keys);
}

export function derivedOwner(): string {
  return getStorageNamespace() ?? "_";
}

export function derivedKey(owner: string, workspaceId: string, itemId: string): string {
  return `${owner}|${workspaceId}|${itemId}`;
}

function persistent(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Additive only: a store that exists keeps every entry it has.
      for (const name of ALL_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "key" }).createIndex(OWNER_INDEX, "owner", { unique: false });
      }
    };
    request.onblocked = () => {
      // Another connection (an older page) still holds version 1; the upgrade waits for it to close.
      logIntelligence({ level: "warn", kind: "store", event: "upgrade-blocked", message: "The analysis cache is waiting for another Hubble window to close before it can upgrade." });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

function run<T>(name: StoreName, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(name, mode);
        let result: T | undefined;
        const request = work(tx.objectStore(name));
        if (request) request.onsuccess = () => (result = request.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

/** Every entry of one store for one account. */
export async function readDerived<T extends Entry>(name: StoreName, owner: string): Promise<T[]> {
  if (!persistent()) return [...memory[name].values()].filter((entry) => entry.owner === owner) as T[];
  return ((await run<T[]>(name, "readonly", (store) => store.index(OWNER_INDEX).getAll(IDBKeyRange.only(owner)) as IDBRequest<T[]>)) ?? []) as T[];
}

/** Whether this device keeps the cache across restarts (IndexedDB), or only for this page. */
export function derivedStorePersistent(): boolean {
  return persistent();
}

/** The last run's checkpoint for this account, if any. */
export async function readRun<Report>(owner: string): Promise<RunCheckpoint<Report> | undefined> {
  const key = runKey(owner);
  if (!persistent()) return memory[RUNS].get(key) as RunCheckpoint<Report> | undefined;
  return (await run<RunCheckpoint<Report> | undefined>(RUNS, "readonly", (store) => store.get(key) as IDBRequest<RunCheckpoint<Report> | undefined>)) ?? undefined;
}

export async function writeRun<Report>(checkpoint: RunCheckpoint<Report>): Promise<void> {
  if (!persistent()) {
    memory[RUNS].set(checkpoint.key, checkpoint);
    return;
  }
  await run(RUNS, "readwrite", (store) => {
    store.put(checkpoint);
  });
}

/**
 * Writes some entries and deletes others in one transaction: a batch's
 * analysis and the failures it cleared land together, or not at all.
 */
export async function commitDerived(name: RecordStore, put: readonly Entry[], remove: readonly string[] = []): Promise<void> {
  if (put.length === 0 && remove.length === 0) return;
  if (!persistent()) {
    for (const key of remove) memory[name].delete(key);
    for (const entry of put) memory[name].set(entry.key, entry);
    return;
  }
  await run(name, "readwrite", (store) => {
    for (const key of remove) store.delete(key);
    for (const entry of put) store.put(entry);
  });
}

export async function writeDerived(name: StoreName, entries: readonly Entry[]): Promise<void> {
  if (entries.length === 0) return;
  if (!persistent()) {
    for (const entry of entries) memory[name].set(entry.key, entry);
    return;
  }
  await run(name, "readwrite", (store) => {
    for (const entry of entries) store.put(entry);
  });
}

/** Forgets everything derived for these keys, in every store. */
export async function forgetDerived(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  forgotten(keys);
  for (const name of RECORD_STORES) {
    if (!persistent()) {
      for (const key of keys) memory[name].delete(key);
      continue;
    }
    await run(name, "readwrite", (store) => {
      for (const key of keys) store.delete(key);
    });
  }
}

/** Forgets one account's entries whose key is not in `keep`. Reads keys only. Returns how many went. */
export async function pruneDerivedExcept(owner: string, keep: ReadonlySet<string>): Promise<number> {
  const prefix = `${owner}|`;
  let removed = 0;
  for (const name of RECORD_STORES) {
    if (!persistent()) {
      const gone = [...memory[name].keys()].filter((key) => key.startsWith(prefix) && !keep.has(key));
      for (const key of gone) memory[name].delete(key);
      if (name === EXTRACTIONS && gone.length > 0) forgotten(gone);
      removed += gone.length;
      continue;
    }
    const keys = ((await run<IDBValidKey[]>(name, "readonly", (store) => store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))) ?? []).filter(
      (key): key is string => typeof key === "string" && !keep.has(key)
    );
    if (keys.length > 0) {
      await run(name, "readwrite", (store) => {
        for (const key of keys) store.delete(key);
      });
      if (name === EXTRACTIONS) forgotten(keys);
    }
    removed += keys.length;
  }
  return removed;
}

/** Forgets one store's entries for an account — turning semantic matching off removes its vectors. */
export async function clearDerived(name: StoreName, owner: string): Promise<number> {
  const prefix = `${owner}|`;
  if (name === EXTRACTIONS) forgotten("all");
  if (!persistent()) {
    let removed = 0;
    for (const key of [...memory[name].keys()])
      if (key.startsWith(prefix)) {
        memory[name].delete(key);
        removed += 1;
      }
    return removed;
  }
  const keys = ((await run<IDBValidKey[]>(name, "readonly", (store) => store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))) ?? []) as string[];
  if (keys.length > 0)
    await run(name, "readwrite", (store) => {
      for (const key of keys) store.delete(key);
    });
  return keys.length;
}

/** Bytes this account's cache holds, roughly — for the settings page. */
export async function derivedSize(owner: string): Promise<{ extractions: number; embeddings: number; bytes: number }> {
  const extractions = await readDerived<CachedExtraction>(EXTRACTIONS, owner);
  const embeddings = await readDerived<CachedEmbedding>(EMBEDDINGS, owner);
  let bytes = 0;
  for (const entry of extractions) bytes += JSON.stringify(entry.extraction).length;
  for (const entry of embeddings) bytes += entry.vectors.byteLength + entry.conversation.byteLength + entry.chunks.length * 24;
  return { extractions: extractions.length, embeddings: embeddings.length, bytes };
}

/** For tests. */
export function resetDerivedStoreForTests(): void {
  for (const name of ALL_STORES) memory[name].clear();
  opening = null;
  forgotten("all");
}

/** Entries of one store by key — for explaining one pair, without reading the account's whole cache. */
export async function readDerivedKeys<T extends Entry>(name: StoreName, keys: readonly string[]): Promise<(T | undefined)[]> {
  if (!persistent()) return keys.map((key) => memory[name].get(key) as T | undefined);
  const out: (T | undefined)[] = [];
  await run(name, "readonly", (store) => {
    keys.forEach((key, index) => {
      const request = store.get(key);
      request.onsuccess = () => (out[index] = request.result as T | undefined);
    });
  });
  return keys.map((_, index) => out[index]);
}
