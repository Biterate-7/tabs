import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyIdTokenMock = vi.hoisted(() => vi.fn());

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = verifyIdTokenMock;
  },
}));

const { POST: signIn } = await import("./route");
const { POST: issueNonce } = await import("../nonce/route");
const { GET: me } = await import("../me/route");
const { POST: logOut } = await import("../logout/route");
const { MemoryAuthStore } = await import("@/lib/auth/store/memory");
const { __setAuthStoreForTests } = await import("@/lib/auth/store");
const { __clearRateLimitsForTests } = await import("@/lib/ai/server/rate-limit");

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";
const ORIGIN = "https://tabsdump.vercel.app";
const HOST = "tabsdump.vercel.app";

let store: InstanceType<typeof MemoryAuthStore>;

/**
 * A minimal cookie jar, so a test can carry cookies from one response into
 * the next request the way a browser does. Without it none of the
 * multi-step flows below (which are the whole point) can be exercised.
 */
class Jar {
  private cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attrs] = setCookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => a.trim().toLowerCase() === "max-age=0");
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

function request(
  path: string,
  init: { method?: string; body?: unknown; jar?: Jar; origin?: string | null; contentType?: string | null } = {}
): Request {
  const headers = new Headers({ host: HOST, "x-forwarded-proto": "https" });
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json");
  if (init.jar) {
    const cookie = init.jar.header();
    if (cookie) headers.set("cookie", cookie);
  }
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    sub: "115625890123456789012",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    picture: "https://lh3.googleusercontent.com/ada",
    ...overrides,
  };
}

/**
 * Stands in for Google: whatever nonce the browser was actually issued is
 * echoed back in the signed payload, exactly as Google does. Tests that
 * want a *mismatched* nonce override it explicitly.
 */
function respondWithGoogleToken(overrides: Record<string, unknown> = {}) {
  verifyIdTokenMock.mockImplementation(async ({ idToken }: { idToken: string }) => {
    const echoedNonce = idToken.startsWith("token-for:") ? idToken.slice("token-for:".length) : undefined;
    return { getPayload: () => payload({ nonce: echoedNonce, ...overrides }) };
  });
}

/** Runs the real two-step browser flow: ask for a nonce, then submit a credential carrying it. */
async function signInFlow(jar: Jar): Promise<Response> {
  const nonceResponse = await issueNonce(request("/api/auth/nonce"));
  jar.absorb(nonceResponse);
  const { nonce } = (await nonceResponse.json()) as { nonce: string };

  const response = await signIn(request("/api/auth/google", { body: { credential: `token-for:${nonce}` }, jar }));
  jar.absorb(response);
  return response;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", CLIENT_ID);
  store = new MemoryAuthStore();
  __setAuthStoreForTests(store);
  respondWithGoogleToken();
});

afterEach(() => {
  __setAuthStoreForTests(undefined);
  verifyIdTokenMock.mockReset();
  __clearRateLimitsForTests();
  vi.unstubAllEnvs();
});

