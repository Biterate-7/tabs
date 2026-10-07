// "Add to project" (Hubble 2.0): the dump's delivery path, with a scope and a
// project target. Exercised through the real background.js with only
// chrome.* mocked, like background.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABDUMP_ORIGIN, MSG_ADD_TO_PROJECT } from "../src/config.js";

const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";
const MSG_DUMP_TABS = "DUMP_TABS";

function fakeTab(over) {
  return { id: 1, windowId: 10, url: "https://example.com", title: "Example", pinned: false, active: false, highlighted: false, index: 0, ...over };
}

let listeners;
let sessionStore;
let delivered;

beforeEach(() => {
  listeners = [];
  sessionStore = {};
  delivered = [];
  globalThis.chrome = {
    runtime: { onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) } },
    tabs: {
      query: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      sendMessage: vi.fn(async (_tabId, message) => {
        if (message?.type !== MSG_TABDUMP_IMPORT) return undefined;
        delivered.push(message.payload);
        return { ok: true, accepted: message.payload.tabs.length };
      }),
      get: vi.fn(async (id) => fakeTab({ id, status: "loading" })),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
    windows: { update: vi.fn() },
    storage: {
      session: {
        set: vi.fn(async (items) => Object.assign(sessionStore, items)),
        get: vi.fn(async (key) => ({ [key]: sessionStore[key] })),
      },
    },
  };
  chrome.tabs.query.mockImplementation(async (query) => {
    if (query.url) return [fakeTab({ id: 42, windowId: 20, url: `${TABDUMP_ORIGIN}/`, active: true })];
    const window = [
      fakeTab({ id: 1, url: "https://www.britannica.com/event/Cuban-missile-crisis", title: "Britannica", active: true, highlighted: true }),
      fakeTab({ id: 2, url: "https://example.com/paper.pdf", title: "Paper", highlighted: true }),
      fakeTab({ id: 3, url: "https://other.example/", title: "Other" }),
      fakeTab({ id: 4, url: "chrome://settings", title: "Settings", highlighted: true }),
    ];
    if (query.active) return window.filter((tab) => tab.active);
    if (query.highlighted) return window.filter((tab) => tab.highlighted);
    return window;
  });
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
});

async function listener() {
  await import("./background.js");
  return listeners[0];
}

function send(fn, message) {
  return new Promise((resolve) => {
    expect(fn(message, {}, resolve)).toBe(true);
  });
}

const TARGET = { workspaceId: "ws-history", name: "History IA" };

describe("Add to project", () => {
  it("adds just the tab the person is looking at, to the project they chose", async () => {
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: TARGET } });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].tabs.map((tab) => tab.url)).toEqual(["https://www.britannica.com/event/Cuban-missile-crisis"]);
    expect(delivered[0].target).toEqual({ workspaceId: "ws-history", as: "sources" });
    expect(response).toMatchObject({ ok: true, status: "done", accepted: 1, target: TARGET });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 10, active: true });
  });

  it("adds the selected tabs, leaving out Chrome's own pages", async () => {
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "selected", target: TARGET } });
    expect(delivered[0].tabs.map((tab) => tab.url)).toEqual(["https://www.britannica.com/event/Cuban-missile-crisis", "https://example.com/paper.pdf"]);
    expect(response).toMatchObject({ ok: true, accepted: 2, skippedRestricted: 1 });
  });

  it("calls a tab that is already a source 'already there', not a failure", async () => {
    chrome.tabs.sendMessage.mockImplementation(async (_tabId, message) => (message?.type === MSG_TABDUMP_IMPORT ? { ok: true, accepted: 0, duplicates: 1 } : undefined));
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: TARGET } });
    expect(response).toMatchObject({ ok: true, status: "done", accepted: 0, alreadyInProject: 1 });
  });

  it("refuses without a project, and sends nothing", async () => {
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current" } });
    expect(response).toMatchObject({ ok: false, reason: "no-project" });
    expect(delivered).toEqual([]);
  });

  it("never sends a target with an ordinary dump", async () => {
    await send(await listener(), { type: MSG_DUMP_TABS, payload: { windowId: 10 } });
    expect(delivered[0].target).toBeUndefined();
    expect(delivered[0].tabs).toHaveLength(3);
  });

  it("drops anything in a target beyond an id and a name", async () => {
    await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: { ...TARGET, as: "admin", extra: "x" } } });
    expect(delivered[0].target).toEqual({ workspaceId: "ws-history", as: "sources" });
  });
});
