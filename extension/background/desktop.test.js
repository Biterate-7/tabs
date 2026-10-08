// Hubble Desktop through the real background.js, with only chrome.* and the
// loopback bridge faked: the menu items, the popup's message, opening
// hubble:// when Hubble is closed, the toast, and Retry / Open Hubble Web.
// The flows themselves (not installed, cancelled, partial…) are covered
// without Chrome in src/desktop-add.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TABDUMP_ORIGIN,
  TARGET_PROJECT_KEY,
  DESKTOP_SEEN_KEY,
  DESKTOP_LAST_KEY,
  DESKTOP_STATE_KEY,
  MENU_ADD_TAB,
  MENU_ADD_PAGE,
  MENU_DESKTOP_TAB,
  MENU_DESKTOP_WINDOW,
  MENU_DESKTOP_PAGE,
  MSG_ADD_TO_DESKTOP,
  MSG_DESKTOP_STATUS,
  MSG_DESKTOP_ACTION,
} from "../src/config.js";
import { DESKTOP_LAUNCH_URL } from "../src/desktop.js";

function fakeTab(over) {
  return { id: 1, windowId: 10, index: 0, url: "https://example.com", title: "Example", status: "complete", active: false, highlighted: false, ...over };
}

const WINDOW = [
  fakeTab({ id: 1, index: 0, url: "https://a.example/", title: "A", active: true, highlighted: true }),
  fakeTab({ id: 2, index: 1, url: "https://b.example/", title: "B", highlighted: true }),
  fakeTab({ id: 3, index: 2, url: "https://c.example/", title: "C" }),
  fakeTab({ id: 4, index: 3, url: "chrome://settings", title: "Settings" }),
];

let listeners;
let handlers;
let menus;
let toasts;
let local;
let session;
let desktop;

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** Hubble Desktop's loopback bridge, answering like import_bridge.rs. */
function bridge() {
  const state = { running: true, sent: [], answer: { status: "done", result: { added: 2, duplicates: 1, failed: 0, project: "Research" } } };
  state.fetch = vi.fn(async (url, init = {}) => {
    const { hostname, port, pathname } = new URL(url);
    if (hostname !== "127.0.0.1" || port !== "41517" || !state.running) throw new TypeError("Failed to fetch");
    if (pathname === "/v1/hello") return json(200, { app: "hubble-desktop", protocol: 1, ready: true });
    if (pathname === "/v1/sessions") return json(201, { sessionId: "s1", token: "tok" });
    if (pathname.endsWith("/import")) {
      state.sent.push(JSON.parse(init.body));
      return json(202, { status: "waiting", accepted: state.sent.at(-1).tabs.length, rejected: 0 });
    }
    return json(200, { ...state.answer, result: { requestId: state.sent.at(-1).requestId, ...state.answer.result } });
  });
  return state;
}

beforeEach(() => {
  listeners = [];
  handlers = {};
  menus = [];
  toasts = [];
  local = { [TARGET_PROJECT_KEY]: { id: "ws-history", name: "History IA" } };
  session = {};
  desktop = bridge();
  globalThis.fetch = desktop.fetch;
  const event = (name) => ({ addListener: vi.fn((fn) => (handlers[name] = fn)), removeListener: vi.fn() });
  const area = (store) => ({
    get: vi.fn(async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]]))),
    set: vi.fn(async (items) => Object.assign(store, items)),
    remove: vi.fn(async (key) => delete store[key]),
  });
  globalThis.chrome = {
    runtime: { id: "hubble-ext", onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) }, onInstalled: event("installed"), onStartup: event("startup"), lastError: undefined },
    tabs: {
      query: vi.fn(async (query) => {
        if (query.url) return [];
        if (query.active) return WINDOW.filter((tab) => tab.active);
        if (query.highlighted) return WINDOW.filter((tab) => tab.highlighted);
        return WINDOW;
      }),
      get: vi.fn(async (id) => WINDOW.find((tab) => tab.id === id) ?? Promise.reject(new Error("No tab"))),
      create: vi.fn(async (props) => ({ id: 99, windowId: 10, ...props })),
      update: vi.fn(async (id, props) => {
        // Opening hubble:// is what starts Hubble Desktop.
        if (props.url === DESKTOP_LAUNCH_URL) desktop.running = desktop.installed !== false;
        return { id, ...props };
      }),
      sendMessage: vi.fn(async () => undefined),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async ({ target, func, args }) => {
        if (func) toasts.push({ tabId: target.tabId, ...args[0] });
        return [{ result: null }];
      }),
    },
    windows: { update: vi.fn() },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
    contextMenus: {
      removeAll: vi.fn((done) => {
        menus = [];
        done?.();
      }),
      create: vi.fn((props, done) => {
        menus.push(props);
        done?.();
      }),
      onClicked: event("menuClicked"),
    },
    commands: { onCommand: event("command"), getAll: vi.fn(async () => []) },
    storage: { local: area(local), session: area(session), onChanged: event("storageChanged") },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
  vi.resetModules();
});

