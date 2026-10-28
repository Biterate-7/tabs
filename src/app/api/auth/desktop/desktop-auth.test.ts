import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAuthStoreForTests, MemoryAuthStore } from "@/lib/auth/store";
import { __clearRateLimitsForTests } from "@/lib/ai/server/rate-limit";
import { createSession } from "@/lib/auth/session";
import { DEVICE_PAIRING_TTL_MS } from "@/lib/auth/device";
import { __setSyncServiceForTests } from "@/lib/sync/store";
import type { SyncService } from "@/lib/sync/service";
import { POST as authorize } from "./authorize/route";
import { POST as exchange } from "./token/route";
import { POST as logout } from "./logout/route";
import { GET as listDevices, POST as revoke } from "./devices/route";
import { GET as me } from "../me/route";
import { GET as listWorkspaces } from "../../sync/workspaces/route";

/**
 * Hubble Desktop's sign-in (src/lib/auth/device.ts), end to end through the
 * real route handlers against the memory store. What each test pins is a
 * security property, named in its title.
 */

const ORIGIN = "https://hubble.example";
const T0 = Date.now();

let store: MemoryAuthStore;
let users: { a: string; b: string };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function webCookie(userId: string): Promise<string> {
  const { token } = await createSession(store, userId);
  return `tabdump_session=${token}`;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "hubble.example", "x-forwarded-proto": "https", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { host: "hubble.example", "x-forwarded-proto": "https", ...headers } });
}

/** The whole flow: a web user authorizes, the desktop redeems. */
async function pairDesktop(userId: string, label = "Hubble Desktop on QA-PC") {
  const { verifier, challenge } = pkce();
  const authorized = await authorize(post("/api/auth/desktop/authorize", { challenge, label }, { cookie: await webCookie(userId), origin: ORIGIN }));
  expect(authorized.status).toBe(200);
  const { code } = (await authorized.json()) as { code: string };
  const redeemed = await exchange(post("/api/auth/desktop/token", { code, verifier }));
  expect(redeemed.status).toBe(200);
  return { code, verifier, ...((await redeemed.json()) as { token: string; expiresAt: number; user: { id: string; email: string } }) };
}

