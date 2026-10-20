// "Add to Hubble Desktop", whole runs: Hubble open, closed, not installed, not
// responding, cancelled, retried — with every browser call injected.
import { describe, expect, it, vi } from "vitest";
import { createDesktopAdd, createDesktopSave } from "./desktop-add.js";
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

/** Hubble Desktop for a conversation: open or not, new enough or not, and what the person does there. */
function desktopForSave({ running = true, kinds = ["tabs", "conversation"], answer = (payload) => ({ status: "done", result: { kind: "conversation", success: true, saved: "added", turns: payload.conversation.turns.length, project: "Biology" } }) } = {}) {
  const state = { running, sent: [] };
  let session;
  state.fetch = vi.fn(async (url, init = {}) => {
    const { pathname, port } = new URL(url);
    if (!state.running || Number(port) !== DESKTOP_BRIDGE_PORTS[0]) throw new TypeError("Failed to fetch");
    if (pathname === "/v1/hello") return json(200, { app: "hubble-desktop", protocol: 1, ready: true, ...(kinds ? { kinds } : {}) });
    if (pathname === "/v1/sessions") return json(201, { sessionId: "s1", token: "tok" });
    if (pathname.endsWith("/import")) {
      session = JSON.parse(init.body);
      state.sent.push(session);
      return json(202, { status: "waiting", kind: "conversation", turns: session.conversation.turns.length });
    }
    const result = answer(session);
    return json(200, result ? { ...result, result: { requestId: session.requestId, ...result.result } } : { status: "waiting" });
  });
  return state;
}

function saveHarness(hubble = desktopForSave()) {
  const shown = [];
  let clock = 0;
  const save = createDesktopSave({
    show: vi.fn(async (toast) => {
      shown.push(toast);
    }),
    fetch: hubble.fetch,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    now: () => clock,
  });
  return { save, shown, hubble };
}

const conversation = {
  provider: "claude",
  url: "https://claude.ai/chat/0a1b2c3d-4e5f-6789-abcd-ef0123456789",
  title: "Essay outline",
  turns: [
    { role: "user", text: "Outline my essay" },
    { role: "assistant", text: "1. Intro" },
  ],
};

describe("Save this conversation to Hubble Desktop", () => {
  it("with Hubble Desktop open: sends it, waits for the person's choice, and says where it went", async () => {
    const { save, shown, hubble } = saveHarness();
    const outcome = await save(conversation);
    expect(hubble.sent[0]).toMatchObject({ kind: "conversation", conversation: { provider: "claude", title: "Essay outline", turns: conversation.turns } });
    expect(shown.map((toast) => toast.title)).toEqual(["Connecting to Hubble Desktop…", "Save to Hubble", "Saved to Biology"]);
    expect(outcome).toMatchObject({ status: "done", saved: "added", turns: 2, project: "Biology" });
    expect(outcome.toast).toMatchObject({ tone: "done", final: true });
  });

  it("with Hubble Desktop closed: leaves Save to Hubble on the web, and never opens the app", async () => {
    const { save, shown, hubble } = saveHarness(desktopForSave({ running: false }));
    await expect(save(conversation)).resolves.toEqual({ fallback: true, reason: "desktop-not-open" });
    expect(hubble.sent).toHaveLength(0);
    expect(shown).toHaveLength(0);
  });

  it("with a Hubble Desktop that predates conversations: leaves Save to Hubble on the web", async () => {
    const { save, hubble } = saveHarness(desktopForSave({ kinds: null }));
    await expect(save(conversation)).resolves.toEqual({ fallback: true, reason: "desktop-too-old" });
    expect(hubble.sent).toHaveLength(0);
  });

  it("when the person cancels or doesn't choose in time: says nothing was saved", async () => {
    const cancelled = saveHarness(desktopForSave({ answer: () => ({ status: "cancelled", result: { kind: "conversation" } }) }));
    expect(await cancelled.save(conversation)).toMatchObject({ status: "cancelled" });
    expect(cancelled.shown.at(-1)).toMatchObject({ tone: "same", title: "Nothing saved" });
    const expired = saveHarness(desktopForSave({ answer: () => ({ status: "expired", result: { kind: "conversation" } }) }));
    expect(await expired.save(conversation)).toMatchObject({ status: "expired" });
    expect(expired.shown.at(-1)).toMatchObject({ tone: "error", title: "Nothing saved" });
  });

  it("when Hubble Desktop refuses it: says so, and the next save runs", async () => {
    const hubble = desktopForSave();
    const refusing = vi.fn(async (url, init) => (new URL(url).pathname.endsWith("/import") ? json(400, { ok: false, reason: "invalid-payload" }) : hubble.fetch(url, init)));
    const { save, shown } = saveHarness({ ...hubble, fetch: refusing });
    expect(await save(conversation)).toMatchObject({ reason: "invalid-payload" });
    expect(shown.at(-1)).toMatchObject({ tone: "error", title: "Couldn't save the conversation" });
    expect((await save(conversation)).reason).not.toBe("already-running");
  });

  it("saves one copy of a conversation at a time, and never holds up a different conversation", async () => {
    let release;
    const other = { ...conversation, url: "https://claude.ai/chat/9f8e7d6c-4e5f-6789-abcd-ef0123456789", key: "claude:chat:9f8e7d6c-4e5f-6789-abcd-ef0123456789" };
    const first = { ...conversation, key: "claude:chat:0a1b2c3d-4e5f-6789-abcd-ef0123456789" };
    const hubble = desktopForSave({
      answer: (payload) => (release || payload.conversation.url === other.url ? { status: "done", result: { kind: "conversation", saved: "added", turns: payload.conversation.turns.length, project: "Biology" } } : undefined),
    });
    const { save } = saveHarness(hubble);
    const pending = save(first);
    await vi.waitFor(() => expect(hubble.sent).toHaveLength(1));
    // The same conversation again — even at a harmlessly different address — waits for the first.
    expect((await save({ ...first, url: `${first.url}?ref=x` })).reason).toBe("already-running");
    // Another conversation from the same app goes straight through; Hubble Desktop queues it.
    await expect(save(other)).resolves.toMatchObject({ status: "done", saved: "added" });
    release = true;
    await expect(pending).resolves.toMatchObject({ status: "done", saved: "added" });
    expect(hubble.sent.map((payload) => payload.conversation.url)).toEqual([first.url, other.url]);
    // Nothing of the key travels to Hubble Desktop.
    expect(hubble.sent.every((payload) => !("key" in payload.conversation))).toBe(true);
  });

  it("reports each save in its own place when told where", async () => {
    const { save, shown } = saveHarness();
    const own = [];
    await save(conversation, { show: async (toast) => own.push(toast) });
    expect(shown).toEqual([]);
    expect(own.map((toast) => toast.title)).toEqual(["Connecting to Hubble Desktop…", "Save to Hubble", "Saved to Biology"]);
  });
});
