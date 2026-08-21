import { isStorageAvailable } from "@/lib/workspace/persistence";

const STORAGE_KEY = "tabdump:titles:v1";
const PERMANENT_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

type SuccessEntry = { status: "success"; title: string; source: string; resolvedAt: number };
type FailureEntry = { status: "failed"; failedAt: number };
type CacheEntry = SuccessEntry | FailureEntry;

let memoryCache: Map<string, CacheEntry> | null = null;

function isValidEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.status === "success") {
    return typeof entry.title === "string" && typeof entry.source === "string" && typeof entry.resolvedAt === "number";
  }
  if (entry.status === "failed") {
    return typeof entry.failedAt === "number";
  }
  return false;
}

function loadCache(): Map<string, CacheEntry> {
  if (memoryCache) return memoryCache;

  memoryCache = new Map();
  if (!isStorageAvailable()) return memoryCache;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return memoryCache;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return memoryCache;

    for (const [url, entry] of Object.entries(parsed.entries as Record<string, unknown>)) {
      if (isValidEntry(entry)) memoryCache.set(url, entry);
    }
  } catch {
    // Corrupted cache: start fresh rather than blocking title resolution.
  }

  return memoryCache;
}

function persist(): void {
  if (!isStorageAvailable()) return;
  try {
    const entries = Object.fromEntries(loadCache());
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }));
  } catch {
    // Storage full or unavailable mid-session: cache still works in memory for this tab.
  }
}

export function getCachedTitle(normalizedUrl: string): { title: string; source: string } | null {
  const entry = loadCache().get(normalizedUrl);
  return entry?.status === "success" ? { title: entry.title, source: entry.source } : null;
}

export function shouldSkipResolution(normalizedUrl: string): boolean {
  const entry = loadCache().get(normalizedUrl);
  if (entry?.status !== "failed") return false;
  return Date.now() - entry.failedAt < PERMANENT_FAILURE_COOLDOWN_MS;
}

export function recordSuccess(normalizedUrl: string, title: string, source: string): void {
  loadCache().set(normalizedUrl, { status: "success", title, source, resolvedAt: Date.now() });
  persist();
}

export function recordFailure(normalizedUrl: string, permanent: boolean): void {
  // Transient failures (timeouts, auth walls, 5xx) are deliberately not
  // cached — they're exactly the cases worth retrying on the next dump.
  if (!permanent) return;
  loadCache().set(normalizedUrl, { status: "failed", failedAt: Date.now() });
  persist();
}

export function clearTitleCache(): void {
  memoryCache = new Map();
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** Test-only: forces the next read to re-hydrate from localStorage. */
export function __resetTitleCacheForTests(): void {
  memoryCache = null;
}
