import "server-only";
import { getClientIp } from "./client-ip";

/**
 * Fixed-window per-key rate limiter, in-memory. There's no auth/session
 * system in this codebase to key limits on a real user identity, so this is
 * keyed by client IP instead — the lightweight protection appropriate for
 * a free tool backed by a single shared Gemini key: it stops one caller
 * from burning the whole shared quota, without adding new infrastructure.
 * Like the cache in ./cache.ts, this resets on process restart and doesn't
 * span multiple instances.
 */
type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 5000;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

function evictStaleIfNeeded(nowMs: number, windowMs: number): void {
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.windowStart >= windowMs) buckets.delete(key);
  }
}

/**
 * checkRateLimit + client-IP resolution, with one deliberate special case:
 * when no reverse-proxy IP header is present at all (`getClientIp` falls
 * back to "unknown") — always true in local dev, and true in production
 * too if this app is ever deployed without a proxy in front — there is no
 * way to distinguish one caller from another. Rate-limiting that case
 * would do one of two bad things: silently share ONE bucket across every
 * real visitor to a proxy-less deployment (the opposite of "one free user
 * can't burn the whole quota"), or, in local dev, block a developer's own
 * testing after a handful of requests. Both are worse than skipping the
 * limit here and relying on Gemini's own 429 handling (see gemini/client.ts)
 * as the backstop for that specific case. Logged so a genuinely proxy-less
 * production deployment is diagnosable rather than silently unlimited.
 */
export function checkAiRateLimit(request: Request, keyPrefix: string, opts: { limit: number; windowMs: number }): RateLimitResult {
  const ip = getClientIp(request);
  if (ip === "unknown") {
    console.warn(`[rate-limit] no client IP header on this request (${keyPrefix}) — skipping per-IP limiting for it`);
    return { allowed: true };
  }
  return checkRateLimit(`${keyPrefix}:${ip}`, opts);
}

export function checkRateLimit(key: string, opts: { limit: number; windowMs: number }): RateLimitResult {
  const nowMs = Date.now();
  evictStaleIfNeeded(nowMs, opts.windowMs);

  const bucket = buckets.get(key);
  if (!bucket || nowMs - bucket.windowStart >= opts.windowMs) {
    buckets.set(key, { count: 1, windowStart: nowMs });
    return { allowed: true };
  }

  if (bucket.count >= opts.limit) {
    return { allowed: false, retryAfterMs: opts.windowMs - (nowMs - bucket.windowStart) };
  }

  bucket.count += 1;
  return { allowed: true };
}

export function __clearRateLimitsForTests(): void {
  buckets.clear();
}
