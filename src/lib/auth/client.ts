import type { PublicUser } from "./types";

/**
 * Browser-side calls to TabDump's own auth endpoints.
 *
 * Every one of these is a same-origin fetch that relies entirely on the
 * HttpOnly session cookie the server sets — there is no token to read,
 * store, or attach here, which is the point. Nothing in this file (or
 * anywhere else client-side) ever touches localStorage for auth: a session
 * value reachable from JavaScript is a session value reachable from any
 * injected script.
 */

export type AuthStateResponse = {
  authenticated: boolean;
  user: PublicUser | null;
  /** False when this deployment has no Google client ID / account store — the UI hides sign-in entirely rather than offering a button that can't work. */
  configured: boolean;
};

/** Failure shape shared by every call below. `message` is always something safe to show a user — the server never sends internals. */
export type AuthRequestError = { message: string; status: number };

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * `same-origin` rather than `include`: these endpoints are only ever called
 * from this app's own origin, and the narrower setting means a stray
 * cross-origin call can never carry the session cookie.
 */
const FETCH_OPTIONS: RequestInit = { credentials: "same-origin", cache: "no-store" };

async function readError(response: Response, fallback: string): Promise<AuthRequestError> {
  try {
    const body = await response.json();
    const message = typeof body?.error === "string" ? body.error : fallback;
    return { message, status: response.status };
  } catch {
    return { message: fallback, status: response.status };
  }
}

/** What a check that couldn't complete resolves to. Signed out, and sign-in hidden — the reading that never renders a signed-in shell on the strength of a failed check. */
const UNKNOWN_AUTH_STATE: AuthStateResponse = { authenticated: false, user: null, configured: false };

/**
 * Restores auth state after a reload. The server session is the source of
 * truth — a previous render believing the user was signed in counts for
 * nothing.
 *
 * Never rejects. An offline browser, a DNS failure or a 500 all resolve to
 * the signed-out state instead, because the caller is a provider whose only
 * other option would be to leave the whole app stuck on "loading" forever.
 * (An aborted request is the exception: it rethrows, so a caller that
 * cancelled can tell that from a real answer.)
 */
export async function fetchAuthState(signal?: AbortSignal): Promise<AuthStateResponse> {
  try {
    const response = await fetch("/api/auth/me", { ...FETCH_OPTIONS, signal });
    // /me answers 200 for signed-out too, so a non-200 here is a transport
    // or server problem rather than an answer.
    if (!response.ok) return UNKNOWN_AUTH_STATE;
    return (await response.json()) as AuthStateResponse;
  } catch (error) {
    if (signal?.aborted) throw error;
    return UNKNOWN_AUTH_STATE;
  }
}

/**
 * The network failure every call below shares. An offline browser or a
 * dropped connection is a normal thing for a sign-in to hit, so it becomes
 * a plain error result rather than a rejected promise — every caller here
 * is a UI handler, and an escaped rejection would surface as an unhandled
 * error instead of a message the user can act on.
 */
function offlineError(fallback: string): AuthRequestError {
  return { message: fallback, status: 0 };
}

/** Asks the server for a single-use login nonce (see src/lib/auth/nonce.ts). Its hash lands in an HttpOnly cookie as a side effect of this call. */
export async function requestLoginNonce(): Promise<{ ok: true; nonce: string } | { ok: false; error: AuthRequestError }> {
  const failure = "Couldn't start sign-in. Check your connection and try again.";
  try {
    const response = await fetch("/api/auth/nonce", { ...FETCH_OPTIONS, method: "POST" });
    if (!response.ok) return { ok: false, error: await readError(response, failure) };

    const body = (await response.json()) as { nonce?: unknown };
    if (typeof body.nonce !== "string") return { ok: false, error: { message: failure, status: 500 } };
    return { ok: true, nonce: body.nonce };
  } catch {
    return { ok: false, error: offlineError(failure) };
  }
}

/** Hands the Google credential to our backend, which verifies it and (only then) issues a TabDump session. */
export async function exchangeGoogleCredential(
  credential: string
): Promise<{ ok: true; user: PublicUser; created: boolean } | { ok: false; error: AuthRequestError }> {
  const failure = "Couldn't complete sign-in. Check your connection and try again.";
  try {
    const response = await fetch("/api/auth/google", {
      ...FETCH_OPTIONS,
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ credential }),
    });

    if (!response.ok) return { ok: false, error: await readError(response, failure) };

    const body = (await response.json()) as { user?: PublicUser; created?: boolean };
    if (!body.user) return { ok: false, error: { message: failure, status: 500 } };
    return { ok: true, user: body.user, created: Boolean(body.created) };
  } catch {
    return { ok: false, error: offlineError(failure) };
  }
}

/** Ends the session server-side and clears the cookie. Local state is only cleared once this succeeds — see AuthProvider. */
export async function signOutRequest(): Promise<{ ok: true } | { ok: false; error: AuthRequestError }> {
  const failure = "Couldn't sign you out. Check your connection and try again.";
  try {
    const response = await fetch("/api/auth/logout", { ...FETCH_OPTIONS, method: "POST" });
    if (!response.ok) return { ok: false, error: await readError(response, failure) };
    return { ok: true };
  } catch {
    return { ok: false, error: offlineError(failure) };
  }
}
