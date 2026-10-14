// The extension's half of Chrome → Hubble Desktop, against a fake bridge that
// answers the way src-tauri/src/import_bridge.rs does (its own tests cover
// the real one). No browser, no desktop app, no network.
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_BRIDGE_PORTS,
  DESKTOP_MAX_TABS,
  DesktopError,
  buildDesktopPayload,
  describeDesktopPhase,
  describeDesktopResult,
  findDesktop,
  readDesktopResult,
  sendToDesktop,
  waitForDesktop,
  waitForDesktopResult,
} from "./desktop.js";

function chromeTab(over) {
  return { id: 1, windowId: 1, index: 0, url: "https://example.com/", title: "Example", status: "complete", favIconUrl: "https://example.com/favicon.ico", pinned: false, active: false, ...over };
}

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/**
 * A stand-in for Hubble Desktop's bridge. `answer` decides what the person
 * does in Hubble: a result object, or undefined to keep them choosing.
 */
function fakeBridge({ port = DESKTOP_BRIDGE_PORTS[0], ready = true, answer = () => ({ status: "done", result: { added: 1, duplicates: 0, failed: 0, project: "Research" } }) } = {}) {
  const seen = [];
  const sessions = new Map();
  const fetch = vi.fn(async (url, init = {}) => {
    const { port: urlPort, pathname, hostname } = new URL(url);
    seen.push({ method: init.method, pathname, headers: init.headers ?? {}, body: init.body });
    if (hostname !== "127.0.0.1") throw new TypeError("Failed to fetch");
    if (Number(urlPort) !== port) throw new TypeError("Failed to fetch");
    if (pathname === "/v1/hello") return json(200, { app: "hubble-desktop", protocol: 1, ready, maxTabs: 200 });
    if (pathname === "/v1/sessions" && init.method === "POST") {
      const id = `s${sessions.size + 1}`;
      sessions.set(id, { token: `t-${id}`, payload: undefined });
      return json(201, { sessionId: id, token: `t-${id}`, expiresInMs: 30000 });
    }
    const match = pathname.match(/^\/v1\/sessions\/([^/]+)(\/import)?$/);
    const session = match && sessions.get(match[1]);
    if (!session) return json(404, { ok: false, reason: "unknown-session" });
    if (init.headers?.Authorization !== `Bearer ${session.token}`) return json(401, { ok: false, reason: "unauthorized" });
    if (match[2]) {
      const payload = JSON.parse(init.body);
      if (payload.version !== 1 || !Array.isArray(payload.tabs) || payload.tabs.length === 0) return json(400, { ok: false, reason: "invalid-payload" });
      session.payload = payload;
      return json(202, { status: "waiting", requestId: payload.requestId, accepted: payload.tabs.length, rejected: 0 });
    }
    const result = answer(session.payload);
    if (!result) return json(200, { status: "waiting", requestId: session.payload?.requestId });
    sessions.delete(match[1]);
    return json(200, { ...result, result: { requestId: session.payload.requestId, received: session.payload.tabs.length, ...result.result } });
  });
  return { fetch, seen, sessions };
}

const noSleep = () => Promise.resolve();

describe("buildDesktopPayload", () => {
  it("sends one tab as the import pipeline takes it, and nothing Chrome-only", () => {
    const { payload, skippedRestricted, overLimit } = buildDesktopPayload([chromeTab({ id: 7, windowId: 3, pinned: true, active: true })], "req-12345678");
    expect(payload).toEqual({
      version: 1,
      requestId: "req-12345678",
      source: "chrome-extension",
      tabs: [{ url: "https://example.com/", title: "Example", favicon: "https://example.com/favicon.ico" }],
    });
    expect(skippedRestricted).toBe(0);
    expect(overLimit).toBe(0);
  });

  it("keeps several windows' tabs in window and tab-strip order", () => {
    const tabs = [
      chromeTab({ id: 4, windowId: 2, index: 1, url: "https://d.example/" }),
      chromeTab({ id: 1, windowId: 1, index: 0, url: "https://a.example/" }),
      chromeTab({ id: 3, windowId: 2, index: 0, url: "https://c.example/" }),
      chromeTab({ id: 2, windowId: 1, index: 1, url: "https://b.example/" }),
    ];
    expect(buildDesktopPayload(tabs).payload.tabs.map((tab) => tab.url)).toEqual(["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"]);
  });

  it("skips Chrome's own pages and data-URL favicons, and leaves out a title Chrome hasn't loaded yet", () => {
    const { payload, skippedRestricted } = buildDesktopPayload([
      chromeTab({ id: 1, url: "chrome://settings" }),
      chromeTab({ id: 2, url: "https://a.example/", favIconUrl: "data:image/png;base64,AAAA" }),
      chromeTab({ id: 3, url: "https://b.example/", status: "loading", title: "b.example/" }),
    ]);
    expect(skippedRestricted).toBe(1);
    expect(payload.tabs).toEqual([{ url: "https://a.example/", title: "Example" }, { url: "https://b.example/", favicon: "https://example.com/favicon.ico" }]);
  });

  it("caps a batch at the pipeline's limit and counts what didn't fit", () => {
    const tabs = Array.from({ length: DESKTOP_MAX_TABS + 15 }, (_, i) => chromeTab({ id: i + 1, index: i, url: `https://example.com/${i}` }));
    const { payload, overLimit } = buildDesktopPayload(tabs);
    expect(payload.tabs).toHaveLength(DESKTOP_MAX_TABS);
    expect(overLimit).toBe(15);
  });

  it("gives every batch its own request id", () => {
    expect(buildDesktopPayload([chromeTab()]).payload.requestId).not.toBe(buildDesktopPayload([chromeTab()]).payload.requestId);
  });
});

