// Integration-style: background.js is exercised together with the real
// browser-commands.js/browser-actions.js it imports (nothing mocked but
// chrome.* itself), so these tests prove the actual wiring — in particular
// that the TABDUMP_BROWSER_COMMAND listener passes the *sender's* tab id
// through to openUrl, which is what lets a normal left-click on a saved tab
// navigate the TabDump tab itself instead of creating a new one.
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

/** A tab already showing TabDump's app route — the only kind a dump can be handed to. */
function tabDumpTab(over) {
  return fakeTab({ url: `${TABDUMP_ORIGIN}/`, ...over });
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

// background.js registers four onMessage listeners, in source order:
// dumpTabs, focusTabDump, checkImported, then the browser-command dispatcher.
async function getBrowserCommandListener() {
  await import("./background.js");
  return registeredListeners[registeredListeners.length - 1];
}

async function getDumpTabsListener() {
  await import("./background.js");
  return registeredListeners[0];
}

async function getFocusListener() {
  await import("./background.js");
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

/**
 * Stands in for a content script whose page acks the batch — the only
 * response background.js now accepts as proof of delivery. `accepted`
 * defaults to "everything we sent"; pass a smaller number for a partial
 * import, or 0 for a page that took nothing.
 */
function ackEveryImport(accepted) {
  chrome.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
    if (message?.type !== MSG_TABDUMP_IMPORT) return undefined;
    return { ok: true, accepted: accepted ?? message.payload.tabs.length };
  });
}

function dump(listener, payload = {}) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener({ type: MSG_DUMP_TABS, payload }, {}, resolve);
    expect(keepChannelOpen).toBe(true);
  });
}

