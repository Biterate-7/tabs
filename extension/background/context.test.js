// Context detection through the real background.js, with only chrome.* mocked:
// who may ask, what a tab event records, and what is said while detection is off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSG_BROWSER_COMMAND, TABDUMP_ORIGIN } from "../src/config.js";
import { CONTEXT_SETTINGS_KEY } from "../src/context-activity.js";
import { ownerForAccount } from "../src/context-identity.js";

const EXTENSION_ID = "hubble-extension";
const HUBBLE_PAGE = { id: EXTENSION_ID, url: `${TABDUMP_ORIGIN}/`, frameId: 0, tab: { id: 7, url: `${TABDUMP_ORIGIN}/` } };

let listeners;
let updated;
let local;
let openTabs;
// Who Hubble's server says the browser is signed in as (its /api/auth/me, answered from the session cookie).
let session;
let serverDown;

beforeEach(() => {
  listeners = [];
  updated = [];
  local = {};
  openTabs = [
    { id: 1, windowId: 1, url: "https://en.wikipedia.org/wiki/Sugar_tax", title: "Sugar tax - Wikipedia", incognito: false, status: "complete" },
    { id: 2, windowId: 1, url: "https://mail.google.com/mail/u/0/", title: "Inbox (3) - Private subject", incognito: false, status: "complete" },
  ];
  session = STUDENT_A;
  serverDown = false;
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).endsWith("/api/auth/me") && init?.credentials === "include" && !serverDown) {
      return { ok: true, status: 200, json: async () => (session ? { authenticated: true, user: { id: session } } : { authenticated: false, user: null }) };
    }
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
const owner = (account) => ownerForAccount(account);
const MISSING = Symbol("no account claim");