describe("finding Hubble Desktop", () => {
  it("finds it on whichever bridge port it took", async () => {
    const bridge = fakeBridge({ port: DESKTOP_BRIDGE_PORTS[2], ready: false });
    await expect(findDesktop({ fetch: bridge.fetch })).resolves.toEqual({ port: DESKTOP_BRIDGE_PORTS[2], ready: false });
    // Only loopback is ever asked.
    expect(bridge.fetch.mock.calls.every(([url]) => url.startsWith("http://127.0.0.1:"))).toBe(true);
  });

  it("is undefined when nothing is listening", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(findDesktop({ fetch })).resolves.toBeUndefined();
  });

  it("ignores another program answering on a bridge port", async () => {
    const fetch = vi.fn(async () => json(200, { hello: "I am a different app" }));
    await expect(findDesktop({ fetch })).resolves.toBeUndefined();
  });

  it("gives up on a port that never answers instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
      const found = findDesktop({ fetch, timeoutMs: 800 });
      await vi.advanceTimersByTimeAsync(801);
      await expect(found).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for Hubble to start after it was opened, then stops asking", async () => {
    const bridge = fakeBridge();
    let calls = 0;
    const starting = vi.fn(async (url, init) => (++calls <= 6 ? Promise.reject(new TypeError("Failed to fetch")) : bridge.fetch(url, init)));
    const onTick = vi.fn();
    await expect(waitForDesktop({ fetch: starting, sleep: noSleep, onTick })).resolves.toEqual({ port: DESKTOP_BRIDGE_PORTS[0], ready: true });
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("stops waiting when Hubble never starts (not installed)", async () => {
    let clock = 0;
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const sleep = async (ms) => {
      clock += ms;
    };
    await expect(waitForDesktop({ fetch, sleep, now: () => clock, waitMs: 3000, pollMs: 500 })).resolves.toBeUndefined();
    expect(clock).toBe(3000);
  });
});

