// Context detection's collector: what is recorded, when, and what never is —
// driven with injected storage and a hand-wound clock, no Chrome.
import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_ACTIVITY_KEY,
  CONTEXT_SETTINGS_KEY,
  MAX_DWELL_PER_VISIT_MS,
  VISIT_GAP_MS,
  WRITE_DELAY_MS,
  contentHashOf,
  conversationTerms,
  createActivityCollector,
  readContextSettings,
} from "./context-activity.js";

const HUBBLE = "http://localhost:3000";
const CHAT = "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000001";

function harness({ settings = { mode: "auto" }, granted = [], read } = {}) {
  const data = new Map([[CONTEXT_SETTINGS_KEY, readContextSettings(settings)]]);
  const session = new Map();
  const timers = [];
  let now = Date.UTC(2026, 9, 28, 10, 0, 0);
  let epochs = 0;
  const tabs = new Map();
  const storage = {
    get: vi.fn(async (key) => structuredClone(data.get(key))),
    set: vi.fn(async (key, value) => void data.set(key, structuredClone(value))),
  };
  const deps = {
    storage,
    sessionStorage: { get: async (key) => session.get(key), set: async (key, value) => void session.set(key, value) },
    now: () => now,
    newEpoch: () => `epoch-${++epochs}`,
    hubbleOrigin: HUBBLE,
    hasHostPermission: vi.fn(async (provider) => granted.includes(provider)),
    readConversation: vi.fn(read ?? (async () => ({ ok: false, reason: "no-messages" }))),
    getTab: vi.fn(async (id) => tabs.get(id)),
    schedule: (fn, ms) => {
      const timer = { fn, at: now + ms, done: false };
      timers.push(timer);
      return () => (timer.done = true);
    },
    notify: vi.fn(),
    log: vi.fn(),
  };
  const make = () => createActivityCollector(deps);
  const collector = make();
  return {
    collector,
    make,
    deps,
    data,
    tabs,
    advance: async (ms) => {
      now += ms;
      for (const timer of timers) {
        if (!timer.done && timer.at <= now) {
          timer.done = true;
          timer.fn();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    stored: () => data.get(CONTEXT_ACTIVITY_KEY),
    tab: (id, url, title, extra = {}) => {
      const tab = { id, url, title, windowId: 1, incognito: false, ...extra };
      tabs.set(id, tab);
      return tab;
    },
  };
}

describe("what is recorded", () => {
  it("records nothing until the person chooses (manual mode is the default)", async () => {
    const h = harness({ settings: {} });
    expect(await h.collector.observe(h.tab(1, "https://en.wikipedia.org/wiki/Sugar_tax", "Sugar tax - Wikipedia"))).toBeUndefined();
    await h.advance(WRITE_DELAY_MS);
    expect((await h.collector.list()).records).toEqual([]);
  });

  it("records an ordinary page's address and title — metadata, never more", async () => {
    const h = harness();
    const record = await h.collector.observe(h.tab(1, "https://en.wikipedia.org/wiki/Sugar_tax#History", "Sugar tax - Wikipedia", { favIconUrl: "https://en.wikipedia.org/favicon.ico" }));
    expect(record).toMatchObject({
      key: "en.wikipedia.org/wiki/Sugar_tax",
      title: "Sugar tax - Wikipedia",
      domain: "en.wikipedia.org",
      kind: "article",
      favicon: "https://en.wikipedia.org/favicon.ico",
      capture: { status: "metadata", method: "tab-metadata" },
      visits: 1,
    });
    expect(record.terms).toBeUndefined();
  });

  it("never records sensitive sites, private windows, Hubble itself or this computer", async () => {
    const h = harness();
    for (const [url, extra] of [
      ["https://mail.google.com/mail/u/0/#inbox/abc", {}],
      ["https://www.mybank.co.uk/accounts", {}],
      ["https://example.org/login", {}],
      ["https://en.wikipedia.org/wiki/Tax", { incognito: true }],
      [`${HUBBLE}/`, {}],
      ["http://localhost:8080/dev", {}],
      ["http://192.168.1.4/router", {}],
      ["chrome://settings", {}],
      ["file:///C:/notes.txt", {}],
    ]) {
      expect(await h.collector.observe(h.tab(9, url, "Something", extra))).toBeUndefined();
    }
    expect((await h.collector.list()).records).toEqual([]);
  });

  it("in chosen-sites mode, records only the chosen kinds of site", async () => {
    const h = harness({ settings: { mode: "sites", categories: ["ai"] } });
    expect(await h.collector.observe(h.tab(1, "https://en.wikipedia.org/wiki/Tax", "Tax"))).toBeUndefined();
    expect(await h.collector.observe(h.tab(2, CHAT, "Sugar tax effectiveness"))).toMatchObject({ kind: "conversation", provider: "chatgpt" });
  });

  it("a paused collector records nothing; a timed pause ends by itself", async () => {
    const h = harness({ settings: { mode: "auto", paused: true, pausedUntil: Date.UTC(2026, 9, 28, 11, 0, 0) } });
    expect(await h.collector.observe(h.tab(1, "https://arxiv.org/abs/2401.0001", "A paper"))).toBeUndefined();
    await h.advance(61 * 60 * 1000);
    expect(await h.collector.observe(h.tab(1, "https://arxiv.org/abs/2401.0001", "A paper"))).toBeDefined();
  });
});

describe("one record per page", () => {
  it("repeated events, reloads and tracking parameters update one record, and only what changed is written", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://www.tutor2u.net/economics/tax?utm_source=x", "Indirect taxes | tutor2u"));
    await h.collector.observe(h.tab(1, "https://tutor2u.net/economics/tax/", "Indirect taxes | tutor2u"));
    await h.collector.observe(h.tab(2, "https://tutor2u.net/economics/tax", "Indirect taxes | tutor2u"));
    await h.advance(WRITE_DELAY_MS);
    const { records } = await h.collector.list();
    expect(records).toHaveLength(1);
    const writes = h.deps.storage.set.mock.calls.filter(([key]) => key === CONTEXT_ACTIVITY_KEY).length;
    expect(writes).toBe(1);
  });

  it("keeps the real title over the address Chrome shows while loading", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://ourworldindata.org/obesity", "ourworldindata.org/obesity"));
    expect((await h.collector.list()).records[0]).toMatchObject({ title: "", capture: { status: "detected" } });
    await h.collector.observe(h.tab(1, "https://ourworldindata.org/obesity", "Obesity - Our World in Data"));
    expect((await h.collector.list()).records[0]).toMatchObject({ title: "Obesity - Our World in Data", capture: { status: "metadata" } });
  });

  it("debounces a burst of title changes into one observation", async () => {
    const h = harness();
    const tab = h.tab(1, CHAT, "ChatGPT");
    for (const title of ["Sugar", "Sugar tax", "Sugar tax effectiveness"]) {
      tab.title = title;
      h.collector.observeTitleChange(1, 1500);
      await h.advance(500);
    }
    await h.advance(1500);
    await h.advance(WRITE_DELAY_MS);
    const { records } = await h.collector.list();
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Sugar tax effectiveness");
    expect(h.deps.getTab).toHaveBeenCalledTimes(1);
  });

  it("counts a new visit only after a real gap, and time in front only up to a cap", async () => {
    const h = harness();
    const page = h.tab(1, "https://arxiv.org/abs/2401.0001", "A paper");
    const other = h.tab(2, "https://jstor.org/stable/123", "Another");
    await h.collector.observe(page, { activated: true });
    await h.advance(10 * 60 * 1000);
    await h.collector.observe(other, { activated: true });
    await h.advance(VISIT_GAP_MS + 1000);
    await h.collector.observe(page, { activated: true });
    await h.advance(5 * 60 * 60 * 1000);
    await h.collector.observe(other, { activated: true });
    const paper = (await h.collector.list()).records.find((record) => record.key === "arxiv.org/abs/2401.0001");
    expect(paper.visits).toBe(2);
    expect(paper.dwellMs).toBe(10 * 60 * 1000 + MAX_DWELL_PER_VISIT_MS);
  });
});

describe("found in real Chrome (2026-10-29)", () => {
  it("a page that loads in the tab already in front gets its time in front", async () => {
    const h = harness();
    // A new tab is activated while still blank, then the page loads in it: no switch ever names the page.
    await h.collector.observe(h.tab(1, "chrome://newtab/", "New Tab"), { activated: true });
    await h.collector.observe(h.tab(1, "https://ourworldindata.org/obesity", "Obesity | Our World in Data"), { inFront: true });
    await h.advance(20_000);
    await h.collector.observe(h.tab(2, "chrome://newtab/", "New Tab"), { activated: true });
    const [record] = (await h.collector.list()).records;
    expect(record.dwellMs).toBe(20_000);
  });

  it("a background tab finishing loading does not take the focus", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "One"), { activated: true });
    await h.collector.observe(h.tab(2, "https://arxiv.org/abs/2", "Two"));
    await h.advance(20_000);
    await h.collector.observe(h.tab(3, "chrome://newtab/", "New Tab"), { activated: true });
    const byKey = Object.fromEntries((await h.collector.list()).records.map((record) => [record.key, record.dwellMs]));
    expect(byKey).toEqual({ "arxiv.org/abs/1": 20_000, "arxiv.org/abs/2": 0 });
  });

  it("a redirect inside one tab is one page (Pigovian_tax → Pigouvian_tax)", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://en.wikipedia.org/wiki/Pigovian_tax", "Pigouvian tax - Wikipedia"), { inFront: true });
    await h.advance(1500);
    await h.collector.observe(h.tab(1, "https://en.wikipedia.org/wiki/Pigouvian_tax", "Pigouvian tax - Wikipedia"), { inFront: true });
    const { records } = await h.collector.list();
    expect(records.map((record) => record.key)).toEqual(["en.wikipedia.org/wiki/Pigouvian_tax"]);
  });

  it("an error page's title is not the page's: Chrome interstitials, rate limits, 404s", async () => {
    const h = harness();
    for (const title of ["Connect to Wi-Fi", "Privacy error", "Wikimedia Error", "Page not found", "Just a moment..."]) {
      await h.collector.observe(h.tab(1, "https://www.tutor2u.net/economics/reference/indirect-taxes", title));
    }
    expect((await h.collector.list()).records[0]).toMatchObject({ title: "", capture: { status: "detected" } });
    await h.collector.observe(h.tab(1, "https://www.tutor2u.net/economics/reference/indirect-taxes", "Indirect Taxes | tutor2u"));
    expect((await h.collector.list()).records[0].title).toBe("Indirect Taxes | tutor2u");
  });

  it("time in front is never more than the page has existed", async () => {
    const h = harness();
    // A focus record from long ago (a stale session value) must not credit hours to a page just seen.
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "One"), { activated: true });
    await h.advance(5000);
    await h.collector.observe(h.tab(2, "chrome://newtab/", "New Tab"), { activated: true });
    expect((await h.collector.list()).records[0].dwellMs).toBe(5000);
  });

  it("following a link to another page in the same tab is a new page", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://en.wikipedia.org/wiki/Pigouvian_tax", "Pigouvian tax - Wikipedia"), { inFront: true });
    await h.advance(3000);
    await h.collector.observe(h.tab(1, "https://en.wikipedia.org/wiki/Externality", "Externality - Wikipedia"), { inFront: true });
    expect((await h.collector.list()).records).toHaveLength(2);
  });
});

