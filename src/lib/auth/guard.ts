import "server-only";
import { requireAuth } from "./session";
import type { AuthFailure, ResolvedSession } from "./session";
import type { PublicUser } from "./types";

/**
 * The reusable authentication gate for route handlers, so no route
 * re-implements "read cookie, hash, look up, check expiry" for itself.
 *
 * Two shapes, because the two needs are genuinely different:
 *
 * - `requireUser` — hard gate. Either an authenticated user, or a ready-made
 *   401/503 Response to return immediately.
 * - `optionalUser` — for endpoints that must keep working signed-out (the
 *   Gemini-backed AI routes, which have always been public) but can do
 *   something better when they know who is asking.
 */

/** What the browser is told when authentication fails. Deliberately uniform: nothing here distinguishes "expired" from "forged", and no internal detail is echoed back. */
const FAILURE_MESSAGE: Record<AuthFailure, string> = {
  "no-session": "Sign in to continue.",
  "invalid-session": "Your session has expired — sign in again.",
  "not-configured": "Accounts aren't available on this deployment yet.",
};

const FAILURE_STATUS: Record<AuthFailure, number> = {
  "no-session": 401,
  "invalid-session": 401,
  // Not the caller's fault and not fixable by signing in — this is a
  // deployment that has no account store configured at all.
  "not-configured": 503,
};

export type RequireUserResult =
  | { ok: true; auth: ResolvedSession; user: PublicUser }
  | { ok: false; response: Response };

export async function requireUser(request: Request): Promise<RequireUserResult> {
  const result = await requireAuth(request);
  if (result.ok) return { ok: true, auth: result.auth, user: result.auth.user };

  // `detail` (which names environment variables) is deliberately dropped
  // here: getAuthStore() already logged it once per process, and the
  // browser must only ever see the plain message below.

  return {
    ok: false,
    response: Response.json(
      { error: FAILURE_MESSAGE[result.reason] },
      { status: FAILURE_STATUS[result.reason] }
    ),
  };
}

/** Resolves the signed-in user when there is one, and `null` otherwise — never an error. For public endpoints that want an identity when available. */
export async function optionalUser(request: Request): Promise<PublicUser | null> {
  const result = await requireAuth(request);
  return result.ok ? result.auth.user : null;
}
