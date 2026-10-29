// Context detection through the real background.js, with only chrome.* mocked:
// who may ask, what a tab event records, and what is said while detection is off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSG_BROWSER_COMMAND, TABDUMP_ORIGIN } from "../src/config.js";
import { CONTEXT_SETTINGS_KEY } from "../src/context-activity.js";

const EXTENSION_ID = "hubble-extension";
const HUBBLE_PAGE = { id: EXTENSION_ID, url: `${TABDUMP_ORIGIN}/`, frameId: 0, tab: { id: 7, url: `${TABDUMP_ORIGIN}/` } };

let listeners;
let updated;
let local;
let openTabs;

beforeEach(() => {
  listeners = [];
  updated = [];
  local = {};
  openTabs = [
    { id: 1, windowId: 1, url: "https://en.wikipedia.org/wiki/Sugar_tax", title: "Sugar tax - Wikipedia", incognito: false, status: "complete" },
    { id: 2, windowId: 1, url: "https://mail.google.com/mail/u/0/", title: "Inbox (3) - Private subject", incognito: false, status: "complete" },
  ];
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  globalThis.chrome = {
    runtime: { id: EXTENSION_ID, onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) }, getManifest: () => ({ version: "0.10.0" }) },
    tabs: {
      query: vi.fn(async (query) => (query?.url ? [] : openTabs)),
      get: vi.fn(async (id) => openTabs.find((tab) => tab.id === id)),
      create: vi.fn(),
      update: vi.fn(),
      sendMessage: vi.fn(async () => undefined),
      onUpdated: { addListener: vi.fn((fn) => updated.push(fn)), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    windows: { update: vi.fn(), onFocusChanged: { addListener: vi.fn() }, WINDOW_ID_NONE: -1 },
    permissions: { contains: vi.fn(async () => false), onRemoved: { addListener: vi.fn() }, onAdded: { addListener: vi.fn(), removeListener: vi.fn() } },
    scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: structuredClone(local[key]) })),
        set: vi.fn(async (items) => Object.assign(local, structuredClone(items))),
      },
      session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) },
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
});

async function command(action, args, sender = HUBBLE_PAGE) {
  await import("./background.js");
  return new Promise((resolve) => {
    const kept = listeners.map((fn) => fn({ type: MSG_BROWSER_COMMAND, payload: { id: "c1", action, args } }, sender, resolve));
    if (!kept.includes(true)) resolve(undefined);
  });
}

describe("context detection in the service worker", () => {
  it("answers only Hubble's own page", async () => {
    const fromElsewhere = await command("get_context_activity", {}, { id: EXTENSION_ID, url: "https://evil.example/", frameId: 0, tab: { id: 9, url: "https://evil.example/" } });
    expect(fromElsewhere).toMatchObject({ ok: false, error: "Only Hubble can ask for this." });
    const fromAFrame = await command("get_context_activity", {}, { ...HUBBLE_PAGE, frameId: 3 });
    expect(fromAFrame.ok).toBe(false);
  });

  it("while off (the default) records nothing and reports no open tabs", async () => {
    await import("./background.js");
    for (const fn of updated) fn(1, { status: "complete" }, openTabs[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = await command("get_context_activity", {});
    expect(answer).toMatchObject({ ok: true, result: { records: [], openUrls: [] } });
    expect((await command("get_context_settings", {})).result.settings.mode).toBe("off");
  });

  it("once on, records a completed page — and never the sensitive one beside it", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1 };
    await import("./background.js");
    for (const tab of openTabs) for (const fn of updated) fn(tab.id, { status: "complete" }, tab);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = await command("get_context_activity", {});
    expect(answer.ok).toBe(true);
    expect(answer.result.records.map((record) => record.title)).toEqual(["Sugar tax - Wikipedia"]);
    expect(answer.result.openUrls).toEqual(["https://en.wikipedia.org/wiki/Sugar_tax"]);
    expect(JSON.stringify(answer)).not.toContain("Private subject");
  });

  it("keeps a setting only through readContextSettings", async () => {
    const answer = await command("set_context_settings", { settings: { mode: "sites", categories: ["research", "everything"], readConversations: ["grok"] } });
    expect(answer.result.settings).toMatchObject({ mode: "sites", categories: ["research"], readConversations: [] });
    expect(local[CONTEXT_SETTINGS_KEY]).toMatchObject({ mode: "sites" });
  });
});
