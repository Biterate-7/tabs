import "server-only";
import { isGoogleConfigured } from "@/lib/auth/config";
import { jsonWithCookies } from "@/lib/auth/cookies";
import { clearSessionCookie, getSession } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * The frontend's source of truth for "who am I?".
 *
 * Called on every page load rather than trusting anything the browser
 * remembered: a session can have been revoked, expired, or signed out from
 * another tab since the last render, and only the server knows. Signed-out
 * is a normal 200 answer, not an error — the UI needs to render a
 * signed-out shell, not an error state.
 *
 * `configured` tells the UI whether this deployment can do accounts at all,
 * so a deployment without a Google client ID (or without an account
 * database) hides sign-in rather than offering a button that cannot work.
 */
export async function GET(request: Request): Promise<Response> {
  const result = await getSession(request);

  if (result.ok) {
    return jsonWithCookies(
      { authenticated: true, user: result.auth.user, configured: true },
      // Present only when this request slid the session's expiry forward —
      // keeps the cookie's lifetime in step with the row's.
      { cookies: result.auth.refreshedCookie ? [result.auth.refreshedCookie] : [] }
    );
  }

  if (result.reason === "not-configured") {
    // Already logged once per process by getAuthStore(); never echoed to the browser.
    return jsonWithCookies({ authenticated: false, user: null, configured: false });
  }

  return jsonWithCookies(
    { authenticated: false, user: null, configured: isGoogleConfigured() },
    {
      // A cookie that resolved to nothing is dead weight that would be sent
      // on every subsequent request; clearing it also stops a browser from
      // sitting on a revoked token indefinitely.
      cookies: result.reason === "invalid-session" ? [clearSessionCookie()] : [],
    }
  );
}