beforeEach(async () => {
  __clearRateLimitsForTests();
  store = new MemoryAuthStore();
  __setAuthStoreForTests(store);
  const a = await store.createUser({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", googleSub: "sub-a", email: "a@example.com", name: "A", avatarUrl: null });
  const b = await store.createUser({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", googleSub: "sub-b", email: "b@example.com", name: "B", avatarUrl: null });
  users = { a: a.id, b: b.id };
});

afterEach(() => {
  __setAuthStoreForTests(undefined);
  __setSyncServiceForTests(undefined);
});

describe("pairing", () => {
  it("signs the desktop in as the web user who authorized it, and never as anyone the request names", async () => {
    const paired = await pairDesktop(users.a);
    expect(paired.token).toMatch(/^hbd_[A-Za-z0-9_-]{43}$/);
    expect(paired.user).toMatchObject({ id: users.a, email: "a@example.com" });

    const who = await me(get("/api/auth/me", { authorization: `Bearer ${paired.token}` }));
    expect(await who.json()).toMatchObject({ authenticated: true, user: { id: users.a } });
  });

  it("stores only hashes", async () => {
    const paired = await pairDesktop(users.a);
    const [device] = await store.listDeviceSessions(users.a);
    expect(JSON.stringify(device)).not.toContain(paired.token);
    expect(JSON.stringify(device)).not.toContain(paired.code);
    expect(device!.label).toBe("Hubble Desktop on QA-PC");
  });

  it("refuses to authorize without a web session, cross-site, or with a device token", async () => {
    const { challenge } = pkce();
    expect((await authorize(post("/api/auth/desktop/authorize", { challenge }, { origin: ORIGIN }))).status).toBe(401);
    expect(
      (await authorize(post("/api/auth/desktop/authorize", { challenge }, { cookie: await webCookie(users.a), origin: "https://evil.example" }))).status
    ).toBe(403);
    const paired = await pairDesktop(users.a);
    // A desktop can't mint more desktops.
    expect((await authorize(post("/api/auth/desktop/authorize", { challenge }, { authorization: `Bearer ${paired.token}`, origin: ORIGIN }))).status).toBe(403);
  });

  it("requires a real S256 challenge", async () => {
    const cookie = await webCookie(users.a);
    for (const challenge of [undefined, "", "short", "x".repeat(44), "plain-verifier-not-a-hash-but-43-chars-long!"]) {
      expect((await authorize(post("/api/auth/desktop/authorize", { challenge }, { cookie, origin: ORIGIN }))).status, String(challenge)).toBe(400);
    }
  });

  it("burns a code presented with the wrong verifier, so it can't be guessed at", async () => {
    const { challenge, verifier } = pkce();
    const res = await authorize(post("/api/auth/desktop/authorize", { challenge }, { cookie: await webCookie(users.a), origin: ORIGIN }));
    const { code } = (await res.json()) as { code: string };
    expect((await exchange(post("/api/auth/desktop/token", { code, verifier: pkce().verifier }))).status).toBe(401);
    // Even the right verifier is too late now.
    expect((await exchange(post("/api/auth/desktop/token", { code, verifier }))).status).toBe(401);
  });

  it("is single-use, including two redemptions racing", async () => {
    const { challenge, verifier } = pkce();
    const res = await authorize(post("/api/auth/desktop/authorize", { challenge }, { cookie: await webCookie(users.a), origin: ORIGIN }));
    const { code } = (await res.json()) as { code: string };
    const [first, second] = await Promise.all([
      exchange(post("/api/auth/desktop/token", { code, verifier })),
      exchange(post("/api/auth/desktop/token", { code, verifier })),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 401]);
    expect(await store.listDeviceSessions(users.a)).toHaveLength(1);
  });

  it("expires codes", async () => {
    const { challenge, verifier } = pkce();
    const res = await authorize(post("/api/auth/desktop/authorize", { challenge }, { cookie: await webCookie(users.a), origin: ORIGIN }));
    const { code } = (await res.json()) as { code: string };
    const pairing = (await store.findDevicePairingByCodeHash(createHash("sha256").update(code).digest("hex")))!;
    await store.createDevicePairing({ ...pairing, expiresAt: T0 - DEVICE_PAIRING_TTL_MS });
    expect((await exchange(post("/api/auth/desktop/token", { code, verifier }))).status).toBe(401);
  });

  it("rejects malformed redemption bodies before touching the store", async () => {
    for (const body of [{}, { code: "hbc_x", verifier: "y" }, { code: 1, verifier: pkce().verifier }, { code: `hbd_${"a".repeat(43)}`, verifier: pkce().verifier }]) {
      expect((await exchange(post("/api/auth/desktop/token", body))).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the device token", () => {
  it("never falls back to the cookie when a bearer header is present", async () => {
    const cookie = await webCookie(users.a);
    const res = await me(get("/api/auth/me", { cookie, authorization: "Bearer hbd_forged" }));
    expect(await res.json()).toMatchObject({ authenticated: false });
  });

  it("is not a web session, and a web session token is not a device token", async () => {
    const { token } = await createSession(store, users.a);
    const res = await me(get("/api/auth/me", { authorization: `Bearer hbd_${token}` }));
    expect(await res.json()).toMatchObject({ authenticated: false });
  });

  it("authenticates account APIs such as sync, scoped to its own user", async () => {
    const calls: string[] = [];
    __setSyncServiceForTests({
      listWorkspaces: async (userId: string) => {
        calls.push(userId);
        return [];
      },
    } as unknown as SyncService);
    const paired = await pairDesktop(users.b);
    const res = await listWorkspaces(get("/api/sync/workspaces", { authorization: `Bearer ${paired.token}` }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([users.b]);
  });

  it("signs out on its own: the website stays signed in", async () => {
    const cookie = await webCookie(users.a);
    const paired = await pairDesktop(users.a);
    expect((await logout(post("/api/auth/desktop/logout", {}, { authorization: `Bearer ${paired.token}` }))).status).toBe(200);
    expect(await (await me(get("/api/auth/me", { authorization: `Bearer ${paired.token}` }))).json()).toMatchObject({ authenticated: false });
    expect(await (await me(get("/api/auth/me", { cookie }))).json()).toMatchObject({ authenticated: true });
  });
});

describe("connected desktops on the web", () => {
  it("lists only the signed-in user's desktops, and revokes one", async () => {
    const mine = await pairDesktop(users.a, "Laptop");
    await pairDesktop(users.b, "Someone else's");
    const cookie = await webCookie(users.a);
    const list = (await (await listDevices(get("/api/auth/desktop/devices", { cookie }))).json()) as { devices: { id: string; label: string }[] };
    expect(list.devices.map((d) => d.label)).toEqual(["Laptop"]);
    expect(JSON.stringify(list)).not.toMatch(/hash|hbd_/i);

    const revoked = await revoke(post("/api/auth/desktop/devices", { revoke: list.devices[0]!.id }, { cookie, origin: ORIGIN }));
    expect(revoked.status).toBe(200);
    expect(await (await me(get("/api/auth/me", { authorization: `Bearer ${mine.token}` }))).json()).toMatchObject({ authenticated: false });
  });

  it("answers 404 for another account's desktop, and refuses a device token", async () => {
    const theirs = await pairDesktop(users.b);
    const [device] = await store.listDeviceSessions(users.b);
    const cookie = await webCookie(users.a);
    expect((await revoke(post("/api/auth/desktop/devices", { revoke: device!.id }, { cookie, origin: ORIGIN }))).status).toBe(404);
    expect((await listDevices(get("/api/auth/desktop/devices", { authorization: `Bearer ${theirs.token}` }))).status).toBe(403);
    expect(await store.listDeviceSessions(users.b)).toHaveLength(1);
  });
});
