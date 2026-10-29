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

const STUDENT_A = "student-a-0000000001";
const STUDENT_B = "student-b-0000000002";

async function command(action, args, sender = HUBBLE_PAGE, owner = STUDENT_A) {
  await import("./background.js");
  return new Promise((resolve) => {
    const kept = listeners.map((fn) => fn({ type: MSG_BROWSER_COMMAND, payload: { id: "c1", action, args: { ...args, owner } } }, sender, resolve));
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
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: STUDENT_A };
    await import("./background.js");
    for (const tab of openTabs) for (const fn of updated) fn(tab.id, { status: "complete" }, tab);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = await command("get_context_activity", {});
    expect(answer.ok).toBe(true);
    expect(answer.result.records.map((record) => record.title)).toEqual(["Sugar tax - Wikipedia"]);
    expect(answer.result.openUrls).toEqual(["https://en.wikipedia.org/wiki/Sugar_tax"]);
    expect(JSON.stringify(answer)).not.toContain("Private subject");
  });

  it("turning detection on notices the tabs already open, and still skips the sensitive one", async () => {
    await command("set_context_settings", { settings: { mode: "auto", decidedAt: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const answer = await command("get_context_activity", {});
    expect(answer.result.records.map((record) => record.title)).toEqual(["Sugar tax - Wikipedia"]);
  });

  it("a Hubble tab in a private window can't read or change context", async () => {
    const privateTab = { ...HUBBLE_PAGE, tab: { ...HUBBLE_PAGE.tab, incognito: true } };
    expect((await command("get_context_activity", {}, privateTab)).ok).toBe(false);
    expect((await command("set_context_settings", { settings: { mode: "auto" } }, privateTab)).ok).toBe(false);
  });

  it("another Hubble account on the same Chrome gets nothing, and its own opt-in clears the first one's activity", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: STUDENT_A, excludedHosts: ["example.org"] };
    await import("./background.js");
    for (const fn of updated) fn(1, { status: "complete" }, openTabs[0]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await command("get_context_activity", {}, HUBBLE_PAGE, STUDENT_A)).result.records).toHaveLength(1);

    const asB = await command("get_context_activity", {}, HUBBLE_PAGE, STUDENT_B);
    expect(asB.result).toMatchObject({ records: [], openUrls: [] });
    const settingsForB = await command("get_context_settings", {}, HUBBLE_PAGE, STUDENT_B);
    expect(settingsForB.result).toMatchObject({ otherAccount: true, settings: { mode: "off" } });
    expect(settingsForB.result.settings.decidedAt).toBeUndefined();
    expect(JSON.stringify(settingsForB)).not.toContain("example.org");
    expect((await command("forget_context_activity", { keys: ["en.wikipedia.org/wiki/Sugar_tax"] }, HUBBLE_PAGE, STUDENT_B)).result).toEqual({ forgotten: 0 });
    expect((await command("capture_context_conversation", { url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001", workspaceId: "p" }, HUBBLE_PAGE, STUDENT_B)).result).toMatchObject({ ok: false, error: "not-yours" });

    // B opts in: A's activity is gone before anything is kept for B, and A's choices don't carry over.
    await command("set_context_settings", { settings: { mode: "auto", decidedAt: 2 } }, HUBBLE_PAGE, STUDENT_B);
    expect(local[CONTEXT_SETTINGS_KEY]).toMatchObject({ owner: STUDENT_B, decidedAt: 2, excludedHosts: [] });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const forB = await command("get_context_activity", {}, HUBBLE_PAGE, STUDENT_B);
    expect(forB.result.records.every((record) => record.firstSeenAt >= 0)).toBe(true);
    expect((await command("get_context_activity", {}, HUBBLE_PAGE, STUDENT_A)).result.records).toEqual([]);
  });

  it("keeps a setting only through readContextSettings", async () => {
    const answer = await command("set_context_settings", { settings: { mode: "sites", categories: ["research", "everything"], readConversations: ["grok"] } });
    expect(answer.result.settings).toMatchObject({ mode: "sites", categories: ["research"], readConversations: [] });
    expect(local[CONTEXT_SETTINGS_KEY]).toMatchObject({ mode: "sites" });
  });
});
