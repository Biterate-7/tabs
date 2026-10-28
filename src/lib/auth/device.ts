import "server-only";
import { createHash } from "node:crypto";
import { createRecordId, createSessionToken, hashSessionToken, safeEqual } from "./tokens";
import { toPublicUser } from "./types";
import type { AuthStore, DeviceSession, PublicUser } from "./types";

/**
 * Hubble Desktop's account credential — the pairing flow
 * docs/auth-architecture.md prescribes for a client that cannot use the web
 * session cookie.
 *
 *   desktop: verifier (random, kept in the app), challenge = S256(verifier)
 *        │  opens  /desktop/connect?challenge=…&state=…  in the default browser
 *        ▼
 *   web page, signed in with the ordinary cookie session
 *        │  POST /api/auth/desktop/authorize { challenge }   (same-origin, cookie)
 *        │  → single-use code, minutes to live, bound to the user + challenge
 *        ▼
 *   hubble://auth/callback?code=…&state=…   (or the person pastes the code)
 *        ▼
 *   desktop (Rust, not the webview)
 *        │  POST /api/auth/desktop/token { code, verifier }
 *        │  → device token, its own row, its own expiry
 *        ▼
 *   Authorization: Bearer hbd_…  on every account request
 *
 * Why it is safe:
 *
 * - Identity only ever comes from a web session the server resolved. The
 *   desktop never asserts a user; the code is minted under `requireUser`.
 * - PKCE (RFC 7636, S256) binds the code to the app that asked for it: a code
 *   intercepted on its way back (a URL in history, another program claiming
 *   `hubble://`) is useless without the verifier, which never leaves the
 *   app. A wrong verifier burns the code, so it can't be guessed at.
 * - Codes are single-use (an atomic conditional UPDATE) and short-lived.
 * - The token is a separate type: a bearer header, never a cookie, so CSRF
 *   doesn't apply; and a cookie is never accepted where a token is presented
 *   (see getSession), so one can't stand in for the other.
 * - Only hashes are stored. Revoking a desktop deletes its row.
 */

/** How long a pairing code lives: long enough to switch back to the app, short enough to be worthless later. */
export const DEVICE_PAIRING_TTL_MS = 5 * 60 * 1000;
/** A device credential's life. Slid forward on use, like a web session, so an app in daily use never expires. */
export const DEVICE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const RENEW_WHEN_REMAINING_BELOW_MS = DEVICE_SESSION_TTL_MS / 2;

/** Prefixes make a leaked value recognisable for what it is (and greppable in a secret scanner). */
export const DEVICE_TOKEN_PREFIX = "hbd_";
export const DEVICE_CODE_PREFIX = "hbc_";

/** An S256 challenge: base64url SHA-256, no padding — exactly 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: 43–128 unreserved characters. The desktop sends base64url. */
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_LABEL_CHARS = 80;

export function isCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE.test(value);
}

export function isCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && VERIFIER.test(value);
}

/** base64url(SHA-256(verifier)) — the S256 transform. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A label the person will read in a list: printable, trimmed, bounded. Falls back to a plain name. */
export function cleanDeviceLabel(value: unknown): string {
  if (typeof value !== "string") return "Hubble Desktop";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
  return cleaned || "Hubble Desktop";
}

function secretOf(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const secret = value.slice(prefix.length);
  return SECRET.test(secret) ? secret : null;
}

/** Mints a pending pairing for `userId`. The raw code is returned once and never stored. */
export async function createDevicePairing(
  store: AuthStore,
  userId: string,
  challenge: string,
  label: string,
  now = Date.now()
): Promise<{ code: string; expiresAt: number }> {
  const code = `${DEVICE_CODE_PREFIX}${createSessionToken()}`;
  const expiresAt = now + DEVICE_PAIRING_TTL_MS;
  await store.createDevicePairing({
    id: createRecordId(),
    userId,
    codeHash: hashSessionToken(code),
    codeChallenge: challenge,
    tokenHash: null,
    label: cleanDeviceLabel(label),
    createdAt: now,
    expiresAt,
    lastUsedAt: null,
  });
  return { code, expiresAt };
}

