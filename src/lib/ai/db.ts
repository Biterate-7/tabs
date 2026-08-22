import type { IndexedChunkRecord } from "./types";

const DB_NAME = "tabdump-ai";
const DB_VERSION = 1;
const STORE = "chunks";
const WORKSPACE_INDEX = "workspaceId";

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex(WORKSPACE_INDEX, "workspaceId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function chunkKey(workspaceId: string, tabId: string, kind: string): string {
  return `${workspaceId}:${tabId}:${kind}`;
}

export async function putChunks(records: IndexedChunkRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(STORE);
      for (const record of records) store.put(record);
    });
  } finally {
    db.close();
  }
}

export async function getChunksForWorkspace(workspaceId: string): Promise<IndexedChunkRecord[]> {
  const db = await openDb();
  try {
    return await new Promise<IndexedChunkRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index(WORKSPACE_INDEX);
      const request = index.getAll(IDBKeyRange.only(workspaceId));
      request.onsuccess = () => resolve(request.result as IndexedChunkRecord[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Removes every stored chunk for tabs no longer present (e.g. deleted/cleared). */
export async function deleteChunksForTabs(workspaceId: string, tabIds: string[]): Promise<void> {
  if (tabIds.length === 0) return;
  const idSet = new Set(tabIds);
  const existing = await getChunksForWorkspace(workspaceId);
  const toDelete = existing.filter((r) => idSet.has(r.tabId));
  if (toDelete.length === 0) return;

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(STORE);
      for (const record of toDelete) store.delete(record.key);
    });
  } finally {
    db.close();
  }
}