/** A context command from Hubble's page, claiming `account` (by default, whoever is signed in). */
async function command(action, args, sender = HUBBLE_PAGE, account = session) {
  await import("./background.js");
  return new Promise((resolve) => {
    const claimed = account === MISSING ? { ...args } : { ...args, account };
    const kept = listeners.map((fn) => fn({ type: MSG_BROWSER_COMMAND, payload: { id: "c1", action, args: claimed } }, sender, resolve));
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
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: await owner(STUDENT_A) };
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
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: await owner(STUDENT_A), excludedHosts: ["example.org"] };
    await import("./background.js");
    for (const fn of updated) fn(1, { status: "complete" }, openTabs[0]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await command("get_context_activity", {})).result.records).toHaveLength(1);

    // Student B signs in on the same Chrome: the server now says B.
    session = STUDENT_B;
    const asB = await command("get_context_activity", {});
    expect(asB.result).toMatchObject({ records: [], openUrls: [] });
    const settingsForB = await command("get_context_settings", {});
    expect(settingsForB.result).toMatchObject({ otherAccount: true, settings: { mode: "off" } });
    expect(settingsForB.result.settings.decidedAt).toBeUndefined();
    expect(JSON.stringify(settingsForB)).not.toContain("example.org");
    expect((await command("forget_context_activity", { keys: ["en.wikipedia.org/wiki/Sugar_tax"] })).result).toEqual({ forgotten: 0 });
    expect((await command("clear_context_activity", {})).result).toEqual({ epoch: "not-yours" });
    expect((await command("capture_context_conversation", { url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001", workspaceId: "p" })).result).toMatchObject({ ok: false, error: "not-yours" });

    // B opts in: A's activity is gone before anything is kept for B, and A's choices don't carry over.
    await command("set_context_settings", { settings: { mode: "auto", decidedAt: 2 } });
    expect(local[CONTEXT_SETTINGS_KEY]).toMatchObject({ owner: await owner(STUDENT_B), decidedAt: 2, excludedHosts: [] });
    // Signed back in as A: nothing of A's is left, and A's choices are not B's.
    session = STUDENT_A;
    expect((await command("get_context_activity", {})).result.records).toEqual([]);
    expect((await command("get_context_settings", {})).result.otherAccount).toBe(true);
  });

  it("a page can't act for an account the browser isn't signed in as, whatever it claims", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: await owner(STUDENT_A) };
    session = STUDENT_B;
    // A script on Hubble's origin claiming A while the session is B: refused, for reads and writes alike.
    for (const [action, args] of [
      ["get_context_activity", {}],
      ["get_context_settings", {}],
      ["set_context_settings", { settings: { mode: "off" } }],
      ["forget_context_activity", { keys: ["k"] }],
      ["clear_context_activity", {}],
      ["capture_context_conversation", { url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001", workspaceId: "p" }],
    ]) {
      expect([action, await command(action, args, HUBBLE_PAGE, STUDENT_A)]).toEqual([action, { id: "c1", ok: false, error: "identity-mismatch" }]);
    }
    expect(local[CONTEXT_SETTINGS_KEY].owner).toBe(await owner(STUDENT_A));
    // Signed out, claiming A: refused too.
    session = null;
    expect((await command("get_context_activity", {}, HUBBLE_PAGE, STUDENT_A)).error).toBe("identity-mismatch");
  });

  it("a missing or malformed account claim, or Hubble unreachable, fails closed", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: await owner(STUDENT_A) };
    expect((await command("get_context_activity", {}, HUBBLE_PAGE, MISSING)).ok).toBe(false);
    expect((await command("get_context_activity", {}, HUBBLE_PAGE, "not an id!")).ok).toBe(false);
    serverDown = true;
    expect(await command("clear_context_activity", {})).toEqual({ id: "c1", ok: false, error: "identity-unverified" });
    expect(local[CONTEXT_SETTINGS_KEY].owner).toBe(await owner(STUDENT_A));
  });

  it("stores a hash of the account, never the account id itself", async () => {
    await command("set_context_settings", { settings: { mode: "auto", decidedAt: 1 } });
    expect(local[CONTEXT_SETTINGS_KEY].owner).toMatch(/^user:[0-9a-f]{64}$/);
    expect(JSON.stringify(local)).not.toContain(STUDENT_A);
  });

  it("a choice with no confirmed owner (an older build) is never inherited: opting in clears it", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: "random-legacy-owner-01" };
    await import("./background.js");
    for (const fn of updated) fn(1, { status: "complete" }, openTabs[0]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await command("get_context_activity", {})).result.records).toEqual([]);
    const before = local.hubble_context_activity?.epoch;
    await command("set_context_settings", { settings: { mode: "auto", decidedAt: 2 } });
    expect(local.hubble_context_activity.epoch).not.toBe(before);
  });

  it("an account switch during a save's read never hands the text to the next account", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: await owner(STUDENT_A), readConversations: ["chatgpt"] };
    const chat = { id: 3, windowId: 1, url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001", title: "Sugar tax", incognito: false, status: "complete" };
    openTabs.push(chat);
    chrome.permissions.contains.mockResolvedValue(true);
    chrome.scripting.executeScript.mockImplementation(async () => {
      // Student B signs in while A's conversation is being read.
      session = STUDENT_B;
      return [{ result: { ok: true, provider: "chatgpt", url: chat.url, title: "Sugar tax", turns: [{ role: "user", text: "SYNTHETIC private question" }, { role: "assistant", text: "SYNTHETIC answer" }] } }];
    });
    chrome.tabs.query.mockImplementation(async (query) => (query?.url ? [{ id: 7, url: `${TABDUMP_ORIGIN}/`, status: "complete" }] : openTabs));
    const answer = await command("capture_context_conversation", { url: chat.url, workspaceId: "project-of-a" });
    expect(answer.result).toMatchObject({ ok: false, error: "identity-changed" });
    // Nothing was offered to the Hubble page now signed in as B, and the text isn't kept.
    expect(chrome.tabs.sendMessage.mock.calls.filter(([, message]) => message?.type === "HUBBLE_PAGE_REQUEST")).toEqual([]);
    expect(JSON.stringify(local)).not.toContain("SYNTHETIC private question");
  });

  it("signed-out Hubble is its own identity, apart from any account", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: await owner(STUDENT_A) };
    session = null;
    expect((await command("get_context_settings", {})).result.otherAccount).toBe(true);
    expect((await command("get_context_activity", {})).result.records).toEqual([]);
  });

  it("never saves a conversation from a site the person excluded", async () => {
    local[CONTEXT_SETTINGS_KEY] = { version: 1, mode: "auto", decidedAt: 1, owner: await owner(STUDENT_A), excludedHosts: ["chatgpt.com"] };
    const answer = await command("capture_context_conversation", { url: "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001", workspaceId: "p" });
    expect(answer.result).toEqual({ ok: false, error: "excluded" });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("keeps a setting only through readContextSettings", async () => {
    const answer = await command("set_context_settings", { settings: { mode: "sites", categories: ["research", "everything"], readConversations: ["grok"] } });
    expect(answer.result.settings).toMatchObject({ mode: "sites", categories: ["research"], readConversations: [] });
    expect(local[CONTEXT_SETTINGS_KEY]).toMatchObject({ mode: "sites" });
  });
});
