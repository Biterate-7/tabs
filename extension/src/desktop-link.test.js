import { describe, expect, it, vi } from "vitest";
import { LINK_KEY, LINK_REQUEST_KINDS, createDesktopLink, describePairState, formatCode } from "./desktop-link.js";

const TOKEN = "b".repeat(64);

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** A fake Hubble Desktop on port 41517: pairing, status and requests, per the routes in extension_link.rs. */
function desktop({ running = true, known = new Set([TOKEN]), pairing = "approved", answer = () => ({ ok: true, result: { projects: [] } }) } = {}) {
  const state = { running, known, pairing, calls: [] };
  const fetch = vi.fn(async (url, init = {}) => {
    const { pathname, port } = new URL(url);
    if (port !== "41517" || !state.running) throw new TypeError("Failed to fetch");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const token = init.headers?.authorization?.replace("Bearer ", "");
    state.calls.push({ pathname, body, token });
    if (pathname === "/v1/hello") return json(200, { app: "hubble-desktop", protocol: 1, ready: true, kinds: ["tabs", "conversation"], link: 1 });
    if (pathname === "/v1/pair") return json(201, { pairingId: "p1", code: "482913", expiresInMs: 120000 });
    if (pathname === "/v1/pair/p1/status") {
      return state.pairing === "approved" ? json(200, { status: "approved", token: TOKEN, linkId: "l1" }) : json(200, { status: state.pairing, code: "482913" });
    }
    if (pathname.startsWith("/v1/link/") && !state.known.has(token)) return json(401, { ok: false, reason: "not-paired" });
    if (pathname === "/v1/link/status") return json(200, { paired: true, ready: true, version: "0.3.0" });
    if (pathname === "/v1/link/forget") {
      state.known.delete(token);
      return json(200, { ok: true });
    }
    if (pathname === "/v1/link/request") return json(200, answer(body));
    return json(404, {});
  });
  return { state, fetch };
}

function memoryStorage(initial) {
  let value = initial;
  return {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    clear: async () => {
      value = undefined;
    },
    peek: () => value,
  };
}

const sleep = async () => {};

describe("desktop link", () => {
  it("pairs: shows the code, waits for the person, and keeps only what Hubble handed over", async () => {
    const { fetch } = desktop();
    const storage = memoryStorage(undefined);
    const link = createDesktopLink({ storage, fetch, sleep });
    const begun = await link.beginPairing("Chrome on Windows");
    expect(begun).toEqual({ pairingId: "p1", code: "482913", port: 41517 });
    expect(await link.awaitPairing(begun)).toEqual({ status: "approved" });
    expect(storage.peek()).toMatchObject({ token: TOKEN, linkId: "l1" });
    expect(await link.status()).toMatchObject({ running: true, paired: true });
  });

  it("reports a declined pairing and an expired one, keeping nothing", async () => {
    const declined = desktop({ pairing: "denied" });
    const storage = memoryStorage(undefined);
    const link = createDesktopLink({ storage, fetch: declined.fetch, sleep });
    expect(await link.awaitPairing({ pairingId: "p1", port: 41517 })).toEqual({ status: "denied" });
    const waiting = desktop({ pairing: "waiting" });
    let clock = 0;
    const slow = createDesktopLink({
      storage,
      fetch: waiting.fetch,
      sleep: async () => {
        clock += 1000;
      },
      now: () => clock,
    });
    expect(await slow.awaitPairing({ pairingId: "p1", port: 41517 }, { waitMs: 3000 })).toEqual({ status: "expired" });
    expect(storage.peek()).toBeUndefined();
  });

  it("can't pair with a Hubble Desktop that isn't running", async () => {
    const { fetch } = desktop({ running: false });
    const link = createDesktopLink({ storage: memoryStorage(undefined), fetch, sleep });
    expect(await link.beginPairing()).toEqual({ error: "desktop-not-running" });
  });

  it("sends a request with the token, and passes Hubble's answer back", async () => {
    const { fetch, state } = desktop({ answer: (body) => ({ ok: true, result: { echoed: body.kind } }) });
    const link = createDesktopLink({ storage: memoryStorage({ token: TOKEN, linkId: "l1" }), fetch, sleep });
    expect(await link.request("projects", {})).toEqual({ ok: true, result: { echoed: "projects" } });
    const sent = state.calls.find((call) => call.pathname === "/v1/link/request");
    expect(sent).toMatchObject({ token: TOKEN, body: { kind: "projects", args: {} } });
    expect(sent.body.requestId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  });

  it("forgets a token Hubble no longer knows (disconnected in Hubble's Settings)", async () => {
    const { fetch } = desktop({ known: new Set() });
    const storage = memoryStorage({ token: TOKEN, linkId: "l1" });
    const link = createDesktopLink({ storage, fetch, sleep });
    expect(await link.request("search", { query: "x" })).toEqual({ ok: false, error: "not-paired" });
    expect(storage.peek()).toBeUndefined();
  });

  it("says when it isn't paired or Hubble isn't running, and starts Hubble only when asked to", async () => {
    const unpaired = createDesktopLink({ storage: memoryStorage(undefined), fetch: desktop().fetch, sleep });
    expect(await unpaired.request("projects")).toEqual({ ok: false, error: "not-paired" });
    const closed = desktop({ running: false });
    const launch = vi.fn(async () => {
      closed.state.running = true;
      return true;
    });
    const link = createDesktopLink({ storage: memoryStorage({ token: TOKEN, linkId: "l1" }), fetch: closed.fetch, sleep, launch });
    expect(await link.request("projects")).toEqual({ ok: false, error: "desktop-not-running" });
    expect(launch).not.toHaveBeenCalled();
    expect(await link.request("projects", {}, { launch: true })).toMatchObject({ ok: true });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("refuses a kind Hubble Desktop doesn't answer, without sending anything", async () => {
    const { fetch, state } = desktop();
    const link = createDesktopLink({ storage: memoryStorage({ token: TOKEN, linkId: "l1" }), fetch, sleep });
    expect(await link.request("exec", {})).toEqual({ ok: false, error: "invalid" });
    expect(state.calls).toEqual([]);
  });

  it("disconnects on both sides", async () => {
    const { fetch, state } = desktop();
    const storage = memoryStorage({ token: TOKEN, linkId: "l1" });
    await createDesktopLink({ storage, fetch, sleep }).forget();
    expect(state.known.has(TOKEN)).toBe(false);
    expect(storage.peek()).toBeUndefined();
  });

  it("words each pairing state, with the code spaced as Hubble shows it", () => {
    expect(formatCode("482913")).toBe("482 913");
    expect(describePairState({ status: "waiting", code: "482913" }).text).toContain("482 913");
    expect(describePairState({ status: "failed", error: "desktop-not-running" }).text).toBe("Open Hubble Desktop first, then connect.");
    expect(describePairState(undefined)).toBeUndefined();
    expect(LINK_KEY).toBe("hubble_desktop_link");
    expect(LINK_REQUEST_KINDS).toContain("add-sources");
  });
});
