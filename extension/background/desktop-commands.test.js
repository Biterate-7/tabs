// Commands from Hubble Desktop, through the real background.js with only
// chrome.* and the loopback bridge faked: Hubble opens its wake address, this
// worker closes that tab, collects what Hubble queued on the paired link, runs
// each through the same allowlist and validator as a page's command, and hands
// the answer back. Rust's half is tested in src-tauri/src/extension_link.rs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairedDesktopFetch, pairedStorage } from "../test-support/paired-desktop.js";

const WAKE = "http://127.0.0.1:41517/v1/wake";

let updatedListeners;
let local;

function tab(over) {
  return { id: 1, windowId: 10, index: 0, url: "https://example.com/", title: "Example", status: "complete", pinned: false, active: false, incognito: false, ...over };
}

function installChrome(storage) {
  local = storage;
  updatedListeners = [];
  globalThis.chrome = {
    runtime: { id: "hubble-extension", onMessage: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(async () => [tab({ id: 1, url: "https://a.example/", title: "A" }), tab({ id: 2, url: "https://b.example/", title: "B" })]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(async () => {}),
      get: vi.fn(async (id) => tab({ id })),
      sendMessage: vi.fn(async () => undefined),
      onUpdated: { addListener: vi.fn((fn) => updatedListeners.push(fn)), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: { getAll: vi.fn(async () => []), get: vi.fn(), update: vi.fn() },
    permissions: { contains: vi.fn(async () => false) },
    history: { search: vi.fn(async () => [{ url: "https://seen.example/", title: "Seen", lastVisitTime: 5, visitCount: 2 }]), deleteUrl: vi.fn(async () => {}) },
    storage: {
      session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) },
      local: {
        get: vi.fn(async (key) => (typeof key === "string" ? (key in local ? { [key]: local[key] } : {}) : {})),
        set: vi.fn(async (items) => Object.assign(local, items)),
        remove: vi.fn(async (key) => delete local[key]),
      },
    },
  };
}

/** Chrome reporting that a tab navigated to `url`, to every module-scope listener. */
function navigate(tabId, url) {
  for (const listener of updatedListeners) listener(tabId, { url, status: "loading" }, tab({ id: tabId, url }));
}

beforeEach(() => {
  installChrome(pairedStorage());
});

afterEach(() => {
  // A collecting worker stops at its next round: with no chrome.storage, it finds no link.
  delete globalThis.chrome;
  vi.resetModules();
});

describe("Commands from Hubble Desktop", () => {
  it("closes the wake tab, runs what Hubble queued and answers over the link", async () => {
    globalThis.fetch = pairedDesktopFetch({
      commands: [
        { id: "c1", action: "list_browser_tabs", args: {} },
        { id: "c2", action: "get_history", args: { startTime: 0, maxResults: 10 } },
      ],
    });
    await import("./background.js");
    navigate(77, WAKE);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(77);
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: WAKE });
    await vi.waitFor(() => expect(fetch.results).toHaveLength(2), { timeout: 3000 });
    const byId = Object.fromEntries(fetch.results.map((result) => [result.id, result]));
    expect(byId.c1).toMatchObject({ ok: true, result: { tabs: [expect.objectContaining({ url: "https://a.example/" }), expect.objectContaining({ url: "https://b.example/" })] } });
    expect(byId.c2).toMatchObject({ id: "c2", ok: true, result: { items: [{ url: "https://seen.example/", title: "Seen", lastVisitTime: 5, visitCount: 2 }] } });
    // Hubble proved itself (no token sent) before the first collect; every collect and answer carried the token.
    const calls = fetch.mock.calls.filter(([url]) => /\/v1\/link\//.test(url)).map(([url, init]) => [new URL(url).pathname, init.headers.authorization]);
    expect(calls[0]).toEqual(["/v1/link/prove", undefined]);
    for (const [pathname, authorization] of calls) {
      expect(authorization, pathname).toBe(pathname === "/v1/link/prove" ? undefined : `Bearer ${"a".repeat(64)}`);
    }
  });

  it("drops what is not on its allowlist and refuses bad arguments, without touching Chrome", async () => {
    globalThis.fetch = pairedDesktopFetch({
      commands: [
        { id: "d1", action: "close_tabs", args: { tabIds: [1, 2] } },
        { id: "d2", action: "get_history", args: { startTime: "yesterday" } },
        { id: "d3", action: "open_url", args: { url: "javascript:alert(1)" } },
      ],
    });
    await import("./background.js");
    navigate(78, WAKE);
    await vi.waitFor(() => expect(fetch.results).toHaveLength(2), { timeout: 3000 });
    expect(fetch.results.map((result) => [result.id, result.ok])).toEqual(
      expect.arrayContaining([
        ["d2", false],
        ["d3", false],
      ])
    );
    expect(fetch.results.some((result) => result.id === "d1")).toBe(false);
    expect(chrome.history.search).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    // Only the wake tab was closed.
    expect(chrome.tabs.remove.mock.calls).toEqual([[78]]);
  });

  it("acts on context commands for the account Hubble Desktop names, without asking a website who is signed in", async () => {
    globalThis.fetch = pairedDesktopFetch({ commands: [{ id: "e1", action: "get_context_settings", args: { account: "user-1" } }] });
    await import("./background.js");
    navigate(79, WAKE);
    await vi.waitFor(() => expect(fetch.results).toHaveLength(1), { timeout: 3000 });
    expect(fetch.results[0]).toMatchObject({ id: "e1", ok: true, result: { settings: expect.objectContaining({ mode: "off" }) } });
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/api/auth/me"))).toBe(false);
  });

  it("keeps context detection for the account Hubble Desktop turned it on for, and answers that account's pulls", async () => {
    globalThis.fetch = pairedDesktopFetch({
      commands: [{ id: "a1", action: "set_context_settings", args: { settings: { mode: "auto", decidedAt: 1 }, account: null } }],
    });
    await import("./background.js");
    navigate(82, WAKE);
    await vi.waitFor(() => expect(fetch.results).toHaveLength(1), { timeout: 3000 });
    expect(fetch.results[0]).toMatchObject({ id: "a1", ok: true, result: { settings: { mode: "auto" } } });
    // Stored with the desktop owner — a settings reader that drops it would make every later pull come back empty.
    expect(local.hubble_context_settings.owner).toMatch(/^desktop:[0-9a-f]{64}$/);
    fetch.queue({ id: "a2", action: "get_context_settings", args: { account: null } }, { id: "a3", action: "get_context_settings", args: { account: "someone-else" } });
    await vi.waitFor(() => expect(fetch.results).toHaveLength(3), { timeout: 3000 });
    const byId = Object.fromEntries(fetch.results.map((result) => [result.id, result]));
    expect(byId.a2.result).toMatchObject({ settings: { mode: "auto" } });
    expect(byId.a2.result.otherAccount).toBeFalsy();
    // Another account named by the app isn't shown this one's choice.
    expect(byId.a3.result).toMatchObject({ otherAccount: true, settings: { mode: "off" } });
  });

  it("reads a YouTube video's transcript from the tab showing it — and a slow read never holds up the next command", async () => {
    const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    let release;
    chrome.scripting = {
      executeScript: vi.fn(
        ({ target, args }) =>
          new Promise((resolve) => {
            release = () => resolve([{ result: { ok: true, videoId: args[0], segments: [{ start: 18, text: "We're no strangers to love" }] } }]);
            expect(target).toEqual({ tabId: 5 });
          })
      ),
    };
    chrome.tabs.query.mockResolvedValue([tab({ id: 5, url: VIDEO, active: true })]);
    globalThis.fetch = pairedDesktopFetch({ commands: [{ id: "b1", action: "read_youtube_transcript", args: { videoId: "dQw4w9WgXcQ" } }] });
    await import("./background.js");
    navigate(83, WAKE);
    await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalled(), { timeout: 3000 });
    // While the page is being read, Hubble asks something else: it is answered at once.
    fetch.queue({ id: "b2", action: "list_browser_windows", args: {} });
    await vi.waitFor(() => expect(fetch.results.map((result) => result.id)).toEqual(["b2"]), { timeout: 3000 });
    release();
    await vi.waitFor(() => expect(fetch.results).toHaveLength(2), { timeout: 3000 });
    expect(fetch.results[1]).toEqual({ id: "b1", ok: true, result: { ok: true, videoId: "dQw4w9WgXcQ", segments: [{ start: 18, text: "We're no strangers to love" }], via: "open-tab" } });
    // Read where it was open: no tab opened or closed for it.
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove.mock.calls).toEqual([[83]]);
  });

  it("opens nothing for a transcript without the person's permission for youtube.com, and says so", async () => {
    chrome.scripting = { executeScript: vi.fn() };
    globalThis.fetch = pairedDesktopFetch({
      commands: [
        { id: "c3", action: "read_youtube_transcript", args: { videoId: "dQw4w9WgXcQ" } },
        { id: "c4", action: "read_youtube_transcript", args: { videoId: "https://evil.example/" } },
      ],
    });
    await import("./background.js");
    navigate(84, WAKE);
    await vi.waitFor(() => expect(fetch.results).toHaveLength(2), { timeout: 3000 });
    const byId = Object.fromEntries(fetch.results.map((result) => [result.id, result]));
    expect(byId.c3).toEqual({ id: "c3", ok: true, result: { ok: false, reason: "no-access" } });
    expect(byId.c4).toMatchObject({ id: "c4", ok: false });
    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ["https://www.youtube.com/*"] });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("asks for youtube.com in its own permission window, and answers with what Chrome granted", async () => {
    chrome.runtime.getURL = (page) => `chrome-extension://hubble-extension/${page}`;
    chrome.windows.create = vi.fn(async () => ({ id: 900 }));
    chrome.windows.onRemoved = { addListener: vi.fn(), removeListener: vi.fn() };
    let granted = false;
    chrome.permissions.contains = vi.fn(async () => granted);
    const added = [];
    chrome.permissions.onAdded = { addListener: vi.fn((fn) => added.push(fn)), removeListener: vi.fn() };
    globalThis.fetch = pairedDesktopFetch({ commands: [{ id: "c5", action: "request_youtube_access", args: {} }] });
    await import("./background.js");
    navigate(85, WAKE);
    await vi.waitFor(() => expect(chrome.windows.create).toHaveBeenCalled(), { timeout: 3000 });
    const asked = new URL(chrome.windows.create.mock.calls[0][0].url, "chrome-extension://hubble-extension/");
    expect(asked.pathname).toMatch(/grant\.html$/);
    expect(asked.searchParams.get("provider")).toBe("youtube");
    expect(asked.searchParams.get("purpose")).toBe("youtube");
    granted = true;
    for (const fn of added) fn({ origins: ["https://www.youtube.com/*"] });
    await vi.waitFor(() => expect(fetch.results).toHaveLength(1), { timeout: 3000 });
    expect(fetch.results[0]).toEqual({ id: "c5", ok: true, result: { granted: true, answer: "granted" } });
  });

  it("collects nothing when it isn't paired, and ignores addresses that only look like the wake", async () => {
    installChrome({});
    globalThis.fetch = pairedDesktopFetch({ commands: [{ id: "f1", action: "list_browser_tabs", args: {} }] });
    await import("./background.js");
    navigate(80, "http://127.0.0.1:8080/v1/wake");
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    navigate(81, WAKE);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(81);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/v1/link/commands"))).toBe(false);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
});
