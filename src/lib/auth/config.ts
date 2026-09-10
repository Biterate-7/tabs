import "server-only";
import type { CookieOptions } from "./cookies";

/**
 * Server-side auth configuration. Mirrors the shape of src/lib/ai/config.ts
 * (small named readers rather than constants captured at module load) so
 * environment changes are picked up the same way the Gemini config already
 * does it, and so tests can set process.env per-case.
 *
 * The Google **client ID** is public by design — it ships in the browser
 * bundle because Google Identity Services needs it there. The Google
 * **client secret** is not read anywhere in this file, or anywhere else in
 * the codebase: the flow TabDump uses (verifying an ID token against
 * Google's published keys, see ./google.ts) has no step that requires it.
 */

/** Name of the session cookie. Read on every authenticated request; written only by the auth routes. */
export const SESSION_COOKIE = "tabdump_session";

/** Short-lived cookie holding the hash of the login nonce — see ./nonce.ts. */
export const NONCE_COOKIE = "tabdump_login_nonce";

/** 30 days. Long enough that a regular user is never asked to sign in again mid-project, short enough that an abandoned session on a shared machine does expire. Sliding: see touchSession/refresh in ./session.ts. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a login nonce stays valid. Covers a slow Google account-chooser interaction, nothing more. */
export const NONCE_TTL_MS = 10 * 60 * 1000;

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The OAuth client ID, and therefore the audience every incoming Google ID
 * token is checked against.
 *
 * `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is the canonical name — the browser needs
 * this value, so it has to carry the NEXT_PUBLIC_ prefix, and having one
 * variable rather than two removes a whole class of "the server checks a
 * different audience than the browser requested" misconfiguration.
 * `GOOGLE_CLIENT_ID` is accepted as a server-side alias for anyone who set
 * it out of habit; if both are present and disagree, the public one wins
 * (it is the one the browser actually used) and the mismatch is logged.
 */
export function googleClientId(): string | undefined {
  const publicId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() || undefined;
  const serverId = process.env.GOOGLE_CLIENT_ID?.trim() || undefined;

  if (publicId && serverId && publicId !== serverId) {
    console.warn(
      "[auth] GOOGLE_CLIENT_ID and NEXT_PUBLIC_GOOGLE_CLIENT_ID differ — using NEXT_PUBLIC_GOOGLE_CLIENT_ID, " +
        "which is the value the browser signs in with. Set them to the same client ID, or drop GOOGLE_CLIENT_ID."
    );
  }

  return publicId ?? serverId;
}

/** True once a Google client ID is configured. Sign-in is offered to the browser only when this holds. */
export function isGoogleConfigured(): boolean {
  return Boolean(googleClientId());
}

/**
 * Cookie attributes for the session cookie.
 *
 * `Secure` is conditioned on production for exactly one reason: a `Secure`
 * cookie is silently dropped over plain http, which is what `next dev`
 * serves on localhost. Every deployed environment is https, so this is a
 * development-only relaxation and never weakens the production cookie.
 *
 * `SameSite=Lax` (not None) means the cookie is not attached to
 * cross-site subrequests at all, which is the primary CSRF defence for the
 * mutating auth routes; the Origin check in ./origin.ts is the second.
 */
export function sessionCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "Lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function nonceCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "Lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
