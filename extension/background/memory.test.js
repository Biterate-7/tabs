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
// Save asks Hubble Desktop first, over loopback: never the real network here.
const realFetch = globalThis.fetch;
let bridgeRequests;

function fakeTab(over) {
  return { id: 7, windowId: 10, url: CHAT_URL, title: "Thesis feedback - Claude", status: "complete", ...over };
}

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** Hubble Desktop's bridge on its first port, saving whatever it is sent into "Biology". */
function openHubbleDesktop() {
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const { pathname, port } = new URL(url);
    if (port !== "41517") throw new TypeError("Failed to fetch");
    bridgeRequests.push({ method: init.method ?? "GET", pathname, body: init.body ? JSON.parse(init.body) : undefined });
    if (pathname === "/v1/hello") return json(200, { app: "hubble-desktop", protocol: 1, ready: true, kinds: ["tabs", "conversation"] });
    if (pathname === "/v1/sessions") return json(201, { sessionId: "s1", token: "tok" });
    if (pathname.endsWith("/import")) return json(202, { status: "waiting", kind: "conversation", turns: 2 });
    return json(200, { status: "done", result: { kind: "conversation", requestId: bridgeRequests[2].body.requestId, success: true, saved: "added", turns: 2, truncated: false, project: "Biology" } });
  });
}

beforeEach(() => {
  listeners = [];
  pageRequests = [];
  bridgeRequests = [];
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
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
  globalThis.fetch = realFetch;
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

describe("Save to Hubble with Hubble Desktop open", () => {
  it("sends the conversation to Hubble Desktop, not the Hubble page, and says where the person put it", async () => {
    openHubbleDesktop();
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws-history" } });
    expect(answer).toEqual({ ok: true, result: { outcome: "added", turns: 2, truncated: false, project: "Biology", desktop: true } });
    expect(pageRequests).toEqual([]);
    const sent = bridgeRequests.find((request) => request.pathname.endsWith("/import"));
    // Chrome's own address and the provider it names; role and text only.
    expect(sent.body).toMatchObject({
      kind: "conversation",
      source: "chrome-extension",
      conversation: { provider: "claude", url: CHAT_URL, title: "Thesis feedback - Claude", turns: [{ role: "user", text: "Is it arguable?" }, { role: "assistant", text: "Yes." }], truncated: false },
    });
  });

  it("needs no project chosen in the popup, but Hubble on the web does", async () => {
    openHubbleDesktop();
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7 } })).toMatchObject({ ok: true, result: { desktop: true } });
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7 } })).toEqual({ ok: false, error: "no-project" });
    expect(pageRequests).toEqual([]);
  });
});

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

describe("Save to Hubble on ChatGPT's signed-in layout (2026-10-15)", () => {
  const CHATGPT_URL = "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f";
  const unit = (key, body) => `<div data-content-search-unit-key="fallback-turn-0:${key}">${body}</div>`;

  /** A ChatGPT conversation reduced to its structure; executeScript runs the real reader against it. */
  function chatgptPage(status = "") {
    const doc = document.implementation.createHTMLDocument("Admissions Strategy Assessment");
    doc.body.innerHTML = `<nav><a href="/c/other">Another chat</a></nav>
      <main><div data-thread-find-target="conversation">${status ? `<div role="status">${status}</div>` : ""}<div data-turn-key="t1">
        <h4>You said:</h4>${unit("0:user", `<div data-user-message-bubble="true"><div>What caused WW1?</div></div><button aria-label="Copy message"></button>`)}
        ${unit("1:assistant", `<h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-markdown-copy="contents"><p data-d-component="text">Militarism and alliances.</p></div>`)}
      </div></div><form><textarea name="prompt">draft</textarea></form></main>`;
    return doc;
  }

  beforeEach(() => {
    chrome.tabs.get.mockImplementation(async (id) => fakeTab({ id, url: CHATGPT_URL, title: "Admissions Strategy Assessment" }));
    chrome.scripting.executeScript.mockImplementation(async ({ func }) => [{ result: await func(chatgptPage(), CHATGPT_URL, 0) }]);
  });

  it("reads the page with the real reader and hands Hubble its messages, in order, once", async () => {
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws-physics" } });
    expect(answer).toMatchObject({ ok: true, result: { outcome: "added" } });
    expect(answer.result).not.toHaveProperty("olderNotLoaded");
    expect(pageRequests).toEqual([
      expect.objectContaining({
        kind: "capture",
        args: {
          workspaceId: "ws-physics",
          capture: {
            url: CHATGPT_URL,
            title: "Admissions Strategy Assessment",
            turns: [
              { role: "user", text: "What caused WW1?" },
              { role: "assistant", text: "Militarism and alliances." },
            ],
          },
        },
      }),
    ]);
  });

  it("saves what is on screen and tells the popup when older messages had not loaded", async () => {
    chrome.scripting.executeScript.mockImplementation(async ({ func }) => [{ result: await func(chatgptPage("Loading older messages…"), CHATGPT_URL, 0) }]);
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws-physics" } });
    expect(answer).toMatchObject({ ok: true, result: { outcome: "added", olderNotLoaded: true } });
    expect(pageRequests).toHaveLength(1);
  });

  it("asks Hubble to save nothing when the page sends back something malformed", async () => {
    for (const result of [{ ok: true, turns: "What caused WW1?" }, { ok: true, turns: [{ role: "system", text: "x" }] }, { ok: false, reason: "something-new" }]) {
      chrome.scripting.executeScript.mockResolvedValue([{ result }]);
      expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "invalid" });
    }
    expect(pageRequests).toEqual([]);
  });

  it("says the page could not be read when the script fails or answers nothing", async () => {
    chrome.scripting.executeScript.mockRejectedValue(new Error("Cannot access contents of the page."));
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "page-unreadable" });
    chrome.scripting.executeScript.mockResolvedValue([]);
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "page-unreadable" });
    expect(pageRequests).toEqual([]);
  });

  it("says read-failed, not that Chrome blocked the page, when the reader itself throws", async () => {
    const broken = { title: "", querySelectorAll: () => { throw new TypeError("boom"); } };
    chrome.scripting.executeScript.mockImplementation(async ({ func }) => [{ result: await func(broken, CHATGPT_URL, 0) }]);
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "read-failed" });
    expect(pageRequests).toEqual([]);
  });

  it("tells an empty conversation apart from one it cannot read", async () => {
    const empty = document.implementation.createHTMLDocument("ChatGPT");
    empty.body.innerHTML = `<main><div data-thread-find-target="conversation"><div></div></div></main>`;
    chrome.scripting.executeScript.mockImplementation(async ({ func }) => [{ result: await func(empty, CHATGPT_URL, 0) }]);
    expect(await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } })).toEqual({ ok: false, error: "empty-conversation" });
    expect(pageRequests).toEqual([]);
  });
});