describe("sending to Hubble Desktop", () => {
  it("opens a session, sends the batch with its token, and collects the person's answer", async () => {
    const bridge = fakeBridge({ answer: () => ({ status: "done", result: { success: true, added: 9, duplicates: 3, failed: 0, project: "Research" } }) });
    const { payload } = buildDesktopPayload([chromeTab({ id: 1 }), chromeTab({ id: 2, url: "https://example.org/" })], "req-12345678");
    const session = await sendToDesktop({ port: DESKTOP_BRIDGE_PORTS[0], payload, fetch: bridge.fetch });
    expect(session).toMatchObject({ sessionId: "s1", token: "t-s1", requestId: "req-12345678", accepted: 2 });
    const sent = bridge.seen.find((call) => call.pathname.endsWith("/import"));
    expect(sent.headers.Authorization).toBe("Bearer t-s1");
    expect(JSON.parse(sent.body)).toEqual(payload);

    const result = await waitForDesktopResult({ session, fetch: bridge.fetch, sleep: noSleep });
    expect(result).toEqual({ status: "done", requestId: "req-12345678", success: true, received: 2, added: 9, duplicates: 3, failed: 0, project: "Research" });
  });

  it("keeps waiting while the person is choosing", async () => {
    let polls = 0;
    const bridge = fakeBridge({ answer: () => (++polls < 4 ? undefined : { status: "cancelled", result: {} }) });
    const { payload } = buildDesktopPayload([chromeTab()]);
    const session = await sendToDesktop({ port: DESKTOP_BRIDGE_PORTS[0], payload, fetch: bridge.fetch });
    const onTick = vi.fn();
    await expect(waitForDesktopResult({ session, fetch: bridge.fetch, sleep: noSleep, onTick })).resolves.toMatchObject({ status: "cancelled" });
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("stops waiting after its deadline and calls it expired", async () => {
    let clock = 0;
    const bridge = fakeBridge({ answer: () => undefined });
    const { payload } = buildDesktopPayload([chromeTab()]);
    const session = await sendToDesktop({ port: DESKTOP_BRIDGE_PORTS[0], payload, fetch: bridge.fetch });
    const sleep = async (ms) => {
      clock += ms;
    };
    await expect(waitForDesktopResult({ session, fetch: bridge.fetch, sleep, now: () => clock, timeoutMs: 2000, pollMs: 500 })).resolves.toMatchObject({ status: "expired", requestId: payload.requestId });
  });

  it("reports a malformed batch the bridge refused as invalid", async () => {
    const bridge = fakeBridge();
    const error = await sendToDesktop({ port: DESKTOP_BRIDGE_PORTS[0], payload: { version: 1, requestId: "req-12345678", source: "chrome-extension", tabs: [] }, fetch: bridge.fetch }).catch((err) => err);
    expect(error).toBeInstanceOf(DesktopError);
    expect(error.reason).toBe("invalid-payload");
  });

  it("reports a bridge that stopped answering as not responding", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const error = await sendToDesktop({ port: DESKTOP_BRIDGE_PORTS[0], payload: buildDesktopPayload([chromeTab()]).payload, fetch }).catch((err) => err);
    expect(error.reason).toBe("desktop-not-responding");
  });

  it("reports Hubble quitting mid-wait after a few missed polls, not the first", async () => {
    const bridge = fakeBridge({ answer: () => undefined });
    const { payload } = buildDesktopPayload([chromeTab()]);
    const session = await sendToDesktop({ port: DESKTOP_BRIDGE_PORTS[0], payload, fetch: bridge.fetch });
    let polls = 0;
    const flaky = vi.fn(async (url, init) => {
      polls += 1;
      if (polls === 1 || polls >= 3) throw new TypeError("Failed to fetch");
      return bridge.fetch(url, init);
    });
    const error = await waitForDesktopResult({ session, fetch: flaky, sleep: noSleep }).catch((err) => err);
    expect(error.reason).toBe("desktop-not-responding");
    expect(polls).toBe(5);
  });

  it("reports a lost session (Hubble restarted) distinctly", async () => {
    const bridge = fakeBridge({ answer: () => undefined });
    const session = await sendToDesktop({ port: DESKTOP_BRIDGE_PORTS[0], payload: buildDesktopPayload([chromeTab()]).payload, fetch: bridge.fetch });
    bridge.sessions.clear();
    const error = await waitForDesktopResult({ session, fetch: bridge.fetch, sleep: noSleep }).catch((err) => err);
    expect(error.reason).toBe("desktop-session-lost");
  });

  it("re-checks the bridge's answer rather than trusting its shape", () => {
    expect(readDesktopResult({ status: "rm -rf", result: {} })).toBeUndefined();
    expect(readDesktopResult({ status: "done", result: { added: -4, duplicates: "3", project: "x".repeat(500) } }, "req-1")).toMatchObject({
      requestId: "req-1",
      added: 0,
      duplicates: 0,
      project: "x".repeat(120),
    });
  });
});

describe("what the person is told", () => {
  it("names the project and what was already there", () => {
    expect(describeDesktopResult({ status: "done", project: "Research", added: 9, duplicates: 3, failed: 0 })).toEqual({ tone: "done", title: "Added 9 sources to Research", detail: "3 already there" });
    expect(describeDesktopResult({ status: "done", project: "Research", added: 1, duplicates: 0, failed: 0 })).toEqual({ tone: "done", title: "Added to Research", detail: undefined });
    expect(describeDesktopResult({ status: "done", project: "Research", added: 0, duplicates: 2, failed: 0 })).toMatchObject({ tone: "same", title: "Already in Research" });
  });

  it("says when only some were added", () => {
    expect(describeDesktopResult({ status: "done", project: "Research", added: 8, duplicates: 0, failed: 2 })).toEqual({ tone: "done", title: "8 of 10 added to Research", detail: "2 couldn't be added" });
    // Tabs over the batch limit count as not added.
    expect(describeDesktopResult({ status: "done", project: "Research", added: 200, duplicates: 0, failed: 0, overLimit: 15 })).toMatchObject({ title: "200 of 215 added to Research" });
  });

  it("offers Hubble Web when Hubble Desktop can't be reached, and never fails silently", () => {
    expect(describeDesktopResult({ reason: "desktop-not-found" })).toEqual({ tone: "error", title: "Hubble Desktop wasn't found", detail: "Open Hubble Web instead?", actions: ["web", "retry"] });
    expect(describeDesktopResult({ reason: "desktop-not-responding" })).toMatchObject({ title: "Hubble Desktop isn't responding", actions: ["retry", "web"] });
    expect(describeDesktopResult({ reason: "something-new" })).toMatchObject({ tone: "error", actions: ["retry", "web"] });
    expect(describeDesktopResult({ reason: "invalid-payload" })).toEqual({ tone: "error", title: "Couldn't import these tabs", detail: "Please try again.", actions: ["retry"] });
  });

  it("treats cancelling in Hubble as nothing having happened", () => {
    expect(describeDesktopResult({ status: "cancelled" })).toEqual({ tone: "same", title: "Nothing added", detail: "Cancelled in Hubble Desktop." });
  });

  it("says what is happening while it happens", () => {
    expect(describeDesktopPhase("connecting", 12)).toMatchObject({ tone: "working", title: "Connecting to Hubble Desktop…" });
    expect(describeDesktopPhase("launching", 12)).toMatchObject({ title: "Opening Hubble Desktop…" });
    expect(describeDesktopPhase("waiting", 12)).toEqual({ tone: "working", title: "Add 12 tabs to Hubble", detail: "Choose a project in Hubble Desktop." });
  });
});
