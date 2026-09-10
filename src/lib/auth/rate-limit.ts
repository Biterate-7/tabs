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

export function checkAuthRateLimit(request: Request, keyPrefix: string): RateLimitResult {
  const ip = getClientIp(request);
  if (ip === "unknown") return { allowed: true };
  return checkRateLimit(`auth:${keyPrefix}:${ip}`, AUTH_RATE_LIMIT);
}
