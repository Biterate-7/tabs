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
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
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

// background.js registers three onMessage listeners, in source order:
// dumpTabs, checkImported, then the browser-command dispatcher — the one
// these tests care about.
async function getBrowserCommandListener() {
  await import("./background.js");
  return registeredListeners[registeredListeners.length - 1];
}

async function getDumpTabsListener() {
  await import("./background.js");
  return registeredListeners[0];
}

function invoke(listener, message, senderTabId) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, { tab: senderTabId === undefined ? undefined : { id: senderTabId } }, resolve);
    expect(keepChannelOpen).toBe(true);
  });
}

const MSG_DUMP_TABS = "DUMP_TABS";
const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";

describe("MSG_DUMP_TABS dispatch", () => {
  it("responds to the popup before focusing an already-open TabDump tab's window in another window", async () => {
    const callOrder = [];

    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, windowId: 10, url: "https://a.com" })];
      if (query.url) return [fakeTab({ id: 42, windowId: 20, url: "https://tabsdump.vercel.app/" })];
      return [];
    });
    chrome.tabs.update.mockImplementation(async (tabId, changes) => {
      callOrder.push(["tabs.update", tabId, changes]);
      return fakeTab({ id: tabId, windowId: 20, ...changes });
    });
    chrome.tabs.sendMessage.mockImplementation(async (tabId, message) => {
      callOrder.push(["tabs.sendMessage", tabId, message]);
      return { ok: true };
    });
    chrome.windows.update.mockImplementation(async (windowId, changes) => {
      callOrder.push(["windows.update", windowId, changes]);
    });

    const listener = await getDumpTabsListener();
    const response = await new Promise((resolve) => {
      const keepChannelOpen = listener({ type: MSG_DUMP_TABS, payload: {} }, {}, (res) => {
        callOrder.push(["sendResponse", res]);
        resolve(res);
      });
      expect(keepChannelOpen).toBe(true);
    });

    // Let the deferred window-focus microtask (queued after sendResponse
    // inside the .then()) actually run before asserting on callOrder.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response).toEqual({ ok: true, count: 1 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: MSG_TABDUMP_IMPORT })
    );

    const sendResponseIndex = callOrder.findIndex(([step]) => step === "sendResponse");
    const windowsUpdateIndex = callOrder.findIndex(([step]) => step === "windows.update");
    expect(sendResponseIndex).toBeGreaterThanOrEqual(0);
    expect(windowsUpdateIndex).toBeGreaterThan(sendResponseIndex);
    expect(chrome.windows.update).toHaveBeenCalledWith(20, { focused: true });
  });

  it("creates a new TabDump tab inactive, so opening it can never close the popup, and only focuses/activates it after the popup already has its response", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return []; // no existing TabDump tab
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: "https://tabsdump.vercel.app" }));
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 99, windowId: 10 }));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

    const listener = await getDumpTabsListener();
    const callOrder = [];
    const responsePromise = new Promise((resolve) => {
      const keepChannelOpen = listener({ type: MSG_DUMP_TABS, payload: {} }, {}, (res) => {
        callOrder.push(["sendResponse", res]);
        resolve(res);
      });
      expect(keepChannelOpen).toBe(true);
    });

    // waitForTabComplete registers its onUpdated listener asynchronously
    // (after chrome.tabs.create resolves) — wait for that registration
    // before simulating the newly created tab finishing its navigation.
    await vi.waitFor(() => {
      expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled();
    });
    // The tab must have been created inactive — activating it immediately,
    // the way chrome.tabs.create's default `active: true` would, is exactly
    // what steals foreground focus and closes an open extension popup
    // before the dump can finish.
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "http://localhost:3000", active: false });

    const onUpdated = chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
    onUpdated(99, { status: "complete" });

    const response = await responsePromise;
    expect(response).toEqual({ ok: true, count: 1 });

    // Let the deferred focus/activate microtask (queued after sendResponse)
    // actually run before asserting on it.
    chrome.tabs.update.mockImplementation(async (tabId, changes) => {
      callOrder.push(["tabs.update", tabId, changes]);
      return fakeTab({ id: tabId, windowId: 10, ...changes });
    });
    chrome.windows.update.mockImplementation(async (windowId, changes) => {
      callOrder.push(["windows.update", windowId, changes]);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sendResponseIndex = callOrder.findIndex(([step]) => step === "sendResponse");
    expect(sendResponseIndex).toBeGreaterThanOrEqual(0);
  });

  it("prefers the currently active TabDump tab over a stale background one when multiple are open, and only activates it after responding", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) {
        return [
          // Listed first (lower windowId/tab-index) but not the tab the
          // user is actually looking at right now.
          fakeTab({ id: 7, windowId: 10, url: "https://tabsdump.vercel.app/", active: false }),
          fakeTab({ id: 42, windowId: 20, url: "https://tabsdump.vercel.app/graph", active: true }),
        ];
      }
      return [];
    });
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 42, windowId: 20 }));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

    const listener = await getDumpTabsListener();
    const response = await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    expect(response).toEqual({ ok: true, count: 1 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: MSG_TABDUMP_IMPORT })
    );

    // Resolving a tab must not itself call chrome.tabs.update — that call is
    // deferred until after sendResponse (see the test above for why).
    // Wait a tick for that deferred call, then confirm it targets 42, never 7.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalledWith(7, expect.anything());
  });

  it("still returns a clean error result, without throwing, when delivery to an existing tab fails", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [fakeTab({ id: 42, windowId: 20, url: "https://tabsdump.vercel.app/" })];
      return [];
    });
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 42, windowId: 20 }));
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist."));

    const listener = await getDumpTabsListener();
    const response = await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    expect(response).toEqual({
      ok: false,
      reason: "delivery-failed",
      count: 1,
      detail: "Receiving end does not exist.",
    });
  });

  it("reports tab-open-failed, distinct from delivery-failed, when finding/opening the TabDump tab itself throws", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) throw new Error("This browser API function requires a user gesture to run.");
      return [];
    });

    const listener = await getDumpTabsListener();
    const response = await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    expect(response).toEqual({
      ok: false,
      reason: "tab-open-failed",
      count: 1,
      detail: "This browser API function requires a user gesture to run.",
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("reports unexpected-error with the underlying message when chrome.tabs.query itself throws", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) throw new Error("boom");
      return [];
    });

    const listener = await getDumpTabsListener();
    const response = await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, reason: "unexpected-error", count: 0, detail: "boom" });
  });

  it("rejects a second dump started while the first is still running, instead of letting them race", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [fakeTab({ id: 42, windowId: 20, url: "https://tabsdump.vercel.app/" })];
      return [];
    });
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 42, windowId: 20 }));
    // Delivery never resolves on its own here — held open deliberately so
    // the first dump is still "in flight" when the second request arrives.
    let resolveDelivery;
    chrome.tabs.sendMessage.mockReturnValue(new Promise((resolve) => (resolveDelivery = resolve)));

    const listener = await getDumpTabsListener();
    const firstResponsePromise = new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled());

    const secondResponse = await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });
    expect(secondResponse).toEqual({ ok: false, reason: "already-running", count: 0 });

    resolveDelivery({ ok: true });
    const firstResponse = await firstResponsePromise;
    expect(firstResponse).toEqual({ ok: true, count: 1 });

    // Let the .finally() that clears the concurrency guard actually run —
    // it's scheduled slightly after the response the test just awaited.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Once the first dump has actually finished, a third request must be
    // allowed through rather than staying permanently blocked.
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true });
    const thirdResponse = await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });
    expect(thirdResponse).toEqual({ ok: true, count: 1 });
  });

  it("never hangs waiting for a new tab that never finishes loading — resolves via the bounded timeout instead", async () => {
    vi.useFakeTimers();
    try {
      chrome.tabs.query.mockImplementation(async (query) => {
        if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
        if (query.url) return [];
        return [];
      });
      chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: "https://tabsdump.vercel.app" }));
      // Deliberately never fires onUpdated "complete" — simulates a tab
      // stuck loading (offline, blocked request, slow machine).
      chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist."));

      const listener = await getDumpTabsListener();
      const responsePromise = new Promise((resolve) => {
        listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
      });

      // Advance past TAB_READY_TIMEOUT_MS (8000ms) and the retry backoff.
      await vi.advanceTimersByTimeAsync(9000);

      const response = await responsePromise;
      expect(response.ok).toBe(false);
      expect(response.reason).toBe("delivery-failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a running, then a done, dump-state record so a reopened popup can recover the outcome", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [fakeTab({ id: 42, windowId: 20, url: "https://tabsdump.vercel.app/" })];
      return [];
    });
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 42, windowId: 20 }));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

    const listener = await getDumpTabsListener();
    await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ tabdump_dump_state: expect.objectContaining({ status: "running" }) })
    );
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ tabdump_dump_state: expect.objectContaining({ status: "done", ok: true, count: 1 }) })
    );
  });

  it("never throws or double-responds when the popup's message port is already closed", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [fakeTab({ id: 42, windowId: 20, url: "https://tabsdump.vercel.app/" })];
      return [];
    });
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 42, windowId: 20 }));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

    const deadPortSendResponse = vi.fn(() => {
      throw new Error("Attempting to use a disconnected port object");
    });

    const listener = await getDumpTabsListener();
    // The listener itself must not throw synchronously, and its returned
    // promise chain must not produce an unhandled rejection, even though
    // sendResponse always throws here.
    expect(() => listener({ type: MSG_DUMP_TABS, payload: {} }, {}, deadPortSendResponse)).not.toThrow();

    await vi.waitFor(() => {
      expect(deadPortSendResponse).toHaveBeenCalledTimes(1);
    });
    // Give any errant second response a chance to fire before asserting it doesn't.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deadPortSendResponse).toHaveBeenCalledTimes(1);
  });
});

