import { getStorageNamespace } from "@/lib/storage/namespace";
import { cleanLanguageTag } from "./transcript";
import { CONTENT_LIMITS } from "./types";
import type { ResourceContent, ResourceContentSummary } from "./types";

/**
 * Where extracted source content lives: IndexedDB, on this device only.
 *
 * Page text, PDF pages, transcripts, saved AI conversations and notes are far
 * too large for the workspace store (localStorage, synchronous, a few
 * megabytes for everything), and most screens never need them. So the item
 * carries a summary of what is stored, and the content itself is written
 * here and read lazily — by the reader, search, and the context a person
 * chooses to reuse.
 *
 * ## Partitioned like everything else that is personal
 *
 * Every key starts with the storage namespace (the signed-in account, or the
 * signed-out partition), then the project, then the tab:
 *
 *     <account>|<project>|<tab>
 *
 * Reads always filter by the active account and one named project. There is
 * no read that spans projects, so a project's content can never surface in
 * another — the isolation the context layer depends on.
 *
 * Without IndexedDB (a private window in some browsers, a test without the
 * polyfill) this falls back to memory for the life of the page, and says so
 * through `contentStorePersistent()` rather than pretending to persist.
 *
 * Keys are item ids: a source's tab id, or a project note's id (both minted
 * by lib/id.ts, so they never collide).
 *
 * ## Originals
 *
 * An uploaded file (lib/files) keeps its original bytes in a second object
 * store, `files`, under the same key as its text. Every lifecycle path here
 * — delete, prune, move — covers both stores, so a file's original follows
 * its item exactly as its text does, and a removed item never leaves bytes
 * behind. Bytes are stored as an ArrayBuffer (structured-cloneable in every
 * browser and the desktop webview), never in localStorage.
 */

const DB_NAME = "hubble-resources";
const DB_VERSION = 2;
const STORE = "content";
const FILES = "files";
const PROJECT_INDEX = "project";

export type StoredContent = ResourceContent & {
  key: string;
  /** `<account>|<project>` — what the index is on. */
  project: string;
  workspaceId: string;
  tabId: string;
};

/** An uploaded file's original. */
export type StoredFile = {
  key: string;
  project: string;
  workspaceId: string;
  itemId: string;
  bytes: ArrayBuffer;
  name: string;
  type: string;
  storedAt: number;
};

const memory = new Map<string, StoredContent>();
const memoryFiles = new Map<string, StoredFile>();

function owner(): string {
  return getStorageNamespace() ?? "_";
}

function projectKey(workspaceId: string): string {
  return `${owner()}|${workspaceId}`;
}

function contentKey(workspaceId: string, tabId: string): string {
  return `${projectKey(workspaceId)}|${tabId}`;
}