describe("MSG_DUMP_TABS dispatch", () => {
  it("delivers to an already-open TabDump tab and reports what the page actually accepted", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, windowId: 10, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport();

    const response = await dump(await getDumpTabsListener());

    expect(response).toEqual({
      ok: true,
      status: "done",
      count: 1,
      accepted: 1,
      skippedRestricted: 0,
      skippedAlreadyImported: 0,
      focusTabId: 42,
      focusWindowId: 20,
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: MSG_TABDUMP_IMPORT, importId: expect.any(String) })
    );
  });

  // Regression: activating or focusing the TabDump tab from the background
  // is what made a *working* dump look broken. Chrome dismisses an open
  // action popup the instant the foreground tab changes, so the popup was
  // routinely destroyed before it could render the result it had just been
  // sent — leaving the user with "Dumping tabs…", a vanished popup, and no
  // visible outcome. Focus is now requested by the popup once it has
  // something on screen (see MSG_FOCUS_TABDUMP below).
  it("never activates or focuses anything as part of the dump itself", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport();

    await dump(await getDumpTabsListener());
    // Anything deferred behind the response would still have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it("creates a new TabDump tab inactive, so opening it can never close the popup", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return []; // no existing TabDump tab
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    ackEveryImport();

    const responsePromise = dump(await getDumpTabsListener());

    // waitForTabComplete registers its onUpdated listener asynchronously
    // (after chrome.tabs.create resolves) — wait for that registration
    // before simulating the newly created tab finishing its navigation.
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: TABDUMP_ORIGIN, active: false });

    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({ ok: true, status: "done", count: 1, accepted: 1, focusTabId: 99 });
  });

  it("prefers the currently active TabDump tab over a stale background one when several are open", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) {
        return [
          // Listed first (lower windowId/tab-index) but not the tab the
          // user is actually looking at right now.
          tabDumpTab({ id: 7, windowId: 10, active: false }),
          tabDumpTab({ id: 42, windowId: 20, active: true }),
        ];
      }
      return [];
    });
    ackEveryImport();

    await dump(await getDumpTabsListener());

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ type: MSG_TABDUMP_IMPORT }));
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(7, expect.anything());
  });

  // Regression: /privacy, /terms and /cookies are served from the very same
  // origin, so they match content_scripts, host_permissions and
  // chrome.tabs.query's url filter exactly like the app does — but they
  // never mount AppShell, so a dump handed to one of them lands nowhere.
  // Before the app-route preference, whichever of those tabs the query
  // happened to return first would swallow the entire dump.
  it("ignores same-origin tabs that can't mount the app (the legal pages) and opens a real one instead", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) {
        return [
          fakeTab({ id: 5, windowId: 10, url: `${TABDUMP_ORIGIN}/privacy`, active: true }),
          fakeTab({ id: 6, windowId: 10, url: `${TABDUMP_ORIGIN}/terms` }),
        ];
      }
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    ackEveryImport();

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({ ok: true, accepted: 1, focusTabId: 99 });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(5, expect.anything());
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(6, expect.anything());
  });

  // Regression: "the content script accepted the message" was never evidence
  // that the React app behind it had ingested anything. A page still
  // hydrating has no `message` listener attached yet, so the payload was
  // posted into a document nobody was listening to — and the dump reported
  // success anyway.
  it("treats a delivery the page never acked as a failure, not a success", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    // The content script answers, but says the page never became ready.
    chrome.tabs.sendMessage.mockResolvedValue({ ok: false, reason: "page-not-ready" });

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    const response = await responsePromise;
    expect(response.ok).toBe(false);
    expect(response.reason).toBe("page-not-ready");
  });

  it("treats a pre-handshake content script's bare (undefined) answer as unproven rather than delivered", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    chrome.tabs.sendMessage.mockResolvedValue(undefined);

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    const response = await responsePromise;
    expect(response.ok).toBe(false);
    expect(response.reason).toBe("no-ack");
  });

  it("retries in a freshly opened tab when the tab it reused turns out to be unusable", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    chrome.tabs.sendMessage.mockImplementation(async (tabId, message) => {
      // The stale tab answers but can't ingest; the fresh one acks properly.
      if (tabId === 42) return { ok: false, reason: "page-not-ready" };
      return { ok: true, accepted: message.payload.tabs.length };
    });

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalled());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({ ok: true, status: "done", accepted: 1, focusTabId: 99 });
  });

  it("reports nothing-imported — never a zero-count success — when the page acks but takes no tabs", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport(0);

    const response = await dump(await getDumpTabsListener());

    expect(response).toMatchObject({ ok: false, status: "error", reason: "nothing-imported", count: 1, accepted: 0 });
  });

  it("reports a partial import distinctly from a clean one", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" }), fakeTab({ id: 2, url: "https://b.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport(1);

    const response = await dump(await getDumpTabsListener());

    expect(response).toMatchObject({ ok: true, status: "partial", count: 2, accepted: 1 });
  });

  // A service worker has no window of its own, so `currentWindow: true`
  // resolves to whichever window Chrome last considered focused — an
  // inference, not a fact. With several windows open it can disagree with
  // the window the popup was opened over and previewed, and the user gets a
  // confident "Dumped N tabs" listing some other window's tabs.
  it("dumps the window the popup names, not whichever one the worker infers is current", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.windowId === 3) return [fakeTab({ id: 1, windowId: 3, url: "https://right-window.example" })];
      if (query.currentWindow) return [fakeTab({ id: 2, windowId: 9, url: "https://wrong-window.example" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport();

    await dump(await getDumpTabsListener(), { windowId: 3 });

    const delivered = chrome.tabs.sendMessage.mock.calls[0][1].payload.tabs.map((t) => t.url);
    expect(delivered).toEqual(["https://right-window.example"]);
  });

  it("falls back to the inferred current window only when no window is named", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 2, windowId: 9, url: "https://fallback.example" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport();

    await dump(await getDumpTabsListener(), {});

    const delivered = chrome.tabs.sendMessage.mock.calls[0][1].payload.tabs.map((t) => t.url);
    expect(delivered).toEqual(["https://fallback.example"]);
  });

  it("counts the restricted browser pages it had to skip instead of quietly dropping them", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) {
        return [
          fakeTab({ id: 1, url: "https://a.com" }),
          fakeTab({ id: 2, url: "chrome://extensions" }),
          fakeTab({ id: 3, url: "devtools://devtools/bundled/x.html" }),
          fakeTab({ id: 4, url: "https://b.com" }),
        ];
      }
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport();

    const response = await dump(await getDumpTabsListener());

    expect(response).toMatchObject({ ok: true, count: 2, accepted: 2, skippedRestricted: 2 });
    const deliveredUrls = chrome.tabs.sendMessage.mock.calls[0][1].payload.tabs.map((t) => t.url);
    expect(deliveredUrls).toEqual(["https://a.com", "https://b.com"]);
  });

  it("reports content-script-missing, not a generic delivery failure, when no content script ever answers", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist."));

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({
      ok: false,
      status: "error",
      reason: "content-script-missing",
      count: 1,
      detail: "Receiving end does not exist.",
    });
    // Reported only after the repair was actually attempted and still failed.
    expect(chrome.scripting.executeScript).toHaveBeenCalled();
  });

  it("reports tab-open-failed, distinct from delivery-failed, when opening the TabDump tab itself throws", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [];
      return [];
    });
    chrome.tabs.create.mockRejectedValue(new Error("Tabs cannot be created for a devtools window."));

    const response = await dump(await getDumpTabsListener());

    expect(response).toMatchObject({
      ok: false,
      status: "error",
      reason: "tab-open-failed",
      count: 1,
      detail: "Tabs cannot be created for a devtools window.",
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("still dumps when the url-filtered tab lookup itself fails, by opening a fresh tab", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      throw new Error("Tab lookup unavailable.");
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    ackEveryImport();

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({ ok: true, accepted: 1 });
  });

  it("reports tab-query-failed with the underlying message when reading this window's tabs throws", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) throw new Error("boom");
      return [];
    });

    const response = await dump(await getDumpTabsListener());

    expect(response).toEqual({ ok: false, status: "error", reason: "tab-query-failed", count: 0, detail: "boom" });
  });

  it("rejects a second dump started while the first is still running, instead of letting them race", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    // Delivery never resolves on its own here — held open deliberately so
    // the first dump is still "in flight" when the second request arrives.
    let resolveDelivery;
    chrome.tabs.sendMessage.mockReturnValue(new Promise((resolve) => (resolveDelivery = resolve)));

    const listener = await getDumpTabsListener();
    const firstResponsePromise = dump(listener);

    await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled());

    const secondResponse = await dump(listener);
    expect(secondResponse).toEqual({ ok: false, status: "error", reason: "already-running", count: 0 });

    resolveDelivery({ ok: true, accepted: 1 });
    expect(await firstResponsePromise).toMatchObject({ ok: true, accepted: 1 });

    // Let the .finally() that clears the concurrency guard actually run —
    // it's scheduled slightly after the response the test just awaited.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Once the first dump has actually finished, a third request must be
    // allowed through rather than staying permanently blocked.
    ackEveryImport();
    expect(await dump(listener)).toMatchObject({ ok: true, accepted: 1 });
  });

  it("blames the unreachable origin, not the page, when a new tab never finishes loading", async () => {
    vi.useFakeTimers();
    try {
      chrome.tabs.query.mockImplementation(async (query) => {
        if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
        if (query.url) return [];
        return [];
      });
      chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
      // Deliberately never fires onUpdated "complete" — simulates a tab
      // stuck loading (offline, blocked request, captive portal).
      chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist."));

      const responsePromise = dump(await getDumpTabsListener());

      // Advance past TAB_READY_TIMEOUT_MS (8000ms) and the retry backoff.
      await vi.advanceTimersByTimeAsync(9000);

      const response = await responsePromise;
      expect(response.ok).toBe(false);
      expect(response.reason).toBe("tab-load-timeout");
      expect(response.detail).toContain(TABDUMP_ORIGIN);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up rather than hanging when the user closes the new tab before it loads", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [];
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalled());
    chrome.tabs.onRemoved.addListener.mock.calls.at(-1)[0](99);

    expect(await responsePromise).toMatchObject({ ok: false, reason: "tab-open-failed" });
  });

  it("persists a running record with a phase, then a terminal one, so a reopened popup can follow along", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport();

    await dump(await getDumpTabsListener());

    const phases = chrome.storage.session.set.mock.calls
      .map(([items]) => items.tabdump_dump_state)
      .filter((state) => state?.status === "running")
      .map((state) => state.phase);
    expect(phases).toContain("querying-tabs");
    expect(phases).toContain("delivering");

    expect(sessionStore.tabdump_dump_state).toMatchObject({
      status: "done",
      ok: true,
      count: 1,
      accepted: 1,
      phase: "finished",
      focusTabId: 42,
    });
  });

  it("never throws or double-responds when the popup's message port is already closed", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
    ackEveryImport();

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

// A "running" record left in storage when a fresh service worker boots can
// only be an orphan — this worker has no dump in flight by definition, so
// whatever wrote it belonged to a worker that no longer exists (evicted
// mid-dump, or crashed). MV3 fires no event for eviction, so leaving it
// alone meant the next popup open sat on "Dumping tabs…" until its staleness
// deadline expired, waiting on a result nothing would ever write.
describe("service-worker restart", () => {
  it("marks a dump left running by an evicted worker as interrupted, at startup", async () => {
    sessionStore.tabdump_dump_state = { status: "running", phase: "delivering", startedAt: Date.now() };

    await import("./background.js");

    await vi.waitFor(() => {
      expect(sessionStore.tabdump_dump_state).toMatchObject({
        status: "error",
        ok: false,
        reason: "interrupted",
      });
    });
    expect(sessionStore.tabdump_dump_state.finishedAt).toEqual(expect.any(Number));
  });

  it("leaves an already-finished record alone", async () => {
    const finished = { status: "done", ok: true, count: 3, finishedAt: 123 };
    sessionStore.tabdump_dump_state = finished;

    await import("./background.js");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sessionStore.tabdump_dump_state).toEqual(finished);
  });

  it("survives chrome.storage.session being unavailable entirely", async () => {
    delete chrome.storage.session;
    await expect(import("./background.js")).resolves.toBeDefined();
  });
});

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