export type RedeemFailure = "invalid-request" | "invalid-code";

/**
 * Exchanges a pairing code and its verifier for a device token. Every way a
 * code can be wrong — unknown, expired, already used, wrong verifier — is
 * the same `invalid-code` to the caller.
 */
export async function redeemDevicePairing(
  store: AuthStore,
  code: unknown,
  verifier: unknown,
  now = Date.now()
): Promise<{ ok: true; token: string; device: DeviceSession; user: PublicUser } | { ok: false; reason: RedeemFailure }> {
  if (typeof code !== "string" || !secretOf(code, DEVICE_CODE_PREFIX) || !isCodeVerifier(verifier)) {
    return { ok: false, reason: "invalid-request" };
  }
  const codeHash = hashSessionToken(code);
  const pairing = await store.findDevicePairingByCodeHash(codeHash);
  if (!pairing) return { ok: false, reason: "invalid-code" };

  if (pairing.expiresAt <= now || !safeEqual(challengeFor(verifier), pairing.codeChallenge)) {
    // A wrong verifier burns the code: there is no second guess.
    await store.deleteDeviceSession(pairing.id).catch(() => {});
    return { ok: false, reason: "invalid-code" };
  }

  const token = `${DEVICE_TOKEN_PREFIX}${createSessionToken()}`;
  const device = await store.redeemDevicePairing(pairing.id, codeHash, hashSessionToken(token), now + DEVICE_SESSION_TTL_MS, now);
  if (!device) return { ok: false, reason: "invalid-code" };

  const user = await store.findUserById(device.userId);
  if (!user) {
    await store.deleteDeviceSession(device.id).catch(() => {});
    return { ok: false, reason: "invalid-code" };
  }
  return { ok: true, token, device, user: toPublicUser(user) };
}

/**
 * The bearer token a request presents.
 *
 * - `undefined`: no Authorization header — the request is cookie-authenticated, if at all.
 * - `null`: an Authorization header that isn't a well-formed device token.
 *   Answered as an invalid session, never by falling back to the cookie.
 */
export function readDeviceToken(request: Request): string | null | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer (\S+)$/.exec(header.trim());
  if (!match) return null;
  return secretOf(match[1]!, DEVICE_TOKEN_PREFIX) ? match[1]! : null;
}

export type ResolvedDevice = { device: DeviceSession; user: PublicUser };

/** Resolves a device token to its live credential and user, sliding its expiry like a web session. Null for anything else. */
export async function resolveDeviceToken(store: AuthStore, token: string, now = Date.now()): Promise<ResolvedDevice | null> {
  const device = await store.findDeviceSessionByTokenHash(hashSessionToken(token));
  if (!device) return null;
  if (device.expiresAt <= now) {
    await store.deleteDeviceSession(device.id).catch(() => {});
    return null;
  }
  const user = await store.findUserById(device.userId);
  if (!user) {
    await store.deleteDeviceSession(device.id).catch(() => {});
    return null;
  }
  const renew = device.expiresAt - now < RENEW_WHEN_REMAINING_BELOW_MS ? now + DEVICE_SESSION_TTL_MS : undefined;
  await store.touchDeviceSession(device.id, now, renew).catch(() => {});
  return { device: { ...device, lastUsedAt: now, expiresAt: renew ?? device.expiresAt }, user: toPublicUser(user) };
}

/** What the web's list of connected desktops shows. No hash of anything. */
export type PublicDevice = { id: string; label: string; createdAt: number; lastUsedAt: number | null };

export function toPublicDevice(device: DeviceSession): PublicDevice {
  return { id: device.id, label: device.label, createdAt: device.createdAt, lastUsedAt: device.lastUsedAt };
}
