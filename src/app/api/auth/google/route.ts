import "server-only";
import { findOrCreateUser } from "@/lib/auth/account";
import { jsonWithCookies } from "@/lib/auth/cookies";
import { verifyGoogleCredential } from "@/lib/auth/google";
import type { GoogleVerifyFailure } from "@/lib/auth/google";
import { clearNonceCookie, readNonceHash } from "@/lib/auth/nonce";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { checkAuthRateLimit } from "@/lib/auth/rate-limit";
import { createSession, revokePresentedSession } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";
import { toPublicUser } from "@/lib/auth/types";

export const runtime = "nodejs";

/**
 * Step two of a sign-in: exchange a Google credential for a TabDump
 * session.
 *
 *   credential -> verify against Google's keys -> find/create TabDump user
 *              -> mint TabDump session -> HttpOnly cookie
 *
 * Nothing about the request body is trusted. The only identity that reaches
 * the account layer is the one lifted off a token whose signature, issuer,
 * audience, expiry and nonce all checked out server-side — which is why
 * there is no `email` or `userId` field in the accepted body, and why
 * sending one would change nothing.
 */

/** A Google credential is a JWT; anything wildly outside that shape is rejected before it reaches the verifier. */
const MAX_CREDENTIAL_CHARS = 8000;

/**
 * What the browser is told for each failure. Specific enough to be
 * actionable, vague enough to leak nothing: a caller cannot tell a
 * misconfigured client ID from a forged signature, and no verifier message
 * or stack trace is ever echoed back.
 */
const FAILURE_MESSAGE: Record<GoogleVerifyFailure, string> = {
  "not-configured": "Sign-in isn't available on this deployment yet.",
  "invalid-credential": "That Google sign-in couldn't be verified. Try again.",
  "expired-credential": "That sign-in took too long — try again.",
  "wrong-audience": "That Google sign-in couldn't be verified. Try again.",
  "nonce-mismatch": "That sign-in has already been used — try again.",
  "unverified-email": "Your Google account's email address isn't verified yet.",
  "incomplete-profile": "Google didn't share enough profile information to create an account.",
  "network-error": "Couldn't reach Google to verify your sign-in. Try again.",
};

const FAILURE_STATUS: Record<GoogleVerifyFailure, number> = {
  "not-configured": 503,
  "invalid-credential": 401,
  "expired-credential": 401,
  "wrong-audience": 401,
  "nonce-mismatch": 401,
  "unverified-email": 403,
  "incomplete-profile": 401,
  "network-error": 502,
};

export async function POST(request: Request): Promise<Response> {
  // Every response below clears the nonce cookie, success or failure — that
  // is what makes a nonce single-use, so a captured credential can never be
  // submitted a second time.
  const nonceCleared = [clearNonceCookie()];

  if (!isSameOrigin(request) || !hasJsonContentType(request)) {
    return jsonWithCookies({ error: "Request rejected." }, { status: 403, cookies: nonceCleared });
  }

  const rate = checkAuthRateLimit(request, "google");
  if (!rate.allowed) {
    return jsonWithCookies(
      { error: "Too many sign-in attempts — try again shortly." },
      {
        status: 429,
        cookies: nonceCleared,
        headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWithCookies({ error: "Malformed JSON body." }, { status: 400, cookies: nonceCleared });
  }

  const credential = (body as { credential?: unknown } | null)?.credential;
  if (typeof credential !== "string" || credential.length === 0 || credential.length > MAX_CREDENTIAL_CHARS) {
    return jsonWithCookies({ error: "Expected { credential: string }." }, { status: 400, cookies: nonceCleared });
  }

  const expectedNonceHash = readNonceHash(request);
  if (!expectedNonceHash) {
    // No pending nonce: a stale tab, a cleared cookie jar, or a credential
    // posted from somewhere that never asked us for one.
    return jsonWithCookies(
      { error: "That sign-in has expired — try again." },
      { status: 401, cookies: nonceCleared }
    );
  }

  const verified = await verifyGoogleCredential(credential, expectedNonceHash);
  if (!verified.ok) {
    // Logged for operators, never returned to the browser: `detail` is the
    // verifier's own message, which is exactly what makes a misconfigured
    // client ID diagnosable ("Wrong recipient, payload audience != …") and
    // exactly what must not reach a caller. It is safe in a server log —
    // the only identifier it can name is the client ID, which is public.
    // Every rejection is logged, including the ones that carry no detail
    // (a nonce mismatch storm is worth seeing).
    console.warn(`[auth] google credential rejected: ${verified.reason}${verified.detail ? ` — ${verified.detail}` : ""}`);
    return jsonWithCookies(
      { error: FAILURE_MESSAGE[verified.reason] },
      { status: FAILURE_STATUS[verified.reason], cookies: nonceCleared }
    );
  }

  const storeResult = await getAuthStore();
  if (!storeResult.ok) {
    // Already logged once per process by getAuthStore(); never echoed to the browser.
    return jsonWithCookies(
      { error: "Accounts aren't available on this deployment yet." },
      { status: 503, cookies: nonceCleared }
    );
  }

  try {
    const { user, created } = await findOrCreateUser(storeResult.store, verified.identity);

    // The cookie this request arrived with (if any) is about to be replaced,
    // so the row behind it becomes unreachable — and an unreachable session
    // is one nobody can ever revoke. Dropping it here means signing in again
    // evicts any leaked copy of the previous token, and stops account
    // switching from stranding a live session per switch.
    await revokePresentedSession(request);

    const { cookie } = await createSession(storeResult.store, user.id);

    return jsonWithCookies(
      { user: toPublicUser(user), created },
      { cookies: [...nonceCleared, cookie] }
    );
  } catch (error) {
    // A store failure (database unreachable, schema not applied) — the
    // message can contain connection details, so it is logged only.
    console.error("[auth] sign-in failed:", error instanceof Error ? error.message : error);
    return jsonWithCookies(
      { error: "Couldn't complete sign-in right now. Try again." },
      { status: 500, cookies: nonceCleared }
    );
  }
}