describe("reading conversations", () => {
  const turns = [
    { role: "user", text: "How effective is a sugar tax at reducing consumption? Think about externalities." },
    { role: "assistant", text: "A sugar tax corrects a negative externality by raising the price, which lowers consumption. Elasticity of demand matters: inelastic demand means the tax raises revenue but changes consumption less." },
    { role: "user", text: "And the market failure argument for the sugar tax?" },
  ];

  it("does not read unless the person turned reading on for that app", async () => {
    const h = harness({ granted: ["chatgpt"] });
    const tab = h.tab(1, CHAT, "Sugar tax effectiveness");
    await h.collector.observe(tab);
    expect(await h.collector.maybeReadConversation(tab)).toBe("not-enabled");
    expect(h.deps.readConversation).not.toHaveBeenCalled();
  });

  it("does not read without Chrome's permission, and says so", async () => {
    const h = harness({ settings: { mode: "auto", readConversations: ["chatgpt"] }, granted: [] });
    const tab = h.tab(1, CHAT, "Sugar tax effectiveness");
    await h.collector.observe(tab);
    expect(await h.collector.maybeReadConversation(tab)).toBe("no-permission");
    expect(h.deps.readConversation).not.toHaveBeenCalled();
    expect((await h.collector.list()).records[0].capture).toMatchObject({ status: "metadata", gap: "no-permission" });
  });

  it("keeps topic words, a count and a hash — never the text", async () => {
    const h = harness({ settings: { mode: "auto", readConversations: ["chatgpt"] }, granted: ["chatgpt"], read: async () => ({ ok: true, url: CHAT, title: "Sugar tax", turns }) });
    const tab = h.tab(1, CHAT, "Sugar tax effectiveness");
    await h.collector.observe(tab);
    expect(await h.collector.maybeReadConversation(tab)).toBe("read");
    await h.advance(WRITE_DELAY_MS);
    const [record] = (await h.collector.list()).records;
    expect(record.capture).toMatchObject({ status: "content", method: "page-read", turnCount: 3, contentHash: contentHashOf(turns) });
    expect(record.terms).toEqual(expect.arrayContaining(["sugar", "tax", "consumption"]));
    const everything = JSON.stringify(h.stored());
    expect(everything).not.toContain("How effective");
    expect(everything).not.toContain("inelastic demand means");
  });

  it("marks a partly loaded conversation as partial, and a layout it can't read as unavailable", async () => {
    const partial = harness({ settings: { mode: "auto", readConversations: ["claude"] }, granted: ["claude"], read: async () => ({ ok: true, turns, partial: true }) });
    const claude = partial.tab(1, "https://claude.ai/chat/0f6c90c2-0000-4000-8000-000000000001", "Sugar tax");
    await partial.collector.observe(claude);
    await partial.collector.maybeReadConversation(claude);
    expect((await partial.collector.list()).records[0].capture.status).toBe("partial");

    const broken = harness({ settings: { mode: "auto", readConversations: ["chatgpt"] }, granted: ["chatgpt"], read: async () => ({ ok: false, reason: "no-messages" }) });
    const tab = broken.tab(1, CHAT, "Sugar tax");
    await broken.collector.observe(tab);
    expect(await broken.collector.maybeReadConversation(tab)).toBe("layout");
    const [record] = (await broken.collector.list()).records;
    expect(record.capture).toMatchObject({ status: "unavailable", gap: "layout" });
    expect(record.terms).toBeUndefined();
  });

  it("keeps nothing when the tab moved to another conversation while it was read", async () => {
    const h = harness({ settings: { mode: "auto", readConversations: ["chatgpt"] }, granted: ["chatgpt"] });
    const tab = h.tab(1, CHAT, "Sugar tax");
    h.deps.readConversation.mockImplementation(async () => {
      tab.url = "https://chatgpt.com/c/6720a1b2-0000-4000-8000-000000000002";
      return { ok: true, turns };
    });
    await h.collector.observe(tab);
    expect(await h.collector.maybeReadConversation({ ...tab, url: CHAT })).toBe("moved");
    expect((await h.collector.list()).records[0].terms).toBeUndefined();
  });

  it("drops what was read when Chrome's permission is removed", async () => {
    const h = harness({ settings: { mode: "auto", readConversations: ["chatgpt"] }, granted: ["chatgpt"], read: async () => ({ ok: true, turns }) });
    const tab = h.tab(1, CHAT, "Sugar tax");
    await h.collector.observe(tab);
    await h.collector.maybeReadConversation(tab);
    expect(await h.collector.permissionsChanged([])).toBe(true);
    const [record] = (await h.collector.list()).records;
    expect(record.terms).toBeUndefined();
    expect(record.capture).toMatchObject({ status: "metadata", gap: "no-permission" });
  });
});

