import "server-only";
import { SESSION_COOKIE, SESSION_TTL_MS, sessionCookieOptions } from "./config";
import { readCookie, serializeCookie } from "./cookies";
import { getAuthStore } from "./store";
import { createRecordId, createSessionToken, hashSessionToken } from "./tokens";
import { toPublicUser } from "./types";
import type { AuthSession, AuthStore, PublicUser } from "./types";

/**
 * TabDump's own session layer. Google never sees a TabDump session and
 * TabDump never asks Google whether one is still valid: after sign-in, the
 * only thing that keeps a browser authenticated is a row in our own store.
 *
 * The shape is the standard opaque-token one:
 *
 *   cookie token -> SHA-256 -> session row -> user row -> expiry check -> request
 *
 * The browser holds the raw token in an HttpOnly cookie, so page JavaScript
 * (ours or an injected script's) cannot read it; the store holds only the
 * hash, so a leaked copy of the table cannot be replayed as a login. Logout
 * deletes the row, which is what makes it real rather than cosmetic.
 */

/**
 * Renew once a session has less than half its lifetime left.
 *
 * Expressed as *remaining* life rather than elapsed life, and that is the
 * whole point: `createdAt` never moves, so a rule like
 * `now - createdAt > TTL/2` becomes permanently true once a session passes
 * the halfway mark and every subsequent request pays for a database write
 * and a redundant Set-Cookie, forever. Measuring what is left is
 * self-limiting — a renewal restores a full TTL of remaining life, so the
 * next one cannot happen for another half-TTL.
 */
const RENEW_WHEN_REMAINING_BELOW_MS = SESSION_TTL_MS / 2;

export type ResolvedSession = {
  user: PublicUser;
  session: AuthSession;
  /**
   * Present only when the session's expiry was just slid forward — the
   * caller should append it to its response so the cookie's Max-Age tracks
   * the row's new expiry. Ignoring it is safe (the row is still extended);
   * the cookie would just expire earlier than the row.
   */
  refreshedCookie?: string;
};

export type AuthFailure =
  /** No session cookie at all — a signed-out browser, which is a normal state, not an error. */
  | "no-session"
  /** A cookie was presented but matches no live session: expired, signed out elsewhere, or simply forged. */
  | "invalid-session"
  /** Accounts aren't configured on this deployment (see ./store/index.ts). */
  | "not-configured";

export type AuthResult =
  | { ok: true; auth: ResolvedSession }
  | { ok: false; reason: AuthFailure; detail?: string };

/** The raw session token this request presented, if any. */
export function readSessionToken(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE);
}

export function sessionCookieFor(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return serializeCookie(SESSION_COOKIE, token, sessionCookieOptions(maxAge));
}

/** Expires the session cookie in the browser. Always paired with deleting the row — clearing one without the other is exactly the half-logout this system avoids. */
export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, "", sessionCookieOptions(0));
}

/**
 * Mints a session for `userId`. The raw token is returned to the caller
 * (once — it goes straight into a Set-Cookie header) and is never written
 * anywhere; only its hash reaches the store.
 *
 * A brand-new token per sign-in is also what rules out session fixation: an
 * attacker who managed to plant a cookie value in a victim's browser before
 * login gains nothing, because the value that comes back after login is one
 * they have never seen.
 */
export async function createSession(
  store: AuthStore,
  userId: string
): Promise<{ token: string; session: AuthSession; cookie: string }> {
  const token = createSessionToken();
  const now = Date.now();
  const session: AuthSession = {
    id: createRecordId(),
    userId,
    tokenHash: hashSessionToken(token),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastUsedAt: now,
  };
  await store.createSession(session);
  return { token, session, cookie: sessionCookieFor(token, session.expiresAt) };
}

/**
 * Resolves the session a request presents, or explains why it can't.
 *
 * An expired row is deleted on sight rather than merely rejected, so an
 * abandoned session doesn't linger in the store until the next housekeeping
 * pass. A row whose user has since been deleted is treated the same way as
 * a forged token — there is nothing to authenticate as.
 */
export async function getSession(request: Request): Promise<AuthResult> {
  const token = readSessionToken(request);
  if (!token) return { ok: false, reason: "no-session" };

  const storeResult = await getAuthStore();
  if (!storeResult.ok) return { ok: false, reason: "not-configured", detail: storeResult.detail };
  const store = storeResult.store;

  const session = await store.findSessionByTokenHash(hashSessionToken(token));
  if (!session) return { ok: false, reason: "invalid-session" };

  const now = Date.now();
  if (session.expiresAt <= now) {
    await store.deleteSession(session.id).catch(() => {});
    return { ok: false, reason: "invalid-session" };
  }

  const user = await store.findUserById(session.userId);
  if (!user) {
    await store.deleteSession(session.id).catch(() => {});
    return { ok: false, reason: "invalid-session" };
  }

  const shouldRenew = session.expiresAt - now < RENEW_WHEN_REMAINING_BELOW_MS;
  const nextExpiry = shouldRenew ? now + SESSION_TTL_MS : undefined;

  // Best-effort: a store hiccup on the bookkeeping write must not turn an
  // otherwise valid, authenticated request into a failure.
  await store.touchSession(session.id, now, nextExpiry).catch(() => {});

  return {
    ok: true,
    auth: {
      user: toPublicUser(user),
      session: nextExpiry ? { ...session, lastUsedAt: now, expiresAt: nextExpiry } : { ...session, lastUsedAt: now },
      refreshedCookie: nextExpiry ? sessionCookieFor(token, nextExpiry) : undefined,
    },
  };
}

/**
 * The one authentication gate every protected route should call.
 *
 * Returning a Result rather than throwing keeps the "who is this?" decision
 * in one place while leaving each route free to shape its own response —
 * and, crucially, means a route cannot accidentally proceed as if
 * authenticated by forgetting a try/catch. See ./guard.ts for the thin
 * wrapper that turns a failure straight into a 401 Response.
 */
export async function requireAuth(request: Request): Promise<AuthResult> {
  return getSession(request);
}

/**
 * Deletes the session row this request's cookie points at, if any, without
 * touching the browser's cookie.
 *
 * Two callers, for the same underlying reason — the token in that cookie is
 * about to stop being the browser's session, and a row nobody can reach is
 * a row nobody can revoke:
 *
 * - logout, which then also clears the cookie;
 * - sign-in, where the incoming cookie is about to be *overwritten* by a
 *   new one. Without this, signing in again (as the same account or a
 *   different one) would strand the previous session as a live, orphaned
 *   token: harmless if the cookie really was its only copy, but if it had
 *   leaked, re-signing-in would fail to evict the holder.
 */
export async function revokePresentedSession(request: Request): Promise<void> {
  const token = readSessionToken(request);
  if (!token) return;

  const storeResult = await getAuthStore();
  if (!storeResult.ok) return;

  const session = await storeResult.store.findSessionByTokenHash(hashSessionToken(token));
  if (session) await storeResult.store.deleteSession(session.id);
}

/**
 * Real logout: deletes the server-side row, then hands back the cookie that
 * clears the browser's copy. Order matters — the row goes first, so even if
 * the response is lost in flight the token is already dead.
 */
export async function destroySession(request: Request): Promise<{ cookie: string }> {
  await revokePresentedSession(request);
  return { cookie: clearSessionCookie() };
}