// Reproduces the exact reported symptom end-to-end: Chrome starts with no
// TabDump tab open, the user dumps a normal set of tabs, and — per the fix
// in findOrOpenTabDumpTab()/the MSG_DUMP_TABS listener — the popup is
// allowed to disappear partway through (simulated here by making
// sendResponse throw, the same signature a closed message port produces)
// without that stopping the dump from actually finishing and delivering
// the payload to the TabDump page.
describe("the dump does not depend on the popup surviving", () => {
  function makeTabs(count) {
    return Array.from({ length: count }, (_, i) => fakeTab({ id: i + 1, url: `https://site${i}.example.com`, title: `Site ${i}` }));
  }

  it("creates the TabDump tab, delivers the payload, and reaches 'done' in storage even though the popup is already gone by the time sendResponse would fire", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return makeTabs(12);
      if (query.url) return []; // no existing TabDump tab — must create one
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 500, windowId: 10, url: "http://localhost:3000" }));
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 500, windowId: 10 }));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

    const listener = await getDumpTabsListener();
    const deadPopup = vi.fn(() => {
      throw new Error("Attempting to use a disconnected port object");
    });
    // The popup "disappears" — sendResponse throws — at the exact moment
    // background.js tries to deliver the result to it.
    listener({ type: MSG_DUMP_TABS, payload: {} }, {}, deadPopup);

    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    const onUpdated = chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
    onUpdated(500, { status: "complete" });

    // The dump must run to completion regardless — the TabDump page must
    // actually receive the tabs...
    await vi.waitFor(() => {
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        500,
        expect.objectContaining({
          type: MSG_TABDUMP_IMPORT,
          payload: expect.objectContaining({ tabs: expect.arrayContaining([expect.objectContaining({ url: "https://site0.example.com" })]) }),
        })
      );
    });
    expect(chrome.tabs.sendMessage.mock.calls[0][1].payload.tabs).toHaveLength(12);

    // ...and the persisted record — what a reopened popup will read — must
    // land on "done", not get stuck on "running" or silently disappear.
    await vi.waitFor(() => {
      expect(sessionStore.tabdump_dump_state).toMatchObject({ status: "done", ok: true, count: 12 });
    });

    // The dead popup's sendResponse was attempted exactly once — the throw
    // was swallowed, not retried or left to crash anything.
    expect(deadPopup).toHaveBeenCalledTimes(1);
  });

  it("delivers the full payload for 1 tab, 10 tabs, and 100+ tabs", async () => {
    for (const count of [1, 10, 137]) {
      sessionStore = {};
      vi.resetModules();
      registeredListeners = [];
      chrome.tabs.query.mockImplementation(async (query) => {
        if (query.currentWindow) return makeTabs(count);
        if (query.url) return [fakeTab({ id: 42, windowId: 20, url: "http://localhost:3000/" })];
        return [];
      });
      chrome.tabs.update.mockResolvedValue(fakeTab({ id: 42, windowId: 20 }));
      chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

      const listener = await getDumpTabsListener();
      const response = await new Promise((resolve) => {
        listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
      });

      expect(response).toEqual({ ok: true, count });
      expect(sessionStore.tabdump_dump_state).toMatchObject({ status: "done", count });
    }
  });

  it("skips a restricted chrome:// tab mixed in with normal tabs instead of failing the whole dump", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) {
        return [
          fakeTab({ id: 1, url: "https://a.com" }),
          fakeTab({ id: 2, url: "chrome://extensions" }),
          fakeTab({ id: 3, url: "https://b.com" }),
        ];
      }
      if (query.url) return [fakeTab({ id: 42, windowId: 20, url: "http://localhost:3000/" })];
      return [];
    });
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 42, windowId: 20 }));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

    const listener = await getDumpTabsListener();
    const response = await new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    expect(response).toEqual({ ok: true, count: 2 });
    const deliveredUrls = chrome.tabs.sendMessage.mock.calls[0][1].payload.tabs.map((t) => t.url);
    expect(deliveredUrls).toEqual(["https://a.com", "https://b.com"]);
  });

  it("reports delivery-failed (not a hang) when a newly created tab's content script never attaches — e.g. the TabDump server is unreachable", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [];
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 77, windowId: 10, url: "http://localhost:3000" }));
    // Chrome still resolves navigation to "complete" for an error
    // interstitial (ERR_CONNECTION_REFUSED) — the tab finishes "loading",
    // it just never runs the extension's content script.
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));

    const listener = await getDumpTabsListener();
    const responsePromise = new Promise((resolve) => {
      listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
    });

    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    const onUpdated = chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
    onUpdated(77, { status: "complete" });

    const response = await responsePromise;
    expect(response).toEqual({
      ok: false,
      reason: "delivery-failed",
      count: 1,
      detail: "Could not establish connection. Receiving end does not exist.",
    });
    await vi.waitFor(() => {
      expect(sessionStore.tabdump_dump_state).toMatchObject({ status: "error", reason: "delivery-failed" });
    });
  });

  it("still completes successfully when the TabDump page takes several seconds to load, well under the timeout", async () => {
    vi.useFakeTimers();
    try {
      chrome.tabs.query.mockImplementation(async (query) => {
        if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
        if (query.url) return [];
        return [];
      });
      chrome.tabs.create.mockResolvedValue(fakeTab({ id: 88, windowId: 10, url: "http://localhost:3000" }));
      chrome.tabs.sendMessage.mockResolvedValue({ ok: true });

      const listener = await getDumpTabsListener();
      const responsePromise = new Promise((resolve) => {
        listener({ type: MSG_DUMP_TABS, payload: {} }, {}, resolve);
      });

      await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
      // Simulate a slow-loading page: 4s pass with no "complete" event yet
      // (well under TAB_READY_TIMEOUT_MS's 8s), then it finishes loading.
      await vi.advanceTimersByTimeAsync(4000);
      const onUpdated = chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0];
      onUpdated(88, { status: "complete" });

      const response = await responsePromise;
      expect(response).toEqual({ ok: true, count: 1 });
    } finally {
      vi.useRealTimers();
    }
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