describe("the sign-in flow end to end", () => {
  it("creates an account, sets an HttpOnly session cookie, and returns only safe user fields", async () => {
    const jar = new Jar();
    const response = await signInFlow(jar);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created).toBe(true);
    expect(body.user.email).toBe("ada@example.com");
    expect(body.user.name).toBe("Ada Lovelace");

    // Nothing sensitive comes back: no session token, no Google subject,
    // no internal timestamps.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("115625890123456789012");
    expect(serialized).not.toContain("googleSub");
    expect(serialized).not.toContain("tokenHash");

    const sessionCookie = response.headers.getSetCookie().find((c) => c.startsWith("tabdump_session="));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
  });

  it("keeps the session across a page reload", async () => {
    const jar = new Jar();
    await signInFlow(jar);

    const state = await (await me(request("/api/auth/me", { method: "GET", jar }))).json();

    expect(state.authenticated).toBe(true);
    expect(state.user.email).toBe("ada@example.com");
  });

  it("signs a returning user into the same account instead of creating a second", async () => {
    const first = await (await signInFlow(new Jar())).json();
    const second = await (await signInFlow(new Jar())).json();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("signs out for real — the token is dead server-side, not just cleared client-side", async () => {
    const jar = new Jar();
    await signInFlow(jar);
    // A copy of the cookie kept from before the sign-out, standing in for
    // anything that captured the token.
    const stolen = jar.header();

    const response = await logOut(request("/api/auth/logout", { jar }));
    expect(response.status).toBe(200);
    jar.absorb(response);

    expect(jar.has("tabdump_session")).toBe(false);

    const replay = new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: stolen, host: HOST } });
    expect((await (await me(replay)).json()).authenticated).toBe(false);
  });

  it("kills the previous session when the same browser signs in again", async () => {
    // The old cookie is about to be overwritten, so its row becomes
    // unreachable — and an unreachable session can never be revoked. A
    // leaked copy of the old token must stop working the moment the user
    // signs in again.
    const jar = new Jar();
    await signInFlow(jar);
    const stolen = jar.header();

    await signInFlow(jar);

    const replay = new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: stolen, host: HOST } });
    expect((await (await me(replay)).json()).authenticated).toBe(false);
    // …while the browser that actually signed in is fine.
    expect((await (await me(request("/api/auth/me", { method: "GET", jar }))).json()).authenticated).toBe(true);
  });

  it("kills the previous session when switching accounts, rather than stranding it", async () => {
    const jar = new Jar();
    await signInFlow(jar);
    const adaCookie = jar.header();

    respondWithGoogleToken({ sub: "999888777666555444333", email: "grace@example.com", name: "Grace Hopper" });
    await signInFlow(jar);

    const replay = new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: adaCookie, host: HOST } });
    expect((await (await me(replay)).json()).authenticated).toBe(false);

    const now = await (await me(request("/api/auth/me", { method: "GET", jar }))).json();
    expect(now.user.email).toBe("grace@example.com");
  });

  it("leaves a different browser's session for the same account alone", async () => {
    // Rotation must be scoped to the cookie actually presented — signing in
    // on a laptop cannot sign you out on a phone.
    const phone = new Jar();
    await signInFlow(phone);

    const laptop = new Jar();
    await signInFlow(laptop);

    expect((await (await me(request("/api/auth/me", { method: "GET", jar: phone }))).json()).authenticated).toBe(true);
    expect((await (await me(request("/api/auth/me", { method: "GET", jar: laptop }))).json()).authenticated).toBe(true);
  });

  it("keeps two accounts' sessions from ever resolving to each other", async () => {
    const adaJar = new Jar();
    await signInFlow(adaJar);

    respondWithGoogleToken({ sub: "999888777666555444333", email: "grace@example.com", name: "Grace Hopper" });
    const graceJar = new Jar();
    await signInFlow(graceJar);

    const asAda = await (await me(request("/api/auth/me", { method: "GET", jar: adaJar }))).json();
    const asGrace = await (await me(request("/api/auth/me", { method: "GET", jar: graceJar }))).json();

    expect(asAda.user.email).toBe("ada@example.com");
    expect(asGrace.user.email).toBe("grace@example.com");
    expect(asAda.user.id).not.toBe(asGrace.user.id);
  });
});

