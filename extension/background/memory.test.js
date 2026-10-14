// Save to Hubble and Use Hubble in this chat, through the real background.js
// with only chrome.* mocked (like add-to-project.test.js): what is read,
// from which tab, what reaches the Hubble page, and who may ask. background.js
// gets its own copy of ai-pages.js after vi.resetModules, so the injected
// functions are matched by name, not identity.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSG_CAPTURE_CONVERSATION, MSG_INSERT_CONTEXT, MSG_MEMORY_REQUEST, MSG_PAGE_REQUEST, TABDUMP_ORIGIN } from "../src/config.js";
import { insertIntoComposer, readConversationFromPage } from "../src/ai-pages.js";

const EXTENSION_ID = "hubble-extension";
const POPUP = { id: EXTENSION_ID };
const CHAT_URL = "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb";

let listeners;
let pageRequests;

function fakeTab(over) {
  return { id: 7, windowId: 10, url: CHAT_URL, title: "Thesis feedback - Claude", status: "complete", ...over };
}

beforeEach(() => {
  listeners = [];
  pageRequests = [];
  globalThis.chrome = {
    runtime: { id: EXTENSION_ID, onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) } },
    tabs: {
      query: vi.fn(async (query) => (query.url ? [fakeTab({ id: 42, url: `${TABDUMP_ORIGIN}/`, title: "Hubble" })] : [])),
      create: vi.fn(),
      update: vi.fn(),
      get: vi.fn(async (id) => fakeTab({ id })),
      sendMessage: vi.fn(async (tabId, message) => {
        if (message?.type !== MSG_PAGE_REQUEST) return undefined;
        pageRequests.push({ tabId, ...message.payload });
        return { ok: true, result: { outcome: "added", title: "Thesis feedback", turns: 2, truncated: false } };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async ({ func }) => {
        if (func?.name === "readConversationFromPage") return [{ result: { ok: true, provider: "claude", url: CHAT_URL, title: "Thesis feedback - Claude", turns: [{ role: "user", text: "Is it arguable?" }, { role: "assistant", text: "Yes." }] } }];
        if (func?.name === "insertIntoComposer") return [{ result: { inserted: true } }];
        return [{ result: null }];
      }),
    },
    windows: { update: vi.fn() },
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

describe("Save to Hubble", () => {
  it("reads only the conversation tab it was given, then hands it to the Hubble page with Chrome's own address", async () => {
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws-history" } });
    expect(answer).toMatchObject({ ok: true, result: { outcome: "added", turns: 2 }, hubbleTabId: 42 });
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, func: expect.objectContaining({ name: readConversationFromPage.name }) });
    expect(pageRequests).toEqual([
      expect.objectContaining({ tabId: 42, kind: "capture", args: { workspaceId: "ws-history", capture: { url: CHAT_URL, title: "Thesis feedback - Claude", turns: expect.any(Array) } } }),
    ]);
  });

  it("refuses a page that is not an AI conversation without reading it", async () => {
    chrome.tabs.get.mockImplementation(async (id) => fakeTab({ id, url: "https://claude.ai/settings" }));
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "not-a-conversation" });
    chrome.tabs.get.mockImplementation(async (id) => fakeTab({ id, url: "https://bank.example/account" }));
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "not-supported" });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(pageRequests).toEqual([]);
  });

  it("passes on the page reader's reason when the layout is not recognised", async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: { ok: false, reason: "no-messages", provider: "claude" } }]);
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "no-messages" });
    expect(pageRequests).toEqual([]);
  });
});

describe("Use Hubble in this chat", () => {
  it("relays only the four memory requests to the Hubble page", async () => {
    await ask({ type: MSG_MEMORY_REQUEST, payload: { kind: "search", args: { query: "thesis" } } });
    expect(pageRequests.map((request) => request.kind)).toEqual(["search"]);
    expect(await ask({ type: MSG_MEMORY_REQUEST, payload: { kind: "capture", args: {} } })).toEqual({ ok: false, error: "invalid" });
    expect(pageRequests).toHaveLength(1);
  });

  it("inserts into the AI app's message box and never anywhere else", async () => {
    expect(await ask({ type: MSG_INSERT_CONTEXT, payload: { tabId: 7, text: "Context from my Hubble project" } })).toEqual({ inserted: true });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, func: expect.objectContaining({ name: insertIntoComposer.name }), args: ["Context from my Hubble project"] });
    chrome.tabs.get.mockImplementation(async (id) => fakeTab({ id, url: "https://mail.example/compose" }));
    expect(await ask({ type: MSG_INSERT_CONTEXT, payload: { tabId: 7, text: "x" } })).toEqual({ inserted: false, reason: "not-supported" });
    expect(await ask({ type: MSG_INSERT_CONTEXT, payload: { tabId: 7, text: "" } })).toEqual({ inserted: false, reason: "invalid" });
  });
});

describe("who may ask", () => {
  it("ignores these requests from a content script or another extension", async () => {
    for (const sender of [{ id: EXTENSION_ID, tab: { id: 99 } }, { id: "someone-else" }]) {
      expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } }, sender)).toBeUndefined();
      expect(await ask({ type: MSG_INSERT_CONTEXT, payload: { tabId: 7, text: "x" } }, sender)).toBeUndefined();
    }
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});
