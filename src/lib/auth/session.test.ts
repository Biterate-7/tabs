import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./config";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSession,
  readSessionToken,
  requireAuth,
} from "./session";
import { MemoryAuthStore } from "./store/memory";
import { __setAuthStoreForTests } from "./store";
import { hashSessionToken } from "./tokens";
import type { AuthUser } from "./types";

let store: MemoryAuthStore;
let user: AuthUser;

beforeEach(async () => {
  store = new MemoryAuthStore();
  __setAuthStoreForTests(store);
  user = await store.createUser({
    id: "user-1",
    googleSub: "sub-1",
    email: "ada@example.com",
    name: "Ada",
    avatarUrl: null,
  });
});

afterEach(() => {
  __setAuthStoreForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The cookie value out of a Set-Cookie string, the way a browser would read it back. */
function cookieValue(setCookie: string): string {
  return decodeURIComponent(setCookie.split(";")[0].split("=").slice(1).join("="));
}

function requestWithToken(token: string | null): Request {
  return new Request("https://tabdump.example/api/auth/me", {
    headers: token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {},
  });
}

describe("createSession", () => {
  it("stores only the hash of the token it hands out", async () => {
    const { token, session } = await createSession(store, user.id);

    expect(session.tokenHash).toBe(hashSessionToken(token));
    expect(session.tokenHash).not.toBe(token);
    // The raw token exists nowhere in the store — this is what makes a
    // leaked session table unusable as a set of logins.
    expect(JSON.stringify(await store.findSessionByTokenHash(session.tokenHash))).not.toContain(token);
  });

  it("issues a cookie that is HttpOnly, SameSite=Lax and path-wide", async () => {
    const { cookie } = await createSession(store, user.id);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { cookie } = await createSession(store, user.id);
    expect(cookie).toContain("Secure");
  });

  it("expires roughly one TTL out", async () => {
    const { session } = await createSession(store, user.id);
    expect(session.expiresAt - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 5_000);
    expect(session.expiresAt - Date.now()).toBeLessThanOrEqual(SESSION_TTL_MS);
  });

  it("never reuses a token across sign-ins, so a planted cookie value is worthless", async () => {
    // Session fixation: whatever an attacker managed to set before login,
    // the value that comes back after login is one they have never seen.
    const first = await createSession(store, user.id);
    const second = await createSession(store, user.id);
    expect(second.token).not.toBe(first.token);
    expect(second.session.id).not.toBe(first.session.id);
  });
});

describe("getSession", () => {
  it("resolves the user behind a valid token", async () => {
    const { token } = await createSession(store, user.id);
    const result = await getSession(requestWithToken(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.auth.user).toEqual({ id: user.id, email: user.email, name: user.name, avatarUrl: null });
  });

  it("never exposes the session token or the google subject to the caller", async () => {
    const { token } = await createSession(store, user.id);
    const result = await getSession(requestWithToken(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.auth.user)).not.toContain(token);
    expect(JSON.stringify(result.auth.user)).not.toContain("sub-1");
  });

  it("reports no-session when no cookie is presented", async () => {
    const result = await getSession(requestWithToken(null));
    expect(result).toEqual({ ok: false, reason: "no-session" });
  });

  it("rejects a token that matches no session", async () => {
    const result = await getSession(requestWithToken("a".repeat(43)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-session");
  });

  it("rejects an expired session and deletes it on sight", async () => {
    const { token, session } = await createSession(store, user.id);
    await store.touchSession(session.id, Date.now(), Date.now() - 1);

    const result = await getSession(requestWithToken(token));
    expect(result.ok).toBe(false);
    expect(await store.findSessionByTokenHash(hashSessionToken(token))).toBeNull();
  });

  it("rejects a session whose user has been deleted", async () => {
    const { token, session } = await createSession(store, user.id);
    store.__clear();
    await store.createSession(session);

    const result = await getSession(requestWithToken(token));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-session");
  });

  it("does not renew a young session", async () => {
    const { token } = await createSession(store, user.id);
    const result = await getSession(requestWithToken(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.auth.refreshedCookie).toBeUndefined();
  });

  it("slides the expiry once a session is past halfway through its life", async () => {
    const { token, session } = await createSession(store, user.id);

    // Age the session past the renewal threshold rather than waiting.
    vi.setSystemTime(new Date(session.createdAt + SESSION_TTL_MS * 0.75));
    const result = await getSession(requestWithToken(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.auth.refreshedCookie).toContain(SESSION_COOKIE);
    expect(result.auth.session.expiresAt).toBeGreaterThan(session.expiresAt);
    // And the row itself moved, not just the cookie.
    const stored = await store.findSessionByTokenHash(hashSessionToken(token));
    expect(stored?.expiresAt).toBeGreaterThan(session.expiresAt);
  });

  it("stops renewing once it has, instead of writing on every later request", async () => {
    // Regression: deciding from `now - createdAt` (which never moves) made
    // renewal permanently true past the halfway mark — a database write and
    // a redundant Set-Cookie on every single request from then on. Deciding
    // from remaining life is self-limiting.
    const { token, session } = await createSession(store, user.id);

    vi.setSystemTime(new Date(session.createdAt + SESSION_TTL_MS * 0.75));
    const renewing = await getSession(requestWithToken(token));
    expect(renewing.ok && renewing.auth.refreshedCookie).toBeTruthy();

    // A moment later the session is freshly extended, so this request must
    // do no bookkeeping at all.
    vi.setSystemTime(new Date(session.createdAt + SESSION_TTL_MS * 0.75 + 1000));
    const settled = await getSession(requestWithToken(token));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.auth.refreshedCookie).toBeUndefined();

    // …and it only comes back round after another half-TTL of use.
    vi.setSystemTime(new Date(session.createdAt + SESSION_TTL_MS * 1.5));
    const later = await getSession(requestWithToken(token));
    expect(later.ok && later.auth.refreshedCookie).toBeTruthy();
  });

  it("keeps two users' sessions entirely separate", async () => {
    const other = await store.createUser({
      id: "user-2",
      googleSub: "sub-2",
      email: "grace@example.com",
      name: "Grace",
      avatarUrl: null,
    });
    const ada = await createSession(store, user.id);
    const grace = await createSession(store, other.id);

    const asAda = await getSession(requestWithToken(ada.token));
    const asGrace = await getSession(requestWithToken(grace.token));

    expect(asAda.ok && asAda.auth.user.id).toBe("user-1");
    expect(asGrace.ok && asGrace.auth.user.id).toBe("user-2");
  });
});

describe("requireAuth", () => {
  it("is the same gate as getSession", async () => {
    const { token } = await createSession(store, user.id);
    const result = await requireAuth(requestWithToken(token));
    expect(result.ok).toBe(true);
  });

  it("refuses a request with no session", async () => {
    expect((await requireAuth(requestWithToken(null))).ok).toBe(false);
  });
});

describe("destroySession", () => {
  it("deletes the row and clears the cookie", async () => {
    const { token } = await createSession(store, user.id);

    const { cookie } = await destroySession(requestWithToken(token));

    expect(await store.findSessionByTokenHash(hashSessionToken(token))).toBeNull();
    expect(cookieValue(cookie)).toBe("");
    expect(cookie).toContain("Max-Age=0");
  });

  it("makes the destroyed token unusable afterwards", async () => {
    const { token } = await createSession(store, user.id);
    await destroySession(requestWithToken(token));

    // The real test of logout: the token is dead server-side, so even a
    // browser (or anything else) that kept a copy of it gets nothing.
    const result = await getSession(requestWithToken(token));
    expect(result.ok).toBe(false);
  });

  it("leaves the user's other sessions alone", async () => {
    const phone = await createSession(store, user.id);
    const laptop = await createSession(store, user.id);

    await destroySession(requestWithToken(laptop.token));

    expect((await getSession(requestWithToken(phone.token))).ok).toBe(true);
  });

  it("succeeds with no session to destroy", async () => {
    const { cookie } = await destroySession(requestWithToken(null));
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("cookie helpers", () => {
  it("reads the session token back out of a request", () => {
    expect(readSessionToken(requestWithToken("tok"))).toBe("tok");
    expect(readSessionToken(requestWithToken(null))).toBeNull();
  });

  it("clears with an empty, immediately expiring cookie", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });
});