describe("what /api/auth/google refuses", () => {
  it("ignores any identity the client tries to assert for itself", async () => {
    const jar = new Jar();
    const nonceResponse = await issueNonce(request("/api/auth/nonce"));
    jar.absorb(nonceResponse);
    const { nonce } = (await nonceResponse.json()) as { nonce: string };

    const response = await signIn(
      request("/api/auth/google", {
        // The attacker-controlled fields the spec calls out: a userId and
        // an email supplied alongside the credential.
        body: { credential: `token-for:${nonce}`, userId: "user-of-someone-else", email: "victim@example.com" },
        jar,
      })
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    // Identity came from the verified token, not from the body.
    expect(body.user.email).toBe("ada@example.com");
    expect(body.user.id).not.toBe("user-of-someone-else");
  });

  it("rejects a request with no credential, and one that is not a string", async () => {
    const jar = new Jar();
    await issueNonce(request("/api/auth/nonce")).then((r) => jar.absorb(r));

    expect((await signIn(request("/api/auth/google", { body: {}, jar }))).status).toBe(400);
    expect((await signIn(request("/api/auth/google", { body: { credential: 42 }, jar }))).status).toBe(400);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    expect((await signIn(request("/api/auth/google", { body: "{not json" }))).status).toBe(400);
  });

  it("rejects an absurdly long credential before verifying anything", async () => {
    const jar = new Jar();
    await issueNonce(request("/api/auth/nonce")).then((r) => jar.absorb(r));

    const response = await signIn(request("/api/auth/google", { body: { credential: "x".repeat(9000) }, jar }));

    expect(response.status).toBe(400);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a credential submitted with no pending nonce", async () => {
    // No /api/auth/nonce call first: a credential posted from somewhere
    // that never asked us to start a sign-in.
    const response = await signIn(request("/api/auth/google", { body: { credential: "token-for:whatever" } }));

    expect(response.status).toBe(401);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a credential carrying somebody else's nonce", async () => {
    const jar = new Jar();
    await issueNonce(request("/api/auth/nonce")).then((r) => jar.absorb(r));

    const response = await signIn(request("/api/auth/google", { body: { credential: "token-for:not-my-nonce" }, jar }));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toMatch(/already been used|try again/i);
  });

  it("burns the nonce, so the same credential can never be replayed", async () => {
    const jar = new Jar();
    const nonceResponse = await issueNonce(request("/api/auth/nonce"));
    jar.absorb(nonceResponse);
    const { nonce } = (await nonceResponse.json()) as { nonce: string };
    const credential = `token-for:${nonce}`;

    const first = await signIn(request("/api/auth/google", { body: { credential }, jar }));
    jar.absorb(first);
    expect(first.status).toBe(200);

    // The nonce cookie is cleared on the way out, so a second submission of
    // the very same credential has nothing to check against.
    const replay = await signIn(request("/api/auth/google", { body: { credential }, jar }));
    expect(replay.status).toBe(401);
  });

  it("clears the nonce even when the sign-in fails", async () => {
    const jar = new Jar();
    await issueNonce(request("/api/auth/nonce")).then((r) => jar.absorb(r));
    verifyIdTokenMock.mockRejectedValue(new Error("invalid signature"));

    const response = await signIn(request("/api/auth/google", { body: { credential: "forged" }, jar }));
    jar.absorb(response);

    expect(response.status).toBe(401);
    expect(jar.has("tabdump_login_nonce")).toBe(false);
  });

  it("rejects a cross-origin submission", async () => {
    const jar = new Jar();
    await issueNonce(request("/api/auth/nonce")).then((r) => jar.absorb(r));

    const response = await signIn(
      request("/api/auth/google", { body: { credential: "x" }, jar, origin: "https://evil.example" })
    );

    expect(response.status).toBe(403);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a form-style content type, which is what a cross-site form post would send", async () => {
    const jar = new Jar();
    await issueNonce(request("/api/auth/nonce")).then((r) => jar.absorb(r));

    const response = await signIn(
      request("/api/auth/google", {
        body: { credential: "x" },
        jar,
        origin: null,
        contentType: "application/x-www-form-urlencoded",
      })
    );

    expect(response.status).toBe(403);
  });

  it("never echoes the verifier's own message back to the browser", async () => {
    const jar = new Jar();
    await issueNonce(request("/api/auth/nonce")).then((r) => jar.absorb(r));
    verifyIdTokenMock.mockRejectedValue(new Error("Wrong recipient, payload audience != 1234-secret.apps.googleusercontent.com"));

    const response = await signIn(request("/api/auth/google", { body: { credential: "x" }, jar }));
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain("Wrong recipient");
    expect(JSON.stringify(body)).not.toContain("apps.googleusercontent.com");
  });

  it("refuses an unverified Google email", async () => {
    const jar = new Jar();
    const nonceResponse = await issueNonce(request("/api/auth/nonce"));
    jar.absorb(nonceResponse);
    const { nonce } = (await nonceResponse.json()) as { nonce: string };
    respondWithGoogleToken({ email_verified: false });

    const response = await signIn(request("/api/auth/google", { body: { credential: `token-for:${nonce}` }, jar }));

    expect(response.status).toBe(403);
    expect(await store.findUserByGoogleSub("115625890123456789012")).toBeNull();
  });

  it("reports itself unavailable, rather than erroring, when no client ID is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");

    expect((await issueNonce(request("/api/auth/nonce"))).status).toBe(503);
  });
});

describe("caching", () => {
  it("marks every auth response un-storable, signed in and signed out alike", async () => {
    const jar = new Jar();

    const signedOut = await me(request("/api/auth/me", { method: "GET" }));
    const nonce = await issueNonce(request("/api/auth/nonce"));
    const signedIn = await signInFlow(jar);
    const authed = await me(request("/api/auth/me", { method: "GET", jar }));
    const out = await logOut(request("/api/auth/logout", { jar }));

    for (const response of [signedOut, nonce, signedIn, authed, out]) {
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });
});

describe("/api/auth/me", () => {
  it("answers 200 with a signed-out shape when there is no session", async () => {
    const response = await me(request("/api/auth/me", { method: "GET" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false, user: null, configured: true });
  });

  it("reports the deployment unconfigured when no client ID is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");

    expect((await (await me(request("/api/auth/me", { method: "GET" }))).json()).configured).toBe(false);
  });

  it("clears a cookie that resolves to nothing, so a dead token isn't resent forever", async () => {
    const stale = new Request(`${ORIGIN}/api/auth/me`, {
      headers: { cookie: "tabdump_session=nolongervalid", host: HOST },
    });

    const response = await me(stale);

    expect(response.headers.getSetCookie().some((c) => c.startsWith("tabdump_session=") && c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("/api/auth/logout", () => {
  it("succeeds even with no session to end", async () => {
    expect((await logOut(request("/api/auth/logout"))).status).toBe(200);
  });

  it("rejects a cross-origin sign-out", async () => {
    const jar = new Jar();
    await signInFlow(jar);

    const response = await logOut(request("/api/auth/logout", { jar, origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    // And the session is still very much alive.
    expect((await (await me(request("/api/auth/me", { method: "GET", jar }))).json()).authenticated).toBe(true);
  });
});
