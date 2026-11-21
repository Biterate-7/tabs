// "Add to project" (Hubble 2.0), now that Hubble is a desktop app: the popup's
// chosen project and scope go to a paired Hubble Desktop as one "add-sources"
// request (src/desktop-link.js → src-tauri/src/extension_link.rs), which adds
// them through the app's own source pipeline. Exercised through the real
// background.js with only chrome.* and the loopback bridge faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSG_ADD_TO_PROJECT } from "../src/config.js";
import { LINK_KEY } from "../src/desktop-link.js";
import { pairedDesktopFetch, pairedStorage } from "../test-support/paired-desktop.js";

const MSG_DUMP_TABS = "DUMP_TABS";

function fakeTab(over) {
  return { id: 1, windowId: 10, url: "https://example.com", title: "Example", pinned: false, active: false, highlighted: false, index: 0, ...over };
}

let listeners;
let local;
// What Hubble Desktop's window answers an "add-sources" request with; replaced per test.
let desktopAnswer;
const realFetch = globalThis.fetch;

beforeEach(() => {
  listeners = [];
  local = pairedStorage();
  desktopAnswer = (request) => ({ ok: true, result: { added: request.args.tabs.length, duplicates: 0, failed: 0, project: "History IA" } });
  globalThis.fetch = pairedDesktopFetch({ answer: async (request) => desktopAnswer(request) });
  globalThis.chrome = {
    runtime: { id: "hubble-extension", onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) } },
    tabs: {
      query: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      sendMessage: vi.fn(),
      get: vi.fn(async (id) => fakeTab({ id, status: "complete" })),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
    windows: { update: vi.fn() },
    storage: {
      session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) },
      local: {
        get: vi.fn(async (key) => (typeof key === "string" && key in local ? { [key]: local[key] } : {})),
        set: vi.fn(async (values) => Object.assign(local, values)),
        remove: vi.fn(async (key) => {
          delete local[key];
        }),
      },
    },
  };
  chrome.tabs.query.mockImplementation(async (query) => {
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
  globalThis.fetch = realFetch;
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

const sent = () => globalThis.fetch.requests;
const TARGET = { workspaceId: "ws-history", name: "History IA" };

describe("Add to project", () => {
  it("adds just the tab the person is looking at, to the project they chose, in Hubble Desktop", async () => {
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: TARGET } });
    expect(sent()).toEqual([
      expect.objectContaining({ kind: "add-sources", args: { workspaceId: "ws-history", tabs: [{ url: "https://www.britannica.com/event/Cuban-missile-crisis", title: "Britannica" }] } }),
    ]);
    expect(response).toMatchObject({ ok: true, status: "done", accepted: 1, target: TARGET });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 10, active: true });
  });

  it("adds the selected tabs, leaving out Chrome's own pages", async () => {
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "selected", target: TARGET } });
    expect(sent()[0].args.tabs.map((tab) => tab.url)).toEqual(["https://www.britannica.com/event/Cuban-missile-crisis", "https://example.com/paper.pdf"]);
    expect(response).toMatchObject({ ok: true, accepted: 2, skippedRestricted: 1 });
  });

  it("calls a tab that is already a source 'already there', not a failure", async () => {
    desktopAnswer = () => ({ ok: true, result: { added: 0, duplicates: 1, failed: 0, project: "History IA" } });
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: TARGET } });
    expect(response).toMatchObject({ ok: true, status: "done", accepted: 0, alreadyInProject: 1 });
  });

  it("says when the project is gone from Hubble", async () => {
    desktopAnswer = () => ({ ok: false, error: "project-missing" });
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: TARGET } });
    expect(response).toMatchObject({ ok: false, reason: "project-missing", target: TARGET });
  });

  it("refuses without a project, and sends nothing", async () => {
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current" } });
    expect(response).toMatchObject({ ok: false, reason: "no-project" });
    expect(sent()).toEqual([]);
  });

  it("says so, and sends nothing, when this extension isn't connected to Hubble Desktop", async () => {
    delete local[LINK_KEY];
    const response = await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: TARGET } });
    expect(response).toMatchObject({ ok: false, reason: "not-paired" });
    expect(sent()).toEqual([]);
  });

  it("drops anything in a target beyond an id and a name", async () => {
    await send(await listener(), { type: MSG_ADD_TO_PROJECT, payload: { windowId: 10, scope: "current", target: { ...TARGET, as: "admin", extra: "x" } } });
    expect(sent()[0].args).toEqual({ workspaceId: "ws-history", tabs: expect.any(Array) });
  });
});

describe("Save all tabs", () => {
  it("sends the window to Hubble Desktop, which asks which project they go to", async () => {
    await send(await listener(), { type: MSG_DUMP_TABS, payload: { windowId: 10 } });
    // The choose-a-project path (import sessions), never the paired add-sources request.
    expect(sent()).toEqual([]);
    const paths = globalThis.fetch.mock.calls.map(([url]) => new URL(url).pathname);
    expect(paths).toContain("/v1/sessions");
  });
});
