// Integration-style: background.js is exercised together with the real
// browser-commands.js/browser-actions.js it imports (nothing mocked but
// chrome.* itself), so these tests prove the actual wiring — in particular
// that the TABDUMP_BROWSER_COMMAND listener passes the *sender's* tab id
// through to openUrl, which is what lets a normal left-click on a saved tab
// navigate the TabDump tab itself instead of creating a new one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MSG_BROWSER_COMMAND = "TABDUMP_BROWSER_COMMAND";

function fakeTab(over) {
  return { id: 1, windowId: 1, url: "https://example.com", title: "Example", pinned: false, active: false, index: 0, ...over };
}

let registeredListeners;

beforeEach(() => {
  registeredListeners = [];
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
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      update: vi.fn(),
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
});

// background.js registers three onMessage listeners, in source order:
// dumpTabs, checkImported, then the browser-command dispatcher — the one
// these tests care about.
async function getBrowserCommandListener() {
  await import("./background.js");
  return registeredListeners[registeredListeners.length - 1];
}

function invoke(listener, message, senderTabId) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, { tab: senderTabId === undefined ? undefined : { id: senderTabId } }, resolve);
    expect(keepChannelOpen).toBe(true);
  });
}

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
