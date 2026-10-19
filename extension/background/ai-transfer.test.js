// Use in AI through the real background.js, with only chrome.* mocked: who
// may start a transfer, where its progress goes, the permission window, and
// that the page steps run in the AI app's tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABDUMP_ORIGIN } from "../src/config.js";
import { MSG_AI_PERMISSION_ANSWER, MSG_AI_TRANSFER, MSG_AI_TRANSFER_PROGRESS } from "../src/ai-transfer.js";

const EXTENSION_ID = "hubble-extension";
const HUBBLE_TAB = { id: 42, windowId: 10, index: 3, url: `${TABDUMP_ORIGIN}/` };
const FROM_HUBBLE = { id: EXTENSION_ID, tab: HUBBLE_TAB, url: `${TABDUMP_ORIGIN}/`, frameId: 0 };

let listeners;
let sent;
let granted;
let session;
let windowListeners;
let permissionListeners;
let created;

function request(patch = {}) {
  return { opId: "op_0123456789abcdef", provider: "chatgpt", mode: "prepare", text: "Summarize this, please.", files: [], ...patch };
}

beforeEach(() => {
  listeners = [];
  sent = [];
  granted = true;
  session = {};
  windowListeners = [];
  permissionListeners = [];
  globalThis.chrome = {
    runtime: { id: EXTENSION_ID, onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) }, getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`, getPlatformInfo: vi.fn(async () => ({})) },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async (props) => (created = { id: 77, windowId: props.windowId, url: props.url, status: "complete" })),
      update: vi.fn(async () => {}),
      get: vi.fn(async (id) => (id === 77 ? created : HUBBLE_TAB)),
      sendMessage: vi.fn(async (tabId, message) => {
        sent.push({ tabId, ...message });
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async ({ func, args }) => {
        if (func?.name !== "hubbleTransferStep") return [{ result: null }];
        const [step] = args;
        if (step === "probe") return [{ result: { ok: true, empty: true, ours: false } }];
        return [{ result: { ok: true } }];
      }),
    },
    windows: {
      update: vi.fn(async () => {}),
      create: vi.fn(async () => ({ id: 555 })),
      remove: vi.fn(async () => {}),
      onRemoved: { addListener: vi.fn((fn) => windowListeners.push(fn)), removeListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn(async () => granted),
      onAdded: { addListener: vi.fn((fn) => permissionListeners.push(fn)), removeListener: vi.fn() },
    },
    storage: {
      session: {
        get: vi.fn(async (key) => ({ [key]: session[key] })),
        set: vi.fn(async (values) => Object.assign(session, JSON.parse(JSON.stringify(values)))),
      },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
  };
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
});

async function loadBackground() {
  await import("./background.js");
}

/** Delivers a message to every background listener; resolves with the answer of the one that answered. */
function deliver(message, sender) {
  return new Promise((resolve) => {
    let async = false;
    for (const listener of listeners) {
      const keep = listener(message, sender, resolve);
      if (keep === true) async = true;
    }
    if (!async) setTimeout(() => resolve(undefined), 20);
  });
}

describe("starting a transfer", () => {
  it("runs one from Hubble's own page: opens the app beside it, types in that tab, and reports progress to Hubble", async () => {
    await loadBackground();
    const answer = await deliver({ type: MSG_AI_TRANSFER, payload: request() }, FROM_HUBBLE);
    expect(answer).toMatchObject({ opId: "op_0123456789abcdef", ok: true, state: "ready-for-review" });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://chatgpt.com/", active: true, windowId: 10, index: 4 });
    const steps = chrome.scripting.executeScript.mock.calls.map(([call]) => [call.target.tabId, call.func.name, call.args[0]]);
    expect(steps).toEqual([
      [77, "hubbleTransferStep", "probe"],
      [77, "hubbleTransferStep", "insert"],
    ]);
    expect(sent.filter((message) => message.type === MSG_AI_TRANSFER_PROGRESS).map((message) => [message.tabId, message.payload.state])).toEqual([
      [42, "opening-provider"],
      [42, "waiting-for-provider"],
      [42, "inserting"],
    ]);
  });

  it.each([
    ["another website's tab", { id: EXTENSION_ID, tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/", frameId: 0 }],
    ["a frame inside Hubble", { ...FROM_HUBBLE, frameId: 3 }],
    ["the popup (no tab)", { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` }],
    ["another extension", { ...FROM_HUBBLE, id: "someone-else" }],
  ])("refuses %s, touching nothing", async (_label, sender) => {
    await loadBackground();
    expect(await deliver({ type: MSG_AI_TRANSFER, payload: request() }, sender)).toEqual({ opId: "op_0123456789abcdef", ok: false, error: "invalid" });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("refuses a malformed request", async () => {
    await loadBackground();
    expect(await deliver({ type: MSG_AI_TRANSFER, payload: request({ provider: "grok" }) }, FROM_HUBBLE)).toMatchObject({ ok: false, error: "invalid" });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe("the permission window", () => {
  it("asks for exactly the app's origins in a small window, and carries on once granted", async () => {
    granted = false;
    await loadBackground();
    const answer = deliver({ type: MSG_AI_TRANSFER, payload: request({ provider: "claude" }) }, FROM_HUBBLE);
    await vi.waitFor(() => expect(chrome.windows.create).toHaveBeenCalled());
    expect(chrome.windows.create.mock.calls[0][0]).toMatchObject({ url: `chrome-extension://${EXTENSION_ID}/permissions/grant.html?provider=claude&op=op_0123456789abcdef`, type: "popup" });
    expect(sent.map((message) => message.payload?.state)).toContain("waiting-for-permission");
    granted = true;
    await deliver({ type: MSG_AI_PERMISSION_ANSWER, payload: { opId: "op_0123456789abcdef", provider: "claude", granted: true } }, { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/permissions/grant.html?provider=claude&op=op_0123456789abcdef`, tab: { id: 900, url: `chrome-extension://${EXTENSION_ID}/permissions/grant.html` } });
    expect(await answer).toMatchObject({ ok: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: "https://claude.ai/new" }));
  });

  it("stops with nothing opened when the window is closed without granting", async () => {
    granted = false;
    await loadBackground();
    const answer = deliver({ type: MSG_AI_TRANSFER, payload: request() }, FROM_HUBBLE);
    await vi.waitFor(() => expect(windowListeners.length).toBeGreaterThan(0));
    for (const listener of windowListeners) listener(555);
    expect(await answer).toMatchObject({ ok: false, error: "permission-denied" });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("ignores a 'granted' answer from anywhere but its own window", async () => {
    granted = false;
    await loadBackground();
    const answer = deliver({ type: MSG_AI_TRANSFER, payload: request() }, FROM_HUBBLE);
    await vi.waitFor(() => expect(chrome.windows.create).toHaveBeenCalled());
    await deliver({ type: MSG_AI_PERMISSION_ANSWER, payload: { opId: "op_0123456789abcdef", granted: true } }, FROM_HUBBLE);
    // Still waiting: the forged answer did nothing. The window closing settles it.
    for (const listener of windowListeners) listener(555);
    expect(await answer).toMatchObject({ ok: false, error: "permission-denied" });
  });
});
