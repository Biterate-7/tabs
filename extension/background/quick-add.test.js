// Quick add (Hubble 2.0): an actual Chrome tab → the Hubble project, from the
// tab strip's right-click menu, the page's menu or the shortcut. Exercised
// through the real background.js with only chrome.* mocked, like
// add-to-project.test.js: the same delivery, ack and ingestion target as the
// popup's "Add to project", plus the toast that reports it where the person is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TABDUMP_ORIGIN,
  TARGET_PROJECT_KEY,
  HUBBLE_FOCUS_KEY,
  MSG_PROJECT_FOCUS,
  MSG_SOURCE_STATUS,
  MSG_ADD_TO_PROJECT,
  MENU_ADD_TAB,
  MENU_ADD_PAGE,
  QUICK_ADD_COMMAND,
} from "../src/config.js";

const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";
const HISTORY = { id: "ws-history", name: "History IA" };

function fakeTab(over) {
  return { id: 1, windowId: 10, url: "https://example.com", title: "Example", pinned: false, active: false, highlighted: false, index: 0, ...over };
}

const WINDOW = [
  fakeTab({ id: 1, url: "https://www.britannica.com/event/Cuban-missile-crisis", title: "Britannica", active: true, highlighted: true }),
  fakeTab({ id: 2, url: "https://example.com/paper.pdf", title: "Paper", highlighted: true }),
  fakeTab({ id: 3, url: "https://other.example/", title: "Other" }),
  fakeTab({ id: 4, url: "chrome://settings", title: "Settings" }),
  fakeTab({ id: 5, url: "about:blank", title: "about:blank" }),
];

let messageListeners;
let local;
let delivered;
let toasts;
let menus;
let handlers;
let statusAnswers;
let ack;

