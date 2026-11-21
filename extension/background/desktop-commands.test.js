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
