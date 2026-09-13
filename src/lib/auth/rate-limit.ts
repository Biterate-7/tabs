import "server-only";
import { getClientIp } from "@/lib/ai/server/client-ip";
import { checkRateLimit } from "@/lib/ai/server/rate-limit";
import type { RateLimitResult } from "@/lib/ai/server/rate-limit";

/**
 * Per-IP limiting for the sign-in endpoints, reusing the fixed-window
 * limiter the AI routes already use rather than standing up a second one.
 *
 * There is no password to brute-force here — a sign-in needs a genuine,
 * Google-signed ID token — so this isn't guarding a credential. What it
 * caps is the cost: every submitted credential costs an RSA verification,
 * and every nonce request costs a CSPRNG draw and a response. A generous
 * ceiling stops one caller from turning those into a cheap CPU sink while
 * being far above anything a real person signing in will ever reach.
 *
 * Same limitations as the AI limiter it builds on (in-memory, per process,
 * resets on restart), and the same deliberate skip when no proxy header
 * identifies the caller — see checkAiRateLimit's doc comment.
 */
export const AUTH_RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

/**
 * Sync's ceiling, which has to be far higher than the sign-in one because
 * sync is *polled* while sign-in is a one-off human action.
 *
 * The arithmetic that sets the floor: src/lib/sync/triggers.ts fires every
 * 60s, so an open tab makes 10 passes per 10-minute window, and each pass
 * issues at least one GET /api/sync/pull *per workspace* — the pull loop in
 * the engine runs unconditionally, not only when something is dirty. An
 * idle user therefore spends `workspaces * 10` requests per window doing
 * nothing at all, before a single focus or visibility trigger is counted.
 *
 * Against AUTH_RATE_LIMIT's 30 that put three workspaces exactly at the
 * ceiling and four permanently past it: sync fell into a 429/backoff cycle
 * and simply stopped working, which is how this was found in production.
 * The limit is also per-IP, so everyone behind one office or campus NAT
 * shares a single bucket and hits it that much sooner.
 *
 * 600 is one request per second sustained, which leaves a ten-workspace
 * user (~120/window) and several such users on one IP comfortable headroom
 * while still capping what a single address can cost. It is a ceiling on
 * abuse, not a throttle on normal use — the distinction the old value lost.
 */
export const SYNC_RATE_LIMIT = { limit: 600, windowMs: 10 * 60 * 1000 };

export function checkAuthRateLimit(
  request: Request,
  keyPrefix: string,
  limit: { limit: number; windowMs: number } = AUTH_RATE_LIMIT
): RateLimitResult {
  const ip = getClientIp(request);
  if (ip === "unknown") return { allowed: true };
  return checkRateLimit(`auth:${keyPrefix}:${ip}`, limit);
}
