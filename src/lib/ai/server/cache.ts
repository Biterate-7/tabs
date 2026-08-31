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
 * span multiple instances. Used by embed-cache.ts to dedupe/cache embedding
 * calls for Auto-Organize's semantic clustering hints.
 */
type Entry = { value: GeminiResult<unknown>; expiresAt: number; cachedAt: number };

const store = new Map<string, Entry>();

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
 * SHA-256, not a cheap 32-bit hash: this is used to build cache keys for
 * content-addressed lookups (embedTextsCached). A 32-bit hash (~4 billion
 * outputs) hits meaningful collision odds well within this cache's
 * MAX_ENTRIES cap, and a collision there would mean one cached embedding
 * gets served back for a completely different, unrelated text. SHA-256's
 * 2^256 space makes that practically impossible. This is a cache key, not a
 * password hash, so no salt/iteration count is needed — just collision
 * resistance.
 */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function __clearServerCacheForTests(): void {
  store.clear();
}
