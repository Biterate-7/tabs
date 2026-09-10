import "server-only";
import { OAuth2Client } from "google-auth-library";
import { googleClientId } from "./config";
import { hashNonce, safeEqual } from "./tokens";
import type { GoogleIdentity } from "./types";

/**
 * Server-side verification of the Google ID token ("credential") the
 * browser hands us after a successful Sign in with Google.
 *
 * This is the single trust boundary of the whole account system: everything
 * downstream — which account gets created, which session is issued, whose
 * data is served — follows from what this function returns. A credential
 * that merely *arrived* from our own frontend proves nothing; anyone can
 * POST a string to /api/auth/google.
 *
 * The cryptography is google-auth-library's, not ours. `verifyIdToken`
 * fetches and caches Google's published signing certificates and checks, in
 * one pass: the RS256 signature, `iss` (accounts.google.com), `aud` (our
 * client ID), and the `exp`/`iat` window. The extra checks layered on top
 * here — `nonce`, `email_verified` — are claim-level policy, not crypto.
 */

export type GoogleVerifyResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; reason: GoogleVerifyFailure; detail?: string };

export type GoogleVerifyFailure =
  /** No client ID configured on this deployment — nothing to verify against. */
  | "not-configured"
  /** Signature, issuer, or structure failed. Also the catch-all for anything unrecognised. */
  | "invalid-credential"
  /** The token is past its `exp` (or not yet valid). */
  | "expired-credential"
  /** Signed by Google, but issued for a different OAuth client — i.e. not for this app. */
  | "wrong-audience"
  /** The `nonce` claim didn't match the one this browser was issued — a replayed or cross-session credential. */
  | "nonce-mismatch"
  /** Google itself hasn't verified this address, so we won't attach an account to it. */
  | "unverified-email"
  /** Token verified, but is missing a claim the account model requires (`sub`/`email`). */
  | "incomplete-profile"
  /** Couldn't reach Google to fetch its signing certificates. */
  | "network-error";

let client: OAuth2Client | undefined;

function getClient(): OAuth2Client {
  // One client per process so its certificate cache is actually reused —
  // a fresh OAuth2Client per request would re-fetch Google's certs on every
  // sign-in. Constructed with no client secret: this flow never needs one.
  client ??= new OAuth2Client();
  return client;
}

/**
 * Maps google-auth-library's thrown Errors onto our own failure reasons.
 *
 * The library signals these cases by message text rather than by typed
 * error, so this is string matching — deliberately narrow, and falling back
 * to the generic "invalid-credential" for anything it doesn't recognise.
 * The worst case if a message ever changes upstream is a less specific
 * (never a more permissive) reason: nothing here can turn a rejected token
 * into an accepted one.
 */
function classifyVerifyError(error: unknown): { reason: GoogleVerifyFailure; detail: string } {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Token used too late") || message.includes("Token used too early")) {
    return { reason: "expired-credential", detail: message };
  }
  if (message.includes("Wrong recipient") || message.includes("audience")) {
    return { reason: "wrong-audience", detail: message };
  }
  if (message.includes("ENOTFOUND") || message.includes("ETIMEDOUT") || message.includes("fetch failed")) {
    return { reason: "network-error", detail: message };
  }
  return { reason: "invalid-credential", detail: message };
}

/**
 * `expectedNonceHash` is the hash of the nonce this browser was issued
 * moments earlier (see ./nonce.ts) and echoed to Google when it asked for
 * the credential. Requiring it back in the signed token is what stops a
 * credential obtained elsewhere from being replayed here, and what stops an
 * attacker from silently signing a victim's browser into the attacker's own
 * account (login CSRF) — they cannot mint a token carrying the victim's
 * nonce. It is a required parameter rather than an option so no call site
 * can verify a credential without it.
 */
export async function verifyGoogleCredential(
  credential: string,
  expectedNonceHash: string
): Promise<GoogleVerifyResult> {
  const audience = googleClientId();
  if (!audience) return { ok: false, reason: "not-configured" };

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({ idToken: credential, audience });
    payload = ticket.getPayload();
  } catch (error) {
    const { reason, detail } = classifyVerifyError(error);
    return { ok: false, reason, detail };
  }

  if (!payload) return { ok: false, reason: "invalid-credential", detail: "empty payload" };

  // Constant-time, and required rather than optional: a token with no nonce
  // at all is rejected exactly like one with the wrong nonce, so the check
  // can't be skipped by simply omitting the claim.
  if (!payload.nonce || !safeEqual(hashNonce(payload.nonce), expectedNonceHash)) {
    return { ok: false, reason: "nonce-mismatch" };
  }

  if (payload.email_verified === false) {
    return { ok: false, reason: "unverified-email" };
  }

  if (!payload.sub || !payload.email) {
    return { ok: false, reason: "incomplete-profile" };
  }

  return {
    ok: true,
    identity: {
      googleSub: payload.sub,
      email: payload.email,
      // `name` and `picture` are only present when the `profile` scope was
      // granted, and Google documents both as never guaranteed — falling
      // back to the email's local part keeps the account UI from rendering
      // an empty name rather than inventing one.
      name: payload.name?.trim() || payload.email.split("@")[0],
      avatarUrl: payload.picture ?? null,
    },
  };
}
