// Who context detection acts for: Hubble's server's answer about the browser's own session, checked against the
// page's claim. A fake /api/auth/me stands in for Hubble; nothing here trusts the page.
import { describe, expect, it, vi } from "vitest";
import { IDENTITY_CACHE_MS, createIdentityVerifier, ownerForAccount, readAccountClaim } from "./context-identity.js";

const HUBBLE = "http://localhost:3000";

function harness({ session = "account-a" } = {}) {
  const state = { session, status: 200, body: undefined, throws: false, now: 1_000_000 };
  const fetch = vi.fn(async (url, init) => {
    if (state.throws) throw new TypeError("Failed to fetch");
    return {
      ok: state.status >= 200 && state.status < 300,
      status: state.status,
      json: async () => state.body ?? (state.session ? { authenticated: true, user: { id: state.session } } : { authenticated: false, user: null }),
      url,
      init,
    };
  });
  const verifier = createIdentityVerifier({ fetch, hubbleOrigin: HUBBLE, now: () => state.now, subtle: globalThis.crypto.subtle });
  return { state, fetch, verifier };
}

describe("the page's claim", () => {
  it("is only a claim: shape-checked, never trusted", () => {
    expect(readAccountClaim(null)).toBeNull();
    expect(readAccountClaim("account-a")).toBe("account-a");
    for (const bad of [undefined, "", "a b", "x".repeat(201), 42, {}, "../etc"]) expect(readAccountClaim(bad)).toBeUndefined();
  });
});

describe("verifying against Hubble's own session", () => {
  it("asks /api/auth/me with the browser's cookies, not anything the page sends", async () => {
    const { fetch, verifier } = harness();
    await verifier.verify("account-a");
    expect(fetch).toHaveBeenCalledWith(`${HUBBLE}/api/auth/me`, expect.objectContaining({ credentials: "include", cache: "no-store" }));
  });

  it("acts for the account only when the server agrees, as a hash — never the raw id", async () => {
    const { verifier } = harness();
    const result = await verifier.verify("account-a");
    expect(result).toEqual({ ok: true, owner: await ownerForAccount("account-a") });
    expect(result.owner).toMatch(/^user:[0-9a-f]{64}$/);
    expect(result.owner).not.toContain("account-a");
    expect(await ownerForAccount("account-b")).not.toBe(result.owner);
  });

  it("refuses a claim for a different account than the signed-in session", async () => {
    const { verifier } = harness({ session: "account-a" });
    expect(await verifier.verify("account-b")).toEqual({ ok: false, error: "identity-mismatch" });
  });

  it("refuses a signed-out claim while signed in, and a signed-in claim while signed out", async () => {
    expect(await harness({ session: "account-a" }).verifier.verify(null)).toEqual({ ok: false, error: "identity-mismatch" });
    expect(await harness({ session: null }).verifier.verify("account-a")).toEqual({ ok: false, error: "identity-mismatch" });
    expect(await harness({ session: null }).verifier.verify(null)).toEqual({ ok: true, owner: "signed-out" });
  });

  it("refuses a missing or malformed claim without asking anything", async () => {
    const { fetch, verifier } = harness();
    for (const bad of [undefined, "", "bad id!"]) expect(await verifier.verify(bad)).toEqual({ ok: false, error: "identity-invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when Hubble can't be asked: offline, an error, not JSON, an odd answer", async () => {
    const offline = harness();
    offline.state.throws = true;
    expect(await offline.verifier.verify("account-a")).toEqual({ ok: false, error: "identity-unverified" });

    const failing = harness();
    failing.state.status = 503;
    expect(await failing.verifier.verify("account-a")).toEqual({ ok: false, error: "identity-unverified" });

    const garbled = harness();
    garbled.state.body = { hello: "world" };
    expect(await garbled.verifier.verify("account-a")).toEqual({ ok: false, error: "identity-unverified" });

    const oddId = harness();
    oddId.state.body = { authenticated: true, user: { id: "not an id!" } };
    expect(await oddId.verifier.verify("not an id!")).toEqual({ ok: false, error: "identity-invalid" });
    expect(await oddId.verifier.verify("account-a")).toEqual({ ok: false, error: "identity-unverified" });
  });
});

describe("switching accounts and stale answers", () => {
  it("a read may reuse a recent answer only for the same claim; a different claim asks again", async () => {
    const { state, fetch, verifier } = harness({ session: "account-a" });
    await verifier.verify("account-a");
    await verifier.verify("account-a");
    expect(fetch).toHaveBeenCalledTimes(1);
    // Signed in as B in another tab: B's page claims B, which doesn't match the remembered A — asked afresh.
    state.session = "account-b";
    expect(await verifier.verify("account-b")).toEqual({ ok: true, owner: await ownerForAccount("account-b") });
    expect(fetch).toHaveBeenCalledTimes(2);
    // A's stale page, still claiming A: refused now that the server says B.
    expect(await verifier.verify("account-a", { fresh: true })).toEqual({ ok: false, error: "identity-mismatch" });
  });

  it("writes always ask afresh, so a sign-out takes effect at once", async () => {
    const { state, fetch, verifier } = harness({ session: "account-a" });
    await verifier.verify("account-a");
    state.session = null;
    expect(await verifier.verify("account-a", { fresh: true })).toEqual({ ok: false, error: "identity-mismatch" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a remembered answer expires", async () => {
    const { state, fetch, verifier } = harness({ session: "account-a" });
    await verifier.verify("account-a");
    state.now += IDENTITY_CACHE_MS;
    state.session = null;
    expect(await verifier.verify("account-a")).toEqual({ ok: false, error: "identity-mismatch" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a failed check forgets what was remembered (nothing stale survives an outage)", async () => {
    const { state, verifier } = harness({ session: "account-a" });
    await verifier.verify("account-a");
    state.throws = true;
    expect(await verifier.verify("account-a", { fresh: true })).toEqual({ ok: false, error: "identity-unverified" });
    state.throws = false;
    state.session = "account-b";
    expect(await verifier.verify("account-a")).toEqual({ ok: false, error: "identity-mismatch" });
  });

  it("currentOwner says who the browser is signed in as now", async () => {
    const { state, verifier } = harness({ session: "account-a" });
    expect(await verifier.currentOwner()).toBe(await ownerForAccount("account-a"));
    state.session = null;
    expect(await verifier.currentOwner()).toBe("signed-out");
    state.throws = true;
    expect(await verifier.currentOwner()).toBeUndefined();
  });
});
