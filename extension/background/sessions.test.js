// Save session, through the real background.js with only chrome.* mocked
// (like memory.test.js): which window is read, what reaches the Hubble page,
// what is left out, and who may ask.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSG_PAGE_REQUEST, MSG_SAVE_SESSION, TABDUMP_ORIGIN } from "../src/config.js";

const EXTENSION_ID = "hubble-extension";
const POPUP = { id: EXTENSION_ID };

let listeners;
let pageRequests;
let pageAnswer;

function tab(over) {
  return { id: 1, windowId: 10, index: 0, url: "https://example.com/", title: "Example", status: "complete", pinned: false, ...over };
}

const thisWindow = {
  id: 10,
  incognito: false,
  tabs: [
    tab({ id: 1, index: 0, url: "https://docs.google.com/document/d/1/edit", title: "Essay draft" }),
    tab({ id: 2, index: 1, url: "chrome://settings/", title: "Settings" }),
    tab({ id: 3, index: 2, url: "https://en.wikipedia.org/wiki/WW1", title: "WW1", pinned: true }),
    tab({ id: 4, index: 3, url: `${TABDUMP_ORIGIN}/`, title: "Hubble" }),
  ],
};
const otherWindow = { id: 11, incognito: false, tabs: [tab({ id: 5, windowId: 11, url: "https://phys.example/lab", title: "Lab" })] };
const privateWindow = { id: 12, incognito: true, tabs: [tab({ id: 6, windowId: 12, url: "https://secret.example/", title: "Secret" })] };

beforeEach(() => {
  listeners = [];
  pageRequests = [];
  pageAnswer = { ok: true, result: { id: "s1", name: "Session — 19 Oct", tabs: 2, dropped: 0 } };
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  globalThis.chrome = {
    runtime: { id: EXTENSION_ID, onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) } },
    tabs: {
      query: vi.fn(async (query) => (query.url ? [tab({ id: 42, url: `${TABDUMP_ORIGIN}/`, title: "Hubble" })] : [])),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      get: vi.fn(async (id) => tab({ id })),
      sendMessage: vi.fn(async (tabId, message) => {
        if (message?.type !== MSG_PAGE_REQUEST) return undefined;
        pageRequests.push({ tabId, ...message.payload });
        return pageAnswer;
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: {
      update: vi.fn(),
      get: vi.fn(async (id) => [thisWindow, otherWindow, privateWindow].find((win) => win.id === id)),
      getAll: vi.fn(async () => [thisWindow, otherWindow, privateWindow]),
    },
    storage: { session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) } },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
});

/** Sends a message to every listener, as Chrome does; resolves with the one answer. */
async function ask(message, sender = POPUP) {
  await import("./background.js");
  return new Promise((resolve) => {
    const kept = listeners.map((fn) => fn(message, sender, resolve));
    if (!kept.includes(true)) resolve(undefined);
  });
}

describe("Save session", () => {
  it("reads only the popup's window, in order, and hands Hubble the web pages", async () => {
    const answer = await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 10, name: "WW1 essay" } });
    expect(chrome.windows.get).toHaveBeenCalledWith(10, { populate: true });
    expect(chrome.windows.getAll).not.toHaveBeenCalled();
    expect(pageRequests).toEqual([
      expect.objectContaining({
        tabId: 42,
        kind: "save-session",
        args: {
          name: "WW1 essay",
          tabs: [
            { url: "https://docs.google.com/document/d/1/edit", title: "Essay draft" },
            { url: "https://en.wikipedia.org/wiki/WW1", title: "WW1", pinned: true },
          ],
        },
      }),
    ]);
    // The browser page is counted as left out; Hubble's own tab is not saved and not counted.
    expect(answer).toEqual({ ok: true, session: { name: "Session — 19 Oct", tabs: 2 }, leftOut: { restricted: 1, privateTabs: 0, tooMany: 0, dropped: 0 } });
  });

  it("with all windows, includes every ordinary window and never a private one", async () => {
    const answer = await ask({ type: MSG_SAVE_SESSION, payload: { allWindows: true } });
    expect(chrome.windows.getAll).toHaveBeenCalledWith({ populate: true, windowTypes: ["normal"] });
    expect(pageRequests[0].args.tabs.map((entry) => entry.url)).toEqual([
      "https://docs.google.com/document/d/1/edit",
      "https://en.wikipedia.org/wiki/WW1",
      "https://phys.example/lab",
    ]);
    expect(answer.leftOut.privateTabs).toBe(1);
  });

  it("refuses a private window without sending anything", async () => {
    expect(await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 12 } })).toEqual({ ok: false, error: "private-window" });
    expect(pageRequests).toEqual([]);
  });

  it("says when there is nothing to save, without asking Hubble", async () => {
    chrome.windows.get.mockResolvedValue({ id: 10, incognito: false, tabs: [tab({ url: "chrome://newtab/" })] });
    expect(await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 10 } })).toMatchObject({ ok: false, error: "empty" });
    expect(pageRequests).toEqual([]);
  });

  it("only reports success when Hubble says it stored the session", async () => {
    pageAnswer = { ok: false, error: "storage-failed" };
    expect(await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 10 } })).toMatchObject({ ok: false, error: "storage-failed" });
  });

  it("passes a chosen project through and validates the request", async () => {
    await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 10, workspaceId: "ws-history" } });
    expect(pageRequests[0].args.workspaceId).toBe("ws-history");
    expect(await ask({ type: MSG_SAVE_SESSION, payload: {} })).toEqual({ ok: false, error: "invalid" });
    expect(await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 10, name: "x".repeat(501) } })).toEqual({ ok: false, error: "invalid" });
  });

  it("is not answered for a web page or content script", async () => {
    expect(await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 10 } }, { id: EXTENSION_ID, tab: { id: 3 } })).toBeUndefined();
    expect(await ask({ type: MSG_SAVE_SESSION, payload: { windowId: 10 } }, { id: "another-extension" })).toBeUndefined();
    expect(pageRequests).toEqual([]);
  });
});
