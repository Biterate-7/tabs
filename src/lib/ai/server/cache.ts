import "server-only";
import { createHash } from "node:crypto";
import type { GeminiResult } from "@/lib/ai/gemini/types";

/**
 * Process-wide in-memory cache for Gemini-derived results, keyed by an
 * arbitrary string. There's no database, KV store, or auth/session system
 * anywhere in this codebase (every server route is a stateless Next.js
 * Route Handler) — this is deliberately the smallest thing that actually
 * cuts Gemini calls without introducing new infrastructure. It survives for
 * the lifetime of one server process; it does NOT survive a restart or
 * span multiple instances. See the audit report for that tradeoff.
 */
type Entry = { value: GeminiResult<unknown>; expiresAt: number; cachedAt: number };

const store = new Map<string, Entry>();
const inFlight = new Map<string, Promise<GeminiResult<unknown>>>();

export const DEFAULT_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a URL's derived content rarely changes
export const DEFAULT_FAILURE_TTL_MS = 60 * 1000; // long enough to stop a retry storm, short enough to recover fast

/** A crude cap so a long-running process under heavy varied traffic can't grow this unboundedly — evicts the oldest quarter of entries once exceeded. */
const MAX_ENTRIES = 20000;

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const entries = Array.from(store.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  const toEvict = Math.floor(entries.length / 4);
  for (let i = 0; i < toEvict; i++) store.delete(entries[i][0]);
}

export function readCache<T>(key: string): GeminiResult<T> | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as GeminiResult<T>;
}

export function writeCache<T>(key: string, value: GeminiResult<T>, ttlMs?: number): void {
  const ttl = ttlMs ?? (value.ok ? DEFAULT_SUCCESS_TTL_MS : DEFAULT_FAILURE_TTL_MS);
  store.set(key, { value, expiresAt: Date.now() + ttl, cachedAt: Date.now() });
  evictIfNeeded();
}

/**
 * Cache-or-compute for a single logical key, with in-flight coalescing:
 * concurrent callers for the same key share one `compute()` call instead of
 * each firing their own Gemini request. Failures are cached too (briefly)
 * so a burst of requests against a down/quota-exhausted Gemini doesn't
 * retry it on every single call — see DEFAULT_FAILURE_TTL_MS.
 */
export async function withCache<T>(
  key: string,
  compute: () => Promise<GeminiResult<T>>,
  opts?: { successTtlMs?: number; failureTtlMs?: number }
): Promise<GeminiResult<T>> {
  const cached = readCache<T>(key);
  if (cached) return cached;

  const pending = inFlight.get(key) as Promise<GeminiResult<T>> | undefined;
  if (pending) return pending;

  const promise = compute()
    .then((result) => {
      writeCache(key, result, result.ok ? opts?.successTtlMs : opts?.failureTtlMs);
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/**
 * SHA-256, not a cheap 32-bit hash: this is used to build cache keys for
 * content-addressed lookups (embedTextsCached, the collection-analysis
 * cache), some of which — the analysis cache in particular — key off a
 * user's actual tab titles/URLs/page text. A 32-bit hash (~4 billion
 * outputs) hits meaningful collision odds well within this cache's
 * MAX_ENTRIES cap (birthday-bound ~77k entries for 50% odds), and a
 * collision there would mean one user's cached AI analysis gets served
 * back for a completely different, unrelated set of tabs — a real
 * cross-user data leak, not just a cosmetic bug. SHA-256's 2^256 space
 * makes that practically impossible. This is a cache key, not a password
 * hash, so no salt/iteration count is needed — just collision resistance.
 */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function __clearServerCacheForTests(): void {
  store.clear();
  inFlight.clear();
}