beforeEach(() => {
  messageListeners = [];
  local = { [TARGET_PROJECT_KEY]: HISTORY };
  delivered = [];
  toasts = [];
  menus = [];
  handlers = {};
  statusAnswers = [];
  ack = (payload) => ({ ok: true, accepted: payload.tabs.length });
  const event = (name) => ({ addListener: vi.fn((fn) => (handlers[name] = fn)), removeListener: vi.fn() });
  globalThis.chrome = {
    runtime: { onMessage: { addListener: vi.fn((fn) => messageListeners.push(fn)) }, onInstalled: event("installed"), onStartup: event("startup"), lastError: undefined },
    tabs: {
      query: vi.fn(async (query) => {
        if (query.url) return [fakeTab({ id: 42, windowId: 20, url: `${TABDUMP_ORIGIN}/`, active: true })];
        if (query.active) return WINDOW.filter((tab) => tab.active);
        if (query.highlighted) return WINDOW.filter((tab) => tab.highlighted);
        return WINDOW;
      }),
      get: vi.fn(async (id) => {
        const tab = WINDOW.find((entry) => entry.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      }),
      create: vi.fn(),
      update: vi.fn(),
      sendMessage: vi.fn(async (_tabId, message) => {
        if (message?.type === MSG_TABDUMP_IMPORT) {
          delivered.push(message.payload);
          return ack(message.payload);
        }
        if (message?.type === MSG_SOURCE_STATUS) return statusAnswers.shift() ?? { ok: true, statuses: [] };
        return undefined;
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async ({ target, func, args }) => {
        // Chrome refuses to inject into its own pages, which is when the badge stands in.
        if (target.tabId === 4) throw new Error("Cannot access a chrome:// URL");
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
    commands: { onCommand: event("command"), getAll: vi.fn(async () => [{ name: QUICK_ADD_COMMAND, shortcut: "Alt+Shift+H" }]) },
    storage: {
      session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) },
      local: {
        get: vi.fn(async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]]))),
        set: vi.fn(async (items) => Object.assign(local, items)),
        remove: vi.fn(async (key) => delete local[key]),
      },
      onChanged: event("storageChanged"),
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
});

async function load() {
  await import("./background.js");
}

async function until(check, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out; toasts so far: ${JSON.stringify(toasts)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const finalToast = () => toasts.findLast((toast) => toast.dismissAfterMs);

function send(message, sender = {}) {
  return new Promise((resolve) => {
    for (const listener of messageListeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    resolve(undefined);
  });
}

describe("the tab-strip menu", () => {
  it("is created on the tab strip and the page, naming the project the tab will go to", async () => {
    await load();
    handlers.installed();
    await until(() => menus.length === 2);
    expect(menus).toEqual([
      expect.objectContaining({ id: MENU_ADD_TAB, title: "Add to History IA", contexts: ["tab"] }),
      expect.objectContaining({ id: MENU_ADD_PAGE, title: "Add to History IA", contexts: ["page"] }),
    ]);
  });

  it("is renamed when the target project changes", async () => {
    await load();
    local[TARGET_PROJECT_KEY] = { id: "ws-physics", name: "Physics EE" };
    handlers.storageChanged({ [TARGET_PROJECT_KEY]: { newValue: local[TARGET_PROJECT_KEY] } }, "local");
    await until(() => menus.length === 2);
    expect(menus[0].title).toBe("Add to Physics EE");
  });

  it("adds a right-clicked tab that is part of a selection together with the rest of the selection", async () => {
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_TAB }, WINDOW[1]);
    await until(() => finalToast());
    expect(delivered).toHaveLength(1);
    expect(delivered[0].tabs.map((tab) => tab.url)).toEqual([WINDOW[0].url, WINDOW[1].url]);
    expect(delivered[0].target).toEqual({ workspaceId: "ws-history", as: "sources" });
    // Shown in the tab the person is looking at, from "Adding…" to the result.
    expect(toasts[0]).toMatchObject({ tabId: 1, tone: "working", title: "Adding to History IA…" });
    expect(toasts[1]).toMatchObject({ tabId: 1, tone: "working", title: "Adding to History IA…", status: "Reading source…" });
    expect(toasts[1].source).toBeUndefined();
    expect(finalToast()).toMatchObject({ tabId: 1, tone: "done", title: "Added 2 sources to History IA", focus: { tabId: 42, windowId: 20 } });
    // Marked, so a popup opened right after doesn't replay what the toast already said.
    const persisted = chrome.storage.session.set.mock.calls.at(-1)[0].tabdump_dump_state;
    expect(persisted).toMatchObject({ via: "quick-add", status: "done" });
    expect(JSON.stringify(persisted)).not.toContain("britannica");
  });

  it("adds just a right-clicked tab that is not selected, even when it isn't the one on screen", async () => {
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_TAB }, WINDOW[2]);
    await until(() => finalToast());
    expect(delivered[0].tabs.map((tab) => tab.url)).toEqual(["https://other.example/"]);
    expect(finalToast()).toMatchObject({ tabId: 1, tone: "done", title: "Added to History IA", source: "Other" });
  });

  it("names the project and the source, and follows reading until it settles", async () => {
    statusAnswers = [
      { ok: true, statuses: [{ url: WINDOW[2].url, status: "pending" }] },
      { ok: true, statuses: [{ url: WINDOW[2].url, status: "processing" }] },
      { ok: true, statuses: [{ url: WINDOW[2].url, status: "ready", detail: "1,840 words" }] },
    ];
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_TAB }, WINDOW[2]);
    await until(() => finalToast(), 8000);
    expect(toasts.map(({ tone, title, source, status }) => ({ tone, title, source, status }))).toEqual([
      { tone: "working", title: "Adding to History IA…", source: undefined, status: undefined },
      { tone: "working", title: "Adding to History IA…", source: "Other", status: "Reading source…" },
      { tone: "done", title: "Added to History IA", source: "Other", status: "Ready · 1,840 words" },
    ]);
    expect(finalToast().focus).toEqual({ tabId: 42, windowId: 20 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: MSG_SOURCE_STATUS, payload: { workspaceId: "ws-history", urls: [WINDOW[2].url] } });
  });

  it("says a source Hubble couldn't read was still added, and why it couldn't be read", async () => {
    statusAnswers = [{ ok: true, statuses: [{ url: WINDOW[2].url, status: "failed", detail: "The site didn't answer" }] }];
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_PAGE }, WINDOW[2]);
    await until(() => finalToast(), 6000);
    expect(finalToast()).toMatchObject({ tone: "done", title: "Added to History IA", status: "Couldn't read · The site didn't answer" });
  });

  it("says a tab already in the project is already there, naming the project", async () => {
    ack = () => ({ ok: true, accepted: 0, duplicates: 1 });
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_PAGE }, WINDOW[2]);
    await until(() => finalToast());
    expect(finalToast()).toMatchObject({ tone: "same", title: "Already in History IA", source: "Other", detail: "This source is already in the project." });
    // A duplicate was read when it first came in: nothing to follow.
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(42, expect.objectContaining({ type: MSG_SOURCE_STATUS }));
  });

  it("refuses Chrome's own pages, saying so on the toolbar icon where no toast can show", async () => {
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_PAGE }, WINDOW[3]);
    await until(() => chrome.action.setBadgeText.mock.calls.some(([arg]) => arg.text === "!"));
    expect(delivered).toEqual([]);
    expect(chrome.action.setTitle).toHaveBeenLastCalledWith({ title: "Couldn't add to History IA — Chrome's own pages can't be read. Web pages, PDFs and videos can." });
  });

  it("says a right-clicked blank tab has nothing to add, in the tab the person is looking at", async () => {
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_TAB }, WINDOW[4]);
    await until(() => finalToast());
    expect(delivered).toEqual([]);
    expect(finalToast()).toMatchObject({ tabId: 1, tone: "error", title: "Couldn't add to History IA", detail: "A blank tab has nothing to add. Open a page in it first." });
  });

  it("names the project when Hubble couldn't take the tab", async () => {
    ack = () => ({ ok: false, reason: "page-not-ready" });
    chrome.tabs.create.mockRejectedValue(new Error("no new tab in this test"));
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_PAGE }, WINDOW[2]);
    await until(() => finalToast(), 6000);
    expect(finalToast()).toMatchObject({ tone: "error", title: "Couldn't add to History IA" });
  });

  it("says when the remembered project has been deleted in Hubble", async () => {
    ack = () => ({ ok: true, accepted: 0, reason: "project-missing" });
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_PAGE }, WINDOW[2]);
    await until(() => finalToast());
    expect(finalToast()).toMatchObject({ tone: "error", title: "Couldn't add to History IA", detail: "History IA isn't in Hubble any more. Open the project you want, then try again." });
  });

  it("without a project, adds nothing and asks for one to be opened", async () => {
    delete local[TARGET_PROJECT_KEY];
    await load();
    handlers.menuClicked({ menuItemId: MENU_ADD_PAGE }, WINDOW[2]);
    await until(() => finalToast());
    expect(delivered).toEqual([]);
    expect(finalToast()).toMatchObject({ tone: "error", title: "Open a project in Hubble first" });
  });
});