describe("the person's controls", () => {
  it("excluding a site drops what was kept for it and stops recording it", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://www.reddit.com/r/economics/comments/x", "Sugar tax thread"));
    await h.collector.updateSettings({ excludedHosts: ["reddit.com"] });
    expect((await h.collector.list()).records).toEqual([]);
    expect(await h.collector.observe(h.tab(1, "https://old.reddit.com/r/economics", "r/economics"))).toBeUndefined();
  });

  it("forget removes one page; the Hubble page hears of it as removed", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "One"));
    await h.collector.observe(h.tab(2, "https://arxiv.org/abs/2", "Two"));
    const first = await h.collector.list();
    await h.collector.forget(["arxiv.org/abs/1"]);
    const next = await h.collector.list({ since: first.seq, epoch: first.epoch });
    expect(next).toMatchObject({ reset: false, records: [], removed: ["arxiv.org/abs/1"] });
  });

  it("clear removes everything and starts a new epoch, so every Hubble page starts over", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "One"));
    const before = await h.collector.list();
    await h.collector.clear();
    const after = await h.collector.list({ since: before.seq, epoch: before.epoch });
    expect(after.reset).toBe(true);
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.records).toEqual([]);
    expect((await h.collector.settings()).mode).toBe("auto");
  });

  it("retention removes pages older than the person keeps activity", async () => {
    const h = harness({ settings: { mode: "auto", retentionDays: 7 } });
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "Old"));
    await h.advance(8 * 24 * 60 * 60 * 1000);
    await h.collector.observe(h.tab(2, "https://arxiv.org/abs/2", "New"));
    const keys = (await h.collector.list()).records.map((record) => record.key);
    expect(keys).toEqual(["arxiv.org/abs/2"]);
  });

  it("retention holds after a restart even if no tab event ever arrives", async () => {
    const h = harness({ settings: { mode: "auto", retentionDays: 7 } });
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "Old"));
    await h.advance(WRITE_DELAY_MS);
    await h.advance(8 * 24 * 60 * 60 * 1000);
    const restarted = h.make();
    expect((await restarted.list()).records).toEqual([]);
    expect(JSON.stringify(h.stored())).not.toContain("arxiv.org/abs/1\",\"url");
  });

  it("settings are re-read field by field: nothing unknown survives", () => {
    expect(readContextSettings({ mode: "spy", categories: ["ai", "everything"], readConversations: ["chatgpt", "grok"], excludedHosts: ["Example.com/path", "not a host"], retentionDays: 365 })).toEqual({
      version: 1,
      mode: "off",
      categories: ["ai"],
      excludedHosts: ["example.com"],
      paused: false,
      readConversations: ["chatgpt"],
      retentionDays: 30,
    });
  });
});