async function load() {
  await import("./background.js");
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out; toasts so far: ${JSON.stringify(toasts)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function send(message, sender = { id: "hubble-ext" }) {
  return new Promise((resolve) => {
    for (const listener of listeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    resolve(undefined);
  });
}

const finalToast = () => toasts.findLast((toast) => toast.dismissAfterMs);

describe("the Hubble Desktop menu items", () => {
  it("stay away until Hubble Desktop has been seen, so Hubble Web users see no change", async () => {
    desktop.running = false;
    await load();
    handlers.installed();
    await until(() => menus.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(menus.map((menu) => menu.id)).toEqual([MENU_ADD_TAB, MENU_ADD_PAGE]);
  });

  it("appear once Hubble Desktop answers, beside the Hubble Web item", async () => {
    await load();
    handlers.installed();
    await until(() => local[DESKTOP_SEEN_KEY] === true);
    handlers.storageChanged({ [DESKTOP_SEEN_KEY]: { newValue: true } }, "local");
    await until(() => menus.length === 5);
    expect(menus).toEqual([
      expect.objectContaining({ id: MENU_ADD_TAB, title: "Add to History IA" }),
      expect.objectContaining({ id: MENU_ADD_PAGE }),
      expect.objectContaining({ id: MENU_DESKTOP_TAB, title: "Add to Hubble Desktop", contexts: ["tab"] }),
      expect.objectContaining({ id: MENU_DESKTOP_WINDOW, title: "Add all tabs in this window to Hubble Desktop", contexts: ["tab"] }),
      expect.objectContaining({ id: MENU_DESKTOP_PAGE, title: "Add to Hubble Desktop", contexts: ["page"] }),
    ]);
  });
});

describe("Add to Hubble Desktop", () => {
  it("from a right-clicked selected tab: sends the selection to Hubble Desktop and reports in the page", async () => {
    await load();
    handlers.menuClicked({ menuItemId: MENU_DESKTOP_TAB }, WINDOW[1]);
    await until(() => finalToast());
    expect(desktop.sent[0].tabs.map((tab) => tab.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(desktop.sent[0]).toMatchObject({ version: 1, source: "chrome-extension" });
    expect(toasts[0]).toMatchObject({ tabId: 1, tone: "working", title: "Connecting to Hubble Desktop…" });
    expect(toasts.map((toast) => toast.title)).toContain("Add 2 tabs to Hubble");
    expect(finalToast()).toMatchObject({ tabId: 1, tone: "done", title: "Added 2 sources to Research", detail: "1 already there" });
    // Nothing went to the Hubble website.
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(desktop.fetch.mock.calls.every(([url]) => url.startsWith("http://127.0.0.1:"))).toBe(true);
  });

  it("from the window item: takes every readable tab in the window", async () => {
    await load();
    handlers.menuClicked({ menuItemId: MENU_DESKTOP_WINDOW }, WINDOW[2]);
    await until(() => finalToast());
    expect(desktop.sent[0].tabs).toHaveLength(3);
  });

  it("from the popup: answers with the outcome and keeps a record the popup can read", async () => {
    await load();
    const outcome = await send({ type: MSG_ADD_TO_DESKTOP, payload: { scope: "current", windowId: 10 } });
    expect(outcome).toMatchObject({ status: "done", added: 2, toast: { title: "Added 2 sources to Research" } });
    expect(session[DESKTOP_STATE_KEY]).toMatchObject({ status: "finished", toast: { tone: "done" } });
    expect(session[DESKTOP_LAST_KEY]).toEqual({ scope: "current", windowId: 10 });
  });

  it("with Hubble Desktop closed: opens hubble://import in the tab the person is on, then sends once it is up", async () => {
    desktop.running = false;
    await load();
    const outcome = await send({ type: MSG_ADD_TO_DESKTOP, payload: { scope: "current", windowId: 10 } });
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: DESKTOP_LAUNCH_URL });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(toasts.map((toast) => toast.title)).toContain("Opening Hubble Desktop…");
    expect(outcome).toMatchObject({ status: "done" });
  });

  it("tells the popup whether Hubble Desktop is open", async () => {
    await load();
    await expect(send({ type: MSG_DESKTOP_STATUS })).resolves.toEqual({ ok: true, available: true, seen: true });
    desktop.running = false;
    await expect(send({ type: MSG_DESKTOP_STATUS })).resolves.toEqual({ ok: true, available: false, seen: true });
  });
});

describe("after a failure", () => {
  it("shows Retry and Open Hubble Web, and Retry sends the same tabs again", async () => {
    await load();
    const sendFetch = desktop.fetch;
    let failNext = true;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (failNext && url.endsWith("/import")) {
        failNext = false;
        throw new TypeError("Failed to fetch");
      }
      return sendFetch(url, init);
    });
    const failed = await send({ type: MSG_ADD_TO_DESKTOP, payload: { scope: "selected", windowId: 10 } });
    expect(failed.toast).toMatchObject({ title: "Hubble Desktop isn't responding", actions: ["retry", "web"] });
    expect(finalToast().actions).toEqual([
      { action: "retry", label: "Try again" },
      { action: "web", label: "Open Hubble Web" },
    ]);

    const retried = await send({ type: MSG_DESKTOP_ACTION, payload: { action: "retry" } }, { id: "hubble-ext", tab: { id: 1 } });
    expect(retried).toMatchObject({ status: "done" });
    expect(desktop.sent.at(-1).tabs.map((tab) => tab.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("Open Hubble Web adds the same tabs to the project open in Hubble on the web", async () => {
    await load();
    session[DESKTOP_LAST_KEY] = { scope: "current", windowId: 10 };
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.url) return [fakeTab({ id: 42, url: `${TABDUMP_ORIGIN}/`, active: true })];
      if (query.active) return WINDOW.filter((tab) => tab.active);
      return WINDOW;
    });
    chrome.tabs.sendMessage.mockImplementation(async (_tabId, message) => (message.type === "TABDUMP_IMPORT" ? { ok: true, accepted: 1 } : undefined));
    await send({ type: MSG_DESKTOP_ACTION, payload: { action: "web" } }, { id: "hubble-ext", tab: { id: 1 } });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ type: "TABDUMP_IMPORT", payload: expect.objectContaining({ target: { workspaceId: "ws-history", as: "sources" } }) }));
  });

  it("Open Hubble Web with no web project opens Hubble Web to choose one", async () => {
    delete local[TARGET_PROJECT_KEY];
    await load();
    await send({ type: MSG_DESKTOP_ACTION, payload: { action: "web" } });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: TABDUMP_ORIGIN, active: true });
  });

  it("ignores actions from anyone but this extension, and unknown actions", async () => {
    await load();
    await expect(send({ type: MSG_DESKTOP_ACTION, payload: { action: "retry" } }, { id: "some-other-extension" })).resolves.toBeUndefined();
    await expect(send({ type: MSG_DESKTOP_ACTION, payload: { action: "rm" } })).resolves.toBeUndefined();
    expect(desktop.sent).toHaveLength(0);
  });
});