describe("the shortcut", () => {
  it("adds the selected tabs (just the active one when nothing else is selected)", async () => {
    await load();
    handlers.command(QUICK_ADD_COMMAND, WINDOW[0]);
    await until(() => finalToast());
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 10, highlighted: true });
    expect(delivered[0].tabs.map((tab) => tab.url)).toEqual([WINDOW[0].url, WINDOW[1].url]);
  });

  it("ignores other commands", async () => {
    await load();
    handlers.command("something-else", WINDOW[0]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delivered).toEqual([]);
  });
});

describe("the project open in Hubble", () => {
  const hubble = { url: `${TABDUMP_ORIGIN}/`, tab: { id: 42 } };

  it("becomes the target, and the page is told the shortcut", async () => {
    delete local[TARGET_PROJECT_KEY];
    await load();
    const response = await send({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: "ws-physics" }, projects: [HISTORY, { id: "ws-physics", name: "Physics EE" }] } }, hubble);
    expect(response).toEqual({ ok: true, shortcut: "Alt+Shift+H", target: { id: "ws-physics", name: "Physics EE" } });
    expect(local[TARGET_PROJECT_KEY]).toEqual({ id: "ws-physics", name: "Physics EE" });
    expect(local[HUBBLE_FOCUS_KEY]).toBe("ws-physics");
  });

  it("follows the person from one project to the next: the menu, and where the tab goes", async () => {
    const projects = [HISTORY, { id: "ws-physics", name: "Physics EE" }];
    await load();
    await send({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: "ws-history" }, projects, visible: true } }, hubble);
    await send({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: "ws-physics" }, projects, visible: true } }, hubble);
    expect(local[TARGET_PROJECT_KEY]).toEqual({ id: "ws-physics", name: "Physics EE" });
    handlers.storageChanged({ [TARGET_PROJECT_KEY]: { newValue: local[TARGET_PROJECT_KEY] } }, "local");
    await until(() => menus.length === 2 && menus[0].title === "Add to Physics EE");
    // A reload of the same project reports it again: still Physics EE.
    await send({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: "ws-physics" }, projects, visible: true } }, hubble);
    expect(local[TARGET_PROJECT_KEY]).toEqual({ id: "ws-physics", name: "Physics EE" });
    handlers.menuClicked({ menuItemId: MENU_ADD_TAB }, WINDOW[2]);
    await until(() => finalToast());
    expect(delivered[0].target).toEqual({ workspaceId: "ws-physics", as: "sources" });
    expect(finalToast()).toMatchObject({ title: "Added to Physics EE" });
  });

  it("is not taken over by a Hubble tab in the background naming the same project", async () => {
    const projects = [HISTORY, { id: "ws-physics", name: "Physics EE" }];
    await load();
    await send({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: "ws-history" }, projects, visible: true } }, hubble);
    // The popup picks Physics EE…
    local[TARGET_PROJECT_KEY] = { id: "ws-physics", name: "Physics EE" };
    // …and the hidden Hubble tab that received the batch reports History IA again.
    await send({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: "ws-history" }, projects, visible: false } }, hubble);
    expect(local[TARGET_PROJECT_KEY]).toEqual({ id: "ws-physics", name: "Physics EE" });
  });

  it("is only taken from the Hubble page itself", async () => {
    await load();
    const response = await send({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: "ws-evil" }, projects: [{ id: "ws-evil", name: "Evil" }] } }, { url: "https://evil.example/" });
    expect(response).toEqual({ ok: false, reason: "not-hubble" });
    expect(local[TARGET_PROJECT_KEY]).toEqual(HISTORY);
  });
});

describe("the popup's Add to project", () => {
  it("still adds exactly the tabs it names", async () => {
    await load();
    const response = await send({ type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, tabIds: [3], target: { workspaceId: "ws-history", name: "History IA" } } });
    expect(delivered[0].tabs.map((tab) => tab.url)).toEqual(["https://other.example/"]);
    expect(response).toMatchObject({ ok: true, accepted: 1 });
  });
});