describe("sync with the Hubble page", () => {
  it("answers what changed since a cursor, and everything for an unknown epoch", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "One"));
    const first = await h.collector.list();
    expect(first.reset).toBe(true);
    await h.collector.observe(h.tab(2, "https://arxiv.org/abs/2", "Two"));
    const delta = await h.collector.list({ since: first.seq, epoch: first.epoch });
    expect(delta.records.map((record) => record.key)).toEqual(["arxiv.org/abs/2"]);
    expect((await h.collector.list({ since: 0, epoch: "someone-else" })).reset).toBe(true);
  });

  it("survives the worker stopping: a fresh collector reads what the last one wrote", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "One"));
    await h.advance(WRITE_DELAY_MS);
    const restarted = h.make();
    expect((await restarted.list()).records.map((record) => record.key)).toEqual(["arxiv.org/abs/1"]);
  });

  it("a damaged store is dropped, not trusted", async () => {
    const h = harness();
    h.data.set(CONTEXT_ACTIVITY_KEY, { version: 1, epoch: "e", seq: 3, records: { x: { key: "y", url: 4 } } });
    expect((await h.make().list()).records).toEqual([]);
  });

  it("nudges open Hubble pages after a write", async () => {
    const h = harness();
    await h.collector.observe(h.tab(1, "https://arxiv.org/abs/1", "One"));
    await h.advance(WRITE_DELAY_MS);
    expect(h.deps.notify).toHaveBeenCalled();
  });
});

describe("conversationTerms", () => {
  it("keeps the most-used ordinary words, user words counting double, never code", () => {
    const terms = conversationTerms([
      { role: "user", text: "sugar tax sugar tax ```const sugar = taxValue``` externality" },
      { role: "assistant", text: "The externality externality of sugar consumption consumption." },
    ]);
    expect(terms.slice(0, 3)).toEqual(expect.arrayContaining(["sugar", "tax"]));
    expect(terms).not.toContain("const");
    expect(terms).not.toContain("the");
  });
});
