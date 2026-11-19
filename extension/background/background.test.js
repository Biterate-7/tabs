// Integration-style: background.js is exercised together with the real
// browser-commands.js/browser-actions.js it imports (nothing mocked but
// chrome.* itself), so these tests prove the actual wiring — in particular
// that the TABDUMP_BROWSER_COMMAND listener passes the *sender's* tab id
// through to openUrl, which is what lets a normal left-click on a saved tab
// navigate the Hubble tab itself instead of creating a new one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TABDUMP_ORIGIN, CONTENT_SCRIPT_FILE } from "../src/config.js";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MSG_BROWSER_COMMAND = "TABDUMP_BROWSER_COMMAND";

function fakeTab(over) {
  return { id: 1, windowId: 1, url: "https://example.com", title: "Example", pinned: false, active: false, index: 0, ...over };
}

/** A tab already showing Hubble's app route — the only kind a dump can be handed to. */
let registeredListeners;
let sessionStore;

beforeEach(() => {
  registeredListeners = [];
  sessionStore = {};
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: vi.fn((fn) => registeredListeners.push(fn)),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      sendMessage: vi.fn(),
      // Resolves to a still-loading tab by default so waitForTabComplete's
      // missed-event re-check finds nothing, and the explicit onUpdated
      // "complete" each test fires stays the thing that drives the load.
      get: vi.fn(async (id) => fakeTab({ id, status: "loading" })),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // The repair path for a tab with no content script in it. Resolving by
    // default matches a real Chrome that has host access to the tab.
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{ result: null }]),
    },
    windows: {
      update: vi.fn(),
    },
    storage: {
      session: {
        set: vi.fn(async (items) => {
          Object.assign(sessionStore, items);
        }),
        get: vi.fn(async (key) => ({ [key]: sessionStore[key] })),
      },
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
});

// background.js registers five onMessage listeners, in source order:
// dumpTabs, focusHubble, checkImported, the browser-command dispatcher, then
// quick add's project-focus listener (covered in quick-add.test.js).
// Context detection registers its own chrome.tabs.onUpdated listener when the module loads (MV3 needs it at
// module scope). The dump tests find waitForTabComplete's listener as "the one registered since", so the
// import-time registration is forgotten here.
async function importBackground() {
  await import("./background.js");
  chrome.tabs.onUpdated.addListener.mockClear();
}

async function getBrowserCommandListener() {
  await importBackground();
  return registeredListeners[3];
}

async function getFocusListener() {
  await importBackground();
  return registeredListeners[1];
}

function invoke(listener, message, senderTabId) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, { tab: senderTabId === undefined ? undefined : { id: senderTabId } }, resolve);
    expect(keepChannelOpen).toBe(true);
  });
}

const MSG_DUMP_TABS = "DUMP_TABS";
const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";
const MSG_FOCUS_TABDUMP = "TABDUMP_FOCUS";

describe("MSG_FOCUS_TABDUMP dispatch", () => {
  it("activates the tab and focuses its window", async () => {
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 99 }));
    chrome.windows.update.mockResolvedValue({});

    const response = await invoke(await getFocusListener(), {
      type: MSG_FOCUS_TABDUMP,
      payload: { tabId: 99, windowId: 10 },
    });

    expect(response).toEqual({ ok: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(99, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(10, { focused: true });
  });

  it("reports, rather than throws, when the tab has since been closed", async () => {
    chrome.tabs.update.mockRejectedValue(new Error("No tab with id: 99."));

    const response = await invoke(await getFocusListener(), {
      type: MSG_FOCUS_TABDUMP,
      payload: { tabId: 99, windowId: 10 },
    });

    expect(response).toMatchObject({ ok: false, reason: "focus-failed" });
  });

  it("rejects a malformed tab id without touching chrome.tabs", async () => {
    const listener = await getFocusListener();
    const response = await new Promise((resolve) => {
      listener({ type: MSG_FOCUS_TABDUMP, payload: { tabId: "99" } }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, reason: "invalid-tab-id" });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe("TABDUMP_BROWSER_COMMAND dispatch", () => {
  it("rejects a malformed payload without touching chrome.tabs", async () => {
    const listener = await getBrowserCommandListener();
    const response = await invoke(listener, { type: MSG_BROWSER_COMMAND, payload: { action: "open_url" } }, 55);
    expect(response.ok).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("rejects an action outside the allowlist", async () => {
    const listener = await getBrowserCommandListener();
    const response = await invoke(
      listener,
      { type: MSG_BROWSER_COMMAND, payload: { id: "1", action: "eval_javascript", args: {} } },
      55
    );
    expect(response).toEqual({ id: "1", ok: false, error: expect.stringMatching(/unknown or disallowed/i) });
  });

  it("threads the sender's own tab id into open_url so reuseCurrentTab navigates that exact tab", async () => {
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 55, url: "https://a.com" }));
    const listener = await getBrowserCommandListener();

    const response = await invoke(
      listener,
      { type: MSG_BROWSER_COMMAND, payload: { id: "1", action: "open_url", args: { url: "https://a.com", reuseCurrentTab: true } } },
      55
    );

    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(55, { url: "https://a.com" });
    expect(response).toEqual({ id: "1", ok: true, result: { tab: expect.objectContaining({ tabId: 55 }), alreadyOpen: false } });
  });

  it("does not confuse the sender's tab with any other tab id", async () => {
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 999, url: "https://a.com" }));
    const listener = await getBrowserCommandListener();

    await invoke(
      listener,
      { type: MSG_BROWSER_COMMAND, payload: { id: "1", action: "open_url", args: { url: "https://a.com", reuseCurrentTab: true } } },
      999
    );

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(999, { url: "https://a.com" });
  });

  it("still creates a new tab for a normal (non-reuse) open_url, e.g. an AI-originated command", async () => {
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 9, url: "https://a.com" }));
    const listener = await getBrowserCommandListener();

    const response = await invoke(
      listener,
      { type: MSG_BROWSER_COMMAND, payload: { id: "1", action: "open_url", args: { url: "https://a.com" } } },
      55
    );

    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://a.com", active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
  });

  it("falls back to creating a new tab when there is no sender tab (defensive: shouldn't happen in practice)", async () => {
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 9, url: "https://a.com" }));
    const listener = await getBrowserCommandListener();

    await invoke(
      listener,
      { type: MSG_BROWSER_COMMAND, payload: { id: "1", action: "open_url", args: { url: "https://a.com", reuseCurrentTab: true } } },
      undefined
    );

    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://a.com", active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

