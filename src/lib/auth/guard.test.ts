import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "./config";
import { optionalUser, requireUser } from "./guard";
import { createSession } from "./session";
import { MemoryAuthStore } from "./store/memory";
import { __setAuthStoreForTests } from "./store";

let store: MemoryAuthStore;

beforeEach(async () => {
  store = new MemoryAuthStore();
  __setAuthStoreForTests(store);
  await store.createUser({
    id: "user-1",
    googleSub: "sub-1",
    email: "ada@example.com",
    name: "Ada",
    avatarUrl: null,
  });
});

afterEach(() => {
  __setAuthStoreForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function requestWith(token: string | null): Request {
  return new Request("https://tabdump.example/api/protected", {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });
}

describe("requireUser", () => {
  it("lets an authenticated request through with its user attached", async () => {
    const { token } = await createSession(store, "user-1");

    const result = await requireUser(requestWith(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe("user-1");
    expect(result.auth.session.userId).toBe("user-1");
  });

  it("hands back a 401 for a request with no session", async () => {
    const result = await requireUser(requestWith(null));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect((await result.response.json()).error).toBe("Sign in to continue.");
  });

  it("hands back a 401 for a token that matches nothing", async () => {
    const result = await requireUser(requestWith("not-a-real-token"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });

  it("says nothing about why a session failed", async () => {
    // An expired session and a forged one must be indistinguishable from
    // outside — otherwise the response is an oracle for guessing tokens.
    const { token, session } = await createSession(store, "user-1");
    await store.touchSession(session.id, Date.now(), Date.now() - 1);

    const expired = await requireUser(requestWith(token));
    const forged = await requireUser(requestWith("aaaaaaaaaaaaaaaa"));

    expect(expired.ok || forged.ok).toBe(false);
    if (expired.ok || forged.ok) return;
    expect(expired.response.status).toBe(forged.response.status);
    expect(await expired.response.json()).toEqual(await forged.response.json());
  });

  it("answers 503, not 401, when the deployment has no account store at all", async () => {
    // Not the caller's fault and not fixable by signing in.
    __setAuthStoreForTests(undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { token } = { token: "anything" };
    const result = await requireUser(requestWith(token));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
  });

  it("never leaks the configuration detail into the response", async () => {
    // The detail names environment variables and is for operators only —
    // getAuthStore() logs it once per process, and nothing echoes it back.
    __setAuthStoreForTests(undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requireUser(requestWith("anything"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = JSON.stringify(await result.response.json());
    expect(body).not.toContain("POSTGRES_URL");
    expect(body).not.toContain("DATABASE_URL");
    expect(body).not.toContain("schema.sql");
    expect(body).toBe(JSON.stringify({ error: "Accounts aren't available on this deployment yet." }));
  });
});

describe("optionalUser", () => {
  it("resolves the user when there is one", async () => {
    const { token } = await createSession(store, "user-1");
    expect((await optionalUser(requestWith(token)))?.id).toBe("user-1");
  });

  it("resolves null — never an error — when there isn't", async () => {
    expect(await optionalUser(requestWith(null))).toBeNull();
    expect(await optionalUser(requestWith("garbage"))).toBeNull();
  });
});