// Reproduces the exact reported symptom end-to-end: Chrome starts with no
// TabDump tab open, the user dumps a normal set of tabs, and the popup is
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
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 500, windowId: 10, url: TABDUMP_ORIGIN }));
    ackEveryImport();

    const listener = await getDumpTabsListener();
    const deadPopup = vi.fn(() => {
      throw new Error("Attempting to use a disconnected port object");
    });
    // The popup "disappears" — sendResponse throws — at the exact moment
    // background.js tries to deliver the result to it.
    listener({ type: MSG_DUMP_TABS, payload: {} }, {}, deadPopup);

    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](500, { status: "complete" });

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
      expect(sessionStore.tabdump_dump_state).toMatchObject({ status: "done", ok: true, count: 12, accepted: 12 });
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
        if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
        return [];
      });
      ackEveryImport();

      const response = await dump(await getDumpTabsListener());

      expect(response).toMatchObject({ ok: true, status: "done", count, accepted: count });
      expect(sessionStore.tabdump_dump_state).toMatchObject({ status: "done", count });
    }
  });

  it("reports content-script-missing (not a hang) when a newly created tab's content script never attaches — e.g. the TabDump server is unreachable", async () => {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, url: "https://a.com" })];
      if (query.url) return [];
      return [];
    });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 77, windowId: 10, url: TABDUMP_ORIGIN }));
    // Chrome still resolves navigation to "complete" for an error
    // interstitial (ERR_CONNECTION_REFUSED) — the tab finishes "loading",
    // it just never runs the extension's content script.
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));

    const responsePromise = dump(await getDumpTabsListener());

    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](77, { status: "complete" });

    expect(await responsePromise).toMatchObject({
      ok: false,
      reason: "content-script-missing",
      count: 1,
      detail: "Could not establish connection. Receiving end does not exist.",
    });
    await vi.waitFor(() => {
      expect(sessionStore.tabdump_dump_state).toMatchObject({ status: "error", reason: "content-script-missing" });
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
      chrome.tabs.create.mockResolvedValue(fakeTab({ id: 88, windowId: 10, url: TABDUMP_ORIGIN }));
      ackEveryImport();

      const responsePromise = dump(await getDumpTabsListener());

      await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
      // Simulate a slow-loading page: 4s pass with no "complete" event yet
      // (well under TAB_READY_TIMEOUT_MS's 8s), then it finishes loading.
      await vi.advanceTimersByTimeAsync(4000);
      chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](88, { status: "complete" });

      expect(await responsePromise).toMatchObject({ ok: true, count: 1, accepted: 1 });
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

// The exact production failure this suite exists to keep fixed:
//
//   "TabDump didn't respond in that tab.
//    Could not establish connection. Receiving end does not exist."
//
// Reported from a second computer, on a fresh install, against the real
// tabsdump.vercel.app package. That package was current and its manifest did
// match the production origin; what was missing was the receiver itself.
// Chrome injects a manifest-declared content script only as a page loads, so
// the TabDump tab a new user already has open when they follow onboarding's
// last step ("Return to TabDump and click the TabDump extension") has none in
// it — and no number of retries can put one there.
//
// Every test here drives chrome.tabs.sendMessage to reject with Chrome's
// verbatim wording, and asserts the failure is recognised, repaired, and
// never rounded up into a success.
describe("recovering a tab whose content script was never injected", () => {
  /**
   * A tab with no receiver in it until the content script is injected, at
   * which point delivery starts working — exactly how Chrome behaves for a
   * tab that predates the extension's installation.
   */
  function tabWithNoReceiverUntilInjected({ injectable = true } = {}) {
    const injected = new Set();

    chrome.tabs.sendMessage.mockImplementation(async (tabId, message) => {
      if (!injected.has(tabId)) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      if (message?.type !== MSG_TABDUMP_IMPORT) return undefined;
      return { ok: true, accepted: message.payload.tabs.length };
    });

    chrome.scripting.executeScript.mockImplementation(async ({ target }) => {
      if (!injectable) throw new Error("Cannot access contents of the page.");
      injected.add(target.tabId);
      return [{ result: null }];
    });

    return injected;
  }

  /** The window the popup was opened over, plus one already-open TabDump tab. */
  function oneOpenTabDumpTab(dumpedUrl = "https://a.com") {
    chrome.tabs.query.mockImplementation(async (query) => {
      if (query.currentWindow) return [fakeTab({ id: 1, windowId: 10, url: dumpedUrl })];
      if (query.url) return [tabDumpTab({ id: 42, windowId: 20 })];
      return [];
    });
  }

  it("injects the content script into the already-open tab and delivers there, instead of failing the dump", async () => {
    oneOpenTabDumpTab();
    tabWithNoReceiverUntilInjected();

    const response = await dump(await getDumpTabsListener());

    // Delivered into the tab the user was already looking at...
    expect(response).toMatchObject({ ok: true, status: "done", count: 1, accepted: 1, focusTabId: 42 });
    // ...through a real ack, after a repair that actually happened...
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: [CONTENT_SCRIPT_FILE],
    });
    // ...and without a second TabDump tab appearing out of nowhere.
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("injects the manifest's own content-script path, so the repair cannot drift from what Chrome registers", () => {
    const manifest = JSON.parse(readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
    expect(manifest.content_scripts[0].js).toEqual([CONTENT_SCRIPT_FILE]);
    expect(existsSync(path.join(EXTENSION_DIR, CONTENT_SCRIPT_FILE))).toBe(true);
    // The injection API is unavailable without this permission, which would
    // turn the repair below into a silent no-op.
    expect(manifest.permissions).toContain("scripting");
  });

  it("falls back to a fresh tab when the existing tab cannot be injected into, and delivers there", async () => {
    oneOpenTabDumpTab();
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));

    // The pre-existing tab refuses injection; the freshly created one has a
    // content script from the moment it loads, as document_start guarantees.
    chrome.scripting.executeScript.mockRejectedValue(new Error("Cannot access contents of the page."));
    chrome.tabs.sendMessage.mockImplementation(async (tabId, message) => {
      if (tabId !== 99) throw new Error("Could not establish connection. Receiving end does not exist.");
      if (message?.type !== MSG_TABDUMP_IMPORT) return undefined;
      return { ok: true, accepted: message.payload.tabs.length };
    });

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({ ok: true, status: "done", accepted: 1, focusTabId: 99 });
  });

  it("never reports success when neither the injected tab nor a fresh one can receive the import", async () => {
    oneOpenTabDumpTab();
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    tabWithNoReceiverUntilInjected({ injectable: false });

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(response.status).toBe("error");
    expect(response.reason).toBe("content-script-missing");
    expect(response.accepted).toBeUndefined();
    // The persisted record a reopened popup recovers must agree — a failure
    // that exists only in the sendResponse channel is a silent failure to
    // anyone whose popup closed before it arrived.
    await vi.waitFor(() => {
      expect(sessionStore.tabdump_dump_state).toMatchObject({
        status: "error",
        ok: false,
        reason: "content-script-missing",
      });
    });
  });

  it("keeps 'no receiver' distinct from 'a receiver that answered and said no'", async () => {
    oneOpenTabDumpTab();
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    // A content script IS present here; the page behind it never became
    // ready. Injecting another copy would fix nothing, so the repair must not
    // fire and the reason must not be content-script-missing.
    chrome.tabs.sendMessage.mockResolvedValue({ ok: false, reason: "page-not-ready" });

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({ ok: false, reason: "page-not-ready" });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("does not mistake a closed message port for a missing receiver", async () => {
    oneOpenTabDumpTab();
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 99, windowId: 10, url: TABDUMP_ORIGIN }));
    // A receiver existed and then went away. Re-injecting would not bring the
    // page back, so this stays a plain delivery failure.
    chrome.tabs.sendMessage.mockRejectedValue(
      new Error("The message port closed before a response was received.")
    );

    const responsePromise = dump(await getDumpTabsListener());
    await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
    chrome.tabs.onUpdated.addListener.mock.calls.at(-1)[0](99, { status: "complete" });

    expect(await responsePromise).toMatchObject({ ok: false, reason: "delivery-failed" });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("logs the delivery target as an origin and a tab id, never the page's url", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      oneOpenTabDumpTab("https://private.example/secret-doc");
      tabWithNoReceiverUntilInjected();

      await dump(await getDumpTabsListener());

      const sendLines = logged.mock.calls.filter(([stage]) => stage === "[TabDump] send-message");
      expect(sendLines.length).toBeGreaterThan(0);
      expect(sendLines[0][1]).toMatchObject({ tabId: 42, windowId: 20, origin: TABDUMP_ORIGIN, attempt: 1 });

      // The diagnostic must stay a diagnostic, not a record of what the user
      // has open: no dumped tab's url may appear anywhere in the log.
      const everythingLogged = JSON.stringify(logged.mock.calls);
      expect(everythingLogged).not.toContain("private.example");
      expect(everythingLogged).not.toContain("secret-doc");
    } finally {
      logged.mockRestore();
    }
  });
});
