import "server-only";
import { NONCE_COOKIE, NONCE_TTL_MS, nonceCookieOptions } from "./config";
import { readCookie, serializeCookie } from "./cookies";
import { createNonce, hashNonce } from "./tokens";

/**
 * The login nonce: a single-use value that ties one Google credential to
 * one browser and one sign-in attempt.
 *
 * The browser asks for a nonce (POST /api/auth/nonce), hands it to Google
 * Identity Services, and Google embeds it as a signed `nonce` claim in the
 * ID token it returns. /api/auth/google then only accepts a credential
 * whose nonce matches what THIS browser was issued.
 *
 * That closes two holes at once:
 *
 * - **Replay.** A credential captured anywhere else (an old request log, a
 *   different device, a different tab) carries a nonce this browser was
 *   never issued, so it is rejected even though it is a perfectly valid,
 *   correctly signed Google token.
 * - **Login CSRF.** Without it, an attacker can cross-post *their own*
 *   valid credential into a victim's browser and silently sign the victim
 *   into the attacker's account — after which the victim's tabs are dumped
 *   into an account the attacker controls. The attacker cannot mint a
 *   Google token carrying the victim's nonce, so this stops it. SameSite=Lax
 *   already blocks the cross-site POST itself; the nonce is what makes the
 *   defence independent of cookie policy.
 *
 * The cookie stores only the *hash* of the nonce, so the value sitting in
 * the browser jar can't be used to construct a matching credential request
 * by itself. Lifetime is the cookie's Max-Age plus the fact that the cookie
 * is cleared on every use — issue, use once, gone.
 */

/** Issues a nonce: the raw value goes to the caller (and on to Google), the hash goes into a short-lived HttpOnly cookie. */
export function issueLoginNonce(): { nonce: string; cookie: string } {
  const nonce = createNonce();
  const cookie = serializeCookie(
    NONCE_COOKIE,
    hashNonce(nonce),
    nonceCookieOptions(Math.floor(NONCE_TTL_MS / 1000))
  );
  return { nonce, cookie };
}

/** The hash this browser was issued, or null when it holds no (or an unreadable) nonce cookie. */
export function readNonceHash(request: Request): string | null {
  return readCookie(request, NONCE_COOKIE);
}

/**
 * Expires the nonce cookie. Emitted on every /api/auth/google response —
 * success or failure alike — which is what makes a nonce single-use: a
 * second attempt has to start over with a fresh one, so a credential can
 * never be submitted twice.
 */
export function clearNonceCookie(): string {
  return serializeCookie(NONCE_COOKIE, "", nonceCookieOptions(0));
}
