// "Add to Hubble Desktop", whole runs: Hubble open, closed, not installed, not
// responding, cancelled, retried — with every browser call injected.
import { describe, expect, it, vi } from "vitest";
import { createDesktopAdd } from "./desktop-add.js";
import { DESKTOP_BRIDGE_PORTS } from "./desktop.js";

function chromeTab(id, url = `https://example.com/${id}`) {
  return { id, windowId: 1, index: id, url, title: `Page ${id}`, status: "complete" };
}

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** Hubble Desktop as the extension sees it. `running` can be flipped by `launch`. */
function desktop({ running = true, answer = (payload) => ({ status: "done", result: { added: payload.tabs.length, duplicates: 0, failed: 0, project: "Research" } }) } = {}) {
  const state = { running, sent: [] };
  let session;
  state.fetch = vi.fn(async (url, init = {}) => {
    const { pathname, port } = new URL(url);
    if (!state.running || Number(port) !== DESKTOP_BRIDGE_PORTS[0]) throw new TypeError("Failed to fetch");
    if (pathname === "/v1/hello") return json(200, { app: "hubble-desktop", protocol: 1, ready: true });
    if (pathname === "/v1/sessions") return json(201, { sessionId: "s1", token: "tok" });
    if (pathname.endsWith("/import")) {
      session = JSON.parse(init.body);
      state.sent.push(session);
      return json(202, { status: "waiting", accepted: session.tabs.length, rejected: 0 });
    }
    const result = answer(session);
    return json(200, result ? { ...result, result: { requestId: session.requestId, received: session.tabs.length, ...result.result } } : { status: "waiting" });
  });
  return state;
}

function harness({ tabs = [chromeTab(1)], hubble = desktop(), seen = false, launchStarts = true } = {}) {
  const shown = [];
  let clock = 0;
  const deps = {
    collectTabs: vi.fn(async () => tabs),
    launch: vi.fn(async () => {
      if (launchStarts) hubble.running = true;
      return true;
    }),
    show: vi.fn(async (toast) => {
      shown.push(toast);
    }),
    markSeen: vi.fn(async () => {}),
    wasSeen: vi.fn(async () => seen),
    fetch: hubble.fetch,
    // Time passes instantly, but each wait still yields, as a real one does.
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    now: () => clock,
  };
  return { run: createDesktopAdd(deps), deps, shown, hubble };
}

describe("Add to Hubble Desktop", () => {
  it("with Hubble open: sends the tabs, waits for the person's choice, and names the project", async () => {
    const { run, deps, shown, hubble } = harness({ tabs: [chromeTab(1), chromeTab(2), chromeTab(3)] });
    const outcome = await run({ scope: "window", windowId: 1 });
    expect(deps.launch).not.toHaveBeenCalled();
    expect(hubble.sent[0].tabs.map((tab) => tab.url)).toEqual(["https://example.com/1", "https://example.com/2", "https://example.com/3"]);
    expect(shown.map((toast) => toast.title)).toEqual(["Connecting to Hubble Desktop…", "Add 3 tabs to Hubble", "Added 3 sources to Research"]);
    expect(outcome.toast).toMatchObject({ tone: "done", final: true });
    expect(deps.markSeen).toHaveBeenCalled();
  });

  it("with Hubble closed: opens it, waits for it to start, then sends", async () => {
    const hubble = desktop({ running: false });
    const { run, deps, shown } = harness({ hubble });
    const outcome = await run({ scope: "current" });
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(shown.some((toast) => toast.title === "Opening Hubble Desktop…")).toBe(true);
    expect(outcome).toMatchObject({ status: "done", added: 1 });
  });

  it("with Hubble not installed: stops waiting and offers Hubble Web", async () => {
    const hubble = desktop({ running: false });
    const { run, shown } = harness({ hubble, launchStarts: false });
    const outcome = await run({ scope: "current" });
    expect(outcome.reason).toBe("desktop-not-found");
    expect(shown.at(-1)).toMatchObject({ title: "Hubble Desktop wasn't found", detail: "Open Hubble Web instead?", actions: ["web", "retry"] });
    expect(hubble.sent).toHaveLength(0);
  });

  it("with Hubble used before but not starting: says it isn't responding, with Retry", async () => {
    const { run, shown } = harness({ hubble: desktop({ running: false }), seen: true, launchStarts: false });
    await run({ scope: "current" });
    expect(shown.at(-1)).toMatchObject({ title: "Hubble Desktop isn't responding", actions: ["retry", "web"] });
  });

  it("retrying after Hubble has started works", async () => {
    const hubble = desktop({ running: false });
    const { run } = harness({ hubble, launchStarts: false });
    expect((await run({ scope: "current" })).reason).toBe("desktop-not-found");
    hubble.running = true;
    expect(await run({ scope: "current" })).toMatchObject({ status: "done" });
  });

  it("when the person cancels in Hubble: nothing is added and the extension goes back to normal", async () => {
    const { run, shown } = harness({ hubble: desktop({ answer: () => ({ status: "cancelled", result: {} }) }) });
    const outcome = await run({ scope: "current" });
    expect(outcome.status).toBe("cancelled");
    expect(shown.at(-1)).toMatchObject({ tone: "same", title: "Nothing added" });
    // Not stuck: the next add runs.
    expect((await run({ scope: "current" })).reason).not.toBe("already-running");
  });

  it("reports duplicates the way Hubble counted them", async () => {
    const hubble = desktop({ answer: () => ({ status: "done", result: { added: 9, duplicates: 3, failed: 0, project: "Research" } }) });
    const { run, shown } = harness({ hubble, tabs: Array.from({ length: 12 }, (_, i) => chromeTab(i + 1)) });
    await run({ scope: "window" });
    expect(shown.at(-1)).toMatchObject({ title: "Added 9 sources to Research", detail: "3 already there" });
  });

  it("refuses Chrome's own pages without bothering Hubble", async () => {
    const { run, deps, shown } = harness({ tabs: [chromeTab(1, "chrome://settings")] });
    const outcome = await run({ scope: "current" });
    expect(outcome.reason).toBe("no-importable-tabs");
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(shown.at(-1)).toMatchObject({ title: "Nothing to add" });
  });

  it("when Hubble disappears mid-send: says so instead of failing silently", async () => {
    const hubble = desktop();
    const fetch = hubble.fetch;
    hubble.fetch = vi.fn(async (url, init) => {
      if (new URL(url).pathname.endsWith("/import")) throw new TypeError("Failed to fetch");
      return fetch(url, init);
    });
    const { run, shown } = harness({ hubble });
    const outcome = await run({ scope: "current" });
    expect(outcome.reason).toBe("desktop-not-responding");
    expect(shown.at(-1).actions).toEqual(["retry", "web"]);
  });

  it("runs one add at a time", async () => {
    let release;
    const hubble = desktop({ answer: () => (release ? { status: "done", result: { added: 1, project: "Research" } } : undefined) });
    const { run } = harness({ hubble });
    const first = run({ scope: "current" });
    await vi.waitFor(() => expect(hubble.sent).toHaveLength(1));
    expect((await run({ scope: "current" })).reason).toBe("already-running");
    release = true;
    await expect(first).resolves.toMatchObject({ status: "done" });
  });
});