export function contentStorePersistent(): boolean {
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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" }).createIndex(PROJECT_INDEX, "project", { unique: false });
      }
      if (!db.objectStoreNames.contains(FILES)) {
        db.createObjectStore(FILES, { keyPath: "key" }).createIndex(PROJECT_INDEX, "project", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema closes this connection; the next call reopens.
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

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void, storeName: typeof STORE | typeof FILES = STORE): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let result: T | undefined;
        const request = work(tx.objectStore(storeName));
        if (request) request.onsuccess = () => (result = request.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

/** Content bounded to the storage limits, with `truncated` set when anything was cut. */
export function boundContent(content: ResourceContent): ResourceContent {
  let truncated = content.truncated === true;
  const out: ResourceContent = { kind: content.kind, extractedAt: content.extractedAt };
  if (content.text !== undefined) {
    if (content.text.length > CONTENT_LIMITS.text) truncated = true;
    out.text = content.text.slice(0, CONTENT_LIMITS.text);
  }
  if (content.pages) {
    if (content.pages.length > CONTENT_LIMITS.pages) truncated = true;
    out.pages = content.pages.slice(0, CONTENT_LIMITS.pages).map((page) => {
      if (page.length > CONTENT_LIMITS.pageText) truncated = true;
      return page.slice(0, CONTENT_LIMITS.pageText);
    });
  }
  if (content.transcript) {
    if (content.transcript.length > CONTENT_LIMITS.transcriptLines) truncated = true;
    out.transcript = content.transcript.slice(0, CONTENT_LIMITS.transcriptLines).map((line) => ({
      ...(line.start !== undefined ? { start: line.start } : {}),
      ...(line.end !== undefined ? { end: line.end } : {}),
      text: line.text.slice(0, CONTENT_LIMITS.transcriptLine),
    }));
    if (content.transcriptInfo) {
      const language = cleanLanguageTag(content.transcriptInfo.language);
      const provider = content.transcriptInfo.provider?.slice(0, 40);
      out.transcriptInfo = { source: content.transcriptInfo.source === "captions" ? "captions" : "supplied", ...(language ? { language } : {}), ...(provider ? { provider } : {}) };
    }
  }
  if (content.turns) {
    if (content.turns.length > CONTENT_LIMITS.turns) truncated = true;
    out.turns = content.turns.slice(0, CONTENT_LIMITS.turns).map((turn) => {
      if (turn.text.length > CONTENT_LIMITS.turnText) truncated = true;
      return { role: turn.role === "user" ? "user" : "assistant", text: turn.text.slice(0, CONTENT_LIMITS.turnText), ...(turn.at !== undefined ? { at: turn.at } : {}) };
    });
  }
  if (truncated) out.truncated = true;
  return out;
}

/** The counts the tab keeps about its content. */
export function summarizeContent(content: ResourceContent): ResourceContentSummary {
  const chars =
    (content.text?.length ?? 0) +
    (content.pages ?? []).reduce((sum, page) => sum + page.length, 0) +
    (content.transcript ?? []).reduce((sum, line) => sum + line.text.length, 0) +
    (content.turns ?? []).reduce((sum, turn) => sum + turn.text.length, 0);
  return {
    chars,
    extractedAt: content.extractedAt,
    ...(content.pages ? { pages: content.pages.length } : {}),
    ...(content.transcript ? { transcriptLines: content.transcript.length } : {}),
    ...(content.turns ? { turns: content.turns.length } : {}),
    ...(content.transcriptInfo?.language ? { language: content.transcriptInfo.language } : {}),
    ...(content.truncated ? { truncated: true } : {}),
  };
}

export async function putContent(workspaceId: string, tabId: string, content: ResourceContent): Promise<ResourceContentSummary> {
  const bounded = boundContent(content);
  const record: StoredContent = { ...bounded, key: contentKey(workspaceId, tabId), project: projectKey(workspaceId), workspaceId, tabId };
  if (!contentStorePersistent()) memory.set(record.key, record);
  else await run("readwrite", (store) => void store.put(record));
  return summarizeContent(bounded);
}

export async function getContent(workspaceId: string, tabId: string): Promise<ResourceContent | undefined> {
  const key = contentKey(workspaceId, tabId);
  const record = contentStorePersistent() ? await run<StoredContent>("readonly", (store) => store.get(key) as IDBRequest<StoredContent>) : memory.get(key);
  return record ? strip(record) : undefined;
}

function strip(record: StoredContent): ResourceContent {
  return {
    kind: record.kind,
    extractedAt: record.extractedAt,
    ...(record.text !== undefined ? { text: record.text } : {}),
    ...(record.pages ? { pages: record.pages } : {}),
    ...(record.transcript ? { transcript: record.transcript } : {}),
    ...(record.transcriptInfo ? { transcriptInfo: record.transcriptInfo } : {}),
    ...(record.turns ? { turns: record.turns } : {}),
    ...(record.truncated ? { truncated: true } : {}),
  };
}

/** Every stored source of one project, for this account — by tab id. */
export async function getProjectContents(workspaceId: string): Promise<Map<string, ResourceContent>> {
  const project = projectKey(workspaceId);
  const records = contentStorePersistent()
    ? ((await run<StoredContent[]>("readonly", (store) => store.index(PROJECT_INDEX).getAll(IDBKeyRange.only(project)) as IDBRequest<StoredContent[]>)) ?? [])
    : [...memory.values()].filter((record) => record.project === project);
  return new Map(records.map((record) => [record.tabId, strip(record)]));
}

/**
 * Some sources of one project, by tab id — one transaction, and only the
 * records asked for (search across subjects needs transcripts, not every
 * PDF's pages). Tabs with nothing stored are simply absent.
 */
export async function getContents(workspaceId: string, tabIds: readonly string[]): Promise<Map<string, ResourceContent>> {
  const out = new Map<string, ResourceContent>();
  if (tabIds.length === 0) return out;
  const keys = tabIds.map((tabId) => contentKey(workspaceId, tabId));
  if (!contentStorePersistent()) {
    for (const key of keys) {
      const record = memory.get(key);
      if (record) out.set(record.tabId, strip(record));
    }
    return out;
  }
  const found: StoredContent[] = [];
  await run("readonly", (store) => {
    for (const key of keys) {
      const request = store.get(key) as IDBRequest<StoredContent | undefined>;
      request.onsuccess = () => {
        if (request.result) found.push(request.result);
      };
    }
  });
  for (const record of found) out.set(record.tabId, strip(record));
  return out;
}

/** Forgets these items' text and, for uploaded files, their originals. */
export async function deleteContent(workspaceId: string, tabIds: readonly string[]): Promise<void> {
  if (tabIds.length === 0) return;
  const keys = tabIds.map((tabId) => contentKey(workspaceId, tabId));
  if (!contentStorePersistent()) {
    for (const key of keys) {
      memory.delete(key);
      memoryFiles.delete(key);
    }
    return;
  }
  for (const storeName of [STORE, FILES] as const) {
    await run(
      "readwrite",
      (store) => {
        for (const key of keys) store.delete(key);
      },
      storeName
    );
  }
}

/** Item ids of one project that have an original stored. Keys only — never the bytes. */
async function projectFileIds(workspaceId: string): Promise<string[]> {
  const project = projectKey(workspaceId);
  if (!contentStorePersistent()) return [...memoryFiles.values()].filter((record) => record.project === project).map((record) => record.itemId);
  const keys = (await run<IDBValidKey[]>("readonly", (store) => store.index(PROJECT_INDEX).getAllKeys(IDBKeyRange.only(project)) as IDBRequest<IDBValidKey[]>, FILES)) ?? [];
  const prefix = `${project}|`;
  return keys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

/** Removes stored content for tabs a project no longer has — after a removal, an undo window, or a deleted project. */
export async function pruneProjectContent(workspaceId: string, keepTabIds: ReadonlySet<string>): Promise<number> {
  const stored = await getProjectContents(workspaceId);
  const ids = new Set([...stored.keys(), ...(await projectFileIds(workspaceId))]);
  const stale = [...ids].filter((tabId) => !keepTabIds.has(tabId));
  await deleteContent(workspaceId, stale);
  return stale.length;
}

/**
 * Keeps an uploaded file's original bytes, under its item's key. Throws when
 * the device refuses (out of space, storage blocked) — the caller adds
 * nothing then, so no item claims a file it doesn't have.
 */
export async function putFile(workspaceId: string, itemId: string, bytes: ArrayBuffer, info: { name: string; type: string; now: number }): Promise<void> {
  const record: StoredFile = { key: contentKey(workspaceId, itemId), project: projectKey(workspaceId), workspaceId, itemId, bytes, name: info.name, type: info.type, storedAt: info.now };
  if (!contentStorePersistent()) memoryFiles.set(record.key, record);
  else await run("readwrite", (store) => void store.put(record), FILES);
}

/** An uploaded file's original, or `undefined` when this device doesn't have it. */
export async function getFile(workspaceId: string, itemId: string): Promise<{ bytes: ArrayBuffer; name: string; type: string } | undefined> {
  const key = contentKey(workspaceId, itemId);
  const record = contentStorePersistent() ? await run<StoredFile>("readonly", (store) => store.get(key) as IDBRequest<StoredFile>, FILES) : memoryFiles.get(key);
  return record ? { bytes: record.bytes, name: record.name, type: record.type } : undefined;
}

/**
 * Carries a source's content to another project, for a tab moved between
 * subjects — content is keyed by project, so without this the moved source
 * would claim content it can no longer reach. Nothing stored: nothing to do.
 */
export async function moveContent(fromWorkspaceId: string, toWorkspaceId: string, tabId: string): Promise<boolean> {
  if (fromWorkspaceId === toWorkspaceId) return false;
  const content = await getContent(fromWorkspaceId, tabId);
  const file = await getFile(fromWorkspaceId, tabId);
  if (!content && !file) return false;
  if (content) await putContent(toWorkspaceId, tabId, content);
  if (file) await putFile(toWorkspaceId, tabId, file.bytes, { name: file.name, type: file.type, now: Date.now() });
  await deleteContent(fromWorkspaceId, [tabId]);
  return true;
}

/**
 * Removes everything this account stored for tabs that no longer exist —
 * in any project, including projects that are gone. `present` is every
 * project's current tabs. Reads keys only, never content. Idempotent.
 *
 * Only the active account's records are considered: another account's
 * content on the same device is never touched.
 */
export async function pruneContentExcept(present: ReadonlyMap<string, ReadonlySet<string>>): Promise<number> {
  const prefix = `${owner()}|`;
  const keep = new Set<string>();
  for (const [workspaceId, tabIds] of present) for (const tabId of tabIds) keep.add(contentKey(workspaceId, tabId));
  if (!contentStorePersistent()) {
    let removed = 0;
    for (const records of [memory, memoryFiles] as Map<string, unknown>[]) {
      for (const key of [...records.keys()]) {
        if (key.startsWith(prefix) && !keep.has(key)) {
          records.delete(key);
          removed += 1;
        }
      }
    }
    return removed;
  }
  let removed = 0;
  for (const storeName of [STORE, FILES] as const) {
    const keys = ((await run<IDBValidKey[]>("readonly", (store) => store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)), storeName)) ?? []).filter(
      (key): key is string => typeof key === "string" && !keep.has(key)
    );
    if (keys.length > 0) {
      await run(
        "readwrite",
        (store) => {
          for (const key of keys) store.delete(key);
        },
        storeName
      );
    }
    removed += keys.length;
  }
  return removed;
}

/** For tests: forget the memory fallback and the open connection. */
export function resetContentStoreForTests(): void {
  memory.clear();
  memoryFiles.clear();
  opening = null;
}