describe("Save to Hubble on Claude, Gemini and Perplexity, signed in (2026-10-16)", () => {
  /** executeScript runs the real reader against a page reduced to the app's structure. */
  function serve(url, title, html) {
    const doc = document.implementation.createHTMLDocument(title);
    doc.body.innerHTML = html;
    chrome.tabs.get.mockImplementation(async (id) => fakeTab({ id, url, title }));
    chrome.scripting.executeScript.mockImplementation(async ({ func }) => [{ result: await func(doc, url, 0) }]);
  }
  const claudeRow = (index, fromTail, inner) => `<div data-testid="transcript-row" data-index="${index}" data-perf-row-from-tail="${fromTail}">${inner}</div>`;
  const claudeReply = (text) => `<div data-testid="assistant-message"><h2 class="sr-only">Claude responded: ${text}</h2><div data-find-omitted="" data-state="closed">Thought for 2 seconds</div><div data-perf-reply-text="" class="standard-markdown"><p>${text}</p></div></div>`;

  it.each([
    ["Claude", "https://claude.ai/chat/446f8e09-fd3c-43b5-a8fa-5c5861dfb044", "Thesis feedback - Claude", claudeRow(0, 1, `<div data-testid="user-message"><p>What caused WW1?</p></div>`) + claudeRow(1, 0, claudeReply("Militarism and alliances."))],
    ["Gemini", "https://gemini.google.com/app/ed0431c2728ddb16", "Causes of WW1 - Google Gemini", `<user-query><div class="query-text"><h5 class="cdk-visually-hidden">You said What caused WW1?</h5><p>What caused WW1?</p></div></user-query><model-response><message-content><div class="markdown"><p>Militarism and alliances.</p></div></message-content></model-response>`],
    ["Perplexity", "https://www.perplexity.ai/search/07f15fc6-ef25-4f50-aa41-4a551474a5b0", "What caused WW1?", `<div data-workflow-entry="0"><div data-message-bubble="right"><p>What caused WW1?</p></div></div><div data-workflow-final-text=""><div class="prose"><p>Militarism and alliances.</p></div></div>`],
  ])("%s: hands Hubble the question and the reply, at the conversation's own address", async (_name, url, title, html) => {
    serve(url, title, html);
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws-history" } });
    expect(answer).toMatchObject({ ok: true, result: { outcome: "added" } });
    expect(answer.result).not.toHaveProperty("partial");
    expect(pageRequests).toEqual([
      expect.objectContaining({
        kind: "capture",
        args: { workspaceId: "ws-history", capture: { url, title, turns: [{ role: "user", text: "What caused WW1?" }, { role: "assistant", text: "Militarism and alliances." }] } },
      }),
    ]);
  });

  it("saves what a long Claude chat has on the page and tells the popup it was only part", async () => {
    serve("https://claude.ai/chat/ad3e4ff2-7bbc-49c2-aa96-f24622d1409c", "Long chat - Claude", claudeRow(13, 1, `<div data-testid="user-message"><p>And then?</p></div>`) + claudeRow(14, 0, claudeReply("Then it ended.")));
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: "ws" } });
    expect(answer).toMatchObject({ ok: true, result: { outcome: "added", partial: true } });
    expect(answer.result).not.toHaveProperty("olderNotLoaded");
    expect(pageRequests).toHaveLength(1);
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
