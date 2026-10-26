// Project sync and durable Save to Hubble, through the real background.js
// with only chrome.* mocked (like memory.test.js) — chrome.storage.local
// included, since that is where the project list and the save jobs live and
// what the popup follows. Regressions for the two reliability bugs:
//
//   1. a project made, renamed or deleted in Hubble didn't reach the
//      extension until something was reloaded;
//   2. a conversation saved from ChatGPT sometimes never arrived, with no
//      retry and nothing left to retry from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_JOBS_KEY, MSG_CAPTURE_CONVERSATION, MSG_CAPTURE_RETRY, MSG_CAPTURE_STATUS, MSG_PAGE_REQUEST, MSG_PROJECT_FOCUS, PROJECTS_SNAPSHOT_KEY, TABDUMP_ORIGIN, TARGET_PROJECT_KEY } from "../src/config.js";
import { CAPTURE_LEASE_MS } from "../src/capture-queue.js";

const EXTENSION_ID = "hubble-extension";
const POPUP = { id: EXTENSION_ID };
const HUBBLE = { id: EXTENSION_ID, url: `${TABDUMP_ORIGIN}/`, tab: { id: 42 } };
const CHAT_URL = "https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666";
const CHAT_KEY = "chatgpt:chat:6720a1b2-1111-2222-3333-444455556666";
const TURNS = [
  { role: "user", text: "What caused WW1?" },
  { role: "assistant", text: "Militarism and alliances." },
];

let listeners;
let local;
let storageListeners;
let pageRequests;
// What the Hubble page answers a capture with; replaced per test.
let pageAnswer;
let hubbleTabs;
const realFetch = globalThis.fetch;

function hubbleTab(over = {}) {
  return { id: 42, windowId: 10, url: `${TABDUMP_ORIGIN}/`, title: "Hubble", status: "complete", active: false, ...over };
}

beforeEach(() => {
  listeners = [];
  local = {};
  storageListeners = [];
  pageRequests = [];
  hubbleTabs = [hubbleTab()];
  pageAnswer = async () => ({ ok: true, result: { outcome: "added", title: "WW1", turns: 2, truncated: false, project: "History IA" } });
  // Hubble Desktop isn't running: Save goes to Hubble on the web.
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  globalThis.chrome = {
    runtime: { id: EXTENSION_ID, onMessage: { addListener: vi.fn((fn) => listeners.push(fn)) } },
    tabs: {
      query: vi.fn(async (query) => (query.url ? hubbleTabs : [])),
      create: vi.fn(async () => hubbleTab({ id: 43 })),
      update: vi.fn(),
      reload: vi.fn(async (id) => {
        hubbleTabs = hubbleTabs.map((tab) => (tab.id === id ? { ...tab, discarded: false } : tab));
      }),
      get: vi.fn(async (id) => (id === 7 ? { id: 7, windowId: 10, url: CHAT_URL, title: "WW1 - ChatGPT", status: "complete" } : hubbleTabs.find((tab) => tab.id === id) ?? hubbleTab({ id }))),
      sendMessage: vi.fn(async (tabId, message) => {
        if (message?.type !== MSG_PAGE_REQUEST) return undefined;
        pageRequests.push({ tabId, ...message.payload });
        return pageAnswer(message.payload);
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async ({ func }) => (func?.name === "readConversationFromPage" ? [{ result: { ok: true, provider: "chatgpt", url: CHAT_URL, title: "WW1", turns: TURNS } }] : [{ result: null }])),
    },
    windows: { update: vi.fn() },
    commands: { getAll: vi.fn(async () => [{ name: "add-to-project", shortcut: "Alt+Shift+H" }]), onCommand: { addListener: vi.fn() } },
    alarms: { create: vi.fn(async () => {}), onAlarm: { addListener: vi.fn() } },
    storage: {
      session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) },
      local: {
        get: vi.fn(async (keys) => {
          const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(local);
          return Object.fromEntries(wanted.filter((key) => key in local).map((key) => [key, clone(local[key])]));
        }),
        set: vi.fn(async (items) => {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: clone(local[key]), newValue: clone(value) };
            local[key] = clone(value);
          }
          for (const listener of storageListeners) listener(changes, "local");
        }),
        remove: vi.fn(async (key) => {
          delete local[key];
        }),
      },
      onChanged: { addListener: vi.fn((fn) => storageListeners.push(fn)) },
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  globalThis.fetch = realFetch;
  vi.resetModules();
  vi.useRealTimers();
});

async function boot() {
  await import("./background.js");
}

/** Sends a message to every listener, as Chrome does; resolves with the one answer. */
async function ask(message, sender = POPUP) {
  await boot();
  return new Promise((resolve) => {
    const kept = listeners.map((fn) => fn(message, sender, resolve));
    if (!kept.includes(true)) resolve(undefined);
  });
}

/** The Hubble page reporting its projects, as content-script.js relays TABDUMP_PROJECT_FOCUS. */
function report(revision, projects, { focus = projects[0]?.id, visible = true, sender = HUBBLE } = {}) {
  return ask({ type: MSG_PROJECT_FOCUS, payload: { focus: { id: focus }, projects, visible, revision } }, sender);
}

const snapshot = () => local[PROJECTS_SNAPSHOT_KEY];
const jobs = () => local[CAPTURE_JOBS_KEY] ?? [];
const HISTORY = { id: "ws-history", name: "History IA" };
const PHYSICS = { id: "ws-physics", name: "Physics EE" };

describe("projects reach the extension as Hubble changes them", () => {
  it("a project created in Hubble is in the extension's list at once — no reload, no popup reopen", async () => {
    await report(100, [HISTORY]);
    const seen = [];
    storageListeners.push((changes) => changes[PROJECTS_SNAPSHOT_KEY] && seen.push(changes[PROJECTS_SNAPSHOT_KEY].newValue));
    const started = Date.now();
    await report(200, [HISTORY, PHYSICS], { focus: PHYSICS.id });
    expect(snapshot()).toMatchObject({ revision: 200, currentId: "ws-physics", projects: [HISTORY, PHYSICS] });
    // What an open popup hears (chrome.storage.onChanged), within the same report.
    expect(seen).toEqual([expect.objectContaining({ projects: [HISTORY, PHYSICS] })]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("a rename reaches both the list and the project tabs are added to", async () => {
    await report(100, [HISTORY, PHYSICS]);
    expect(local[TARGET_PROJECT_KEY]).toEqual(HISTORY);
    await report(150, [{ ...HISTORY, name: "History IA (final)" }, PHYSICS]);
    expect(snapshot().projects[0]).toEqual({ id: "ws-history", name: "History IA (final)" });
    expect(local[TARGET_PROJECT_KEY]).toEqual({ id: "ws-history", name: "History IA (final)" });
  });

  it("deleting the selected project drops it everywhere: the list, the target, and saves waiting to go into it", async () => {
    await report(100, [HISTORY, PHYSICS], { focus: PHYSICS.id });
    expect(local[TARGET_PROJECT_KEY]).toEqual(PHYSICS);
    // A save into Physics that can't be delivered yet.
    pageAnswer = async () => ({ ok: false, error: "timeout" });
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: PHYSICS.id } });
    expect(answer).toMatchObject({ ok: false, queued: true, job: { status: "queued" } });

    pageAnswer = async () => ({ ok: false, error: "project-missing" });
    await report(200, [HISTORY], { focus: HISTORY.id });
    expect(snapshot().projects).toEqual([HISTORY]);
    expect(local[TARGET_PROJECT_KEY]).toEqual(HISTORY);
    expect(jobs()).toEqual([expect.objectContaining({ workspaceId: PHYSICS.id, status: "failed", error: "project-missing" })]);
  });

  it("a tab that hasn't caught up can't undo a newer report, and a repeated report changes nothing", async () => {
    await report(200, [HISTORY, PHYSICS]);
    const writes = chrome.storage.local.set.mock.calls.filter(([items]) => PROJECTS_SNAPSHOT_KEY in items).length;
    await report(200, [HISTORY, PHYSICS]);
    await report(150, [HISTORY], { focus: HISTORY.id });
    expect(snapshot()).toMatchObject({ revision: 200, projects: [HISTORY, PHYSICS] });
    expect(chrome.storage.local.set.mock.calls.filter(([items]) => PROJECTS_SNAPSHOT_KEY in items)).toHaveLength(writes);
  });

  it("after a disconnect, the next report reconciles every change missed meanwhile", async () => {
    await report(100, [HISTORY, PHYSICS]);
    // The Hubble tab went away (closed, discarded, extension reloaded); meanwhile Physics was deleted and two made.
    const bio = { id: "ws-bio", name: "Biology" };
    const chem = { id: "ws-chem", name: "Chemistry" };
    // Reconnecting (the content script attaching again makes the page report).
    await report(900, [HISTORY, bio, chem], { focus: chem.id });
    expect(snapshot()).toMatchObject({ revision: 900, currentId: "ws-chem", projects: [HISTORY, bio, chem] });
  });

  it("only the Hubble page itself may report projects", async () => {
    for (const sender of [{ id: EXTENSION_ID, url: "https://evil.example/", tab: { id: 9 } }, { id: EXTENSION_ID }]) {
      expect(await report(500, [{ id: "ws-evil", name: "Evil" }], { sender })).toEqual({ ok: false, reason: "not-hubble" });
    }
    expect(snapshot()).toBeUndefined();
    expect(local[TARGET_PROJECT_KEY]).toBeUndefined();
  });
});

describe("Save to Hubble from ChatGPT, durably", () => {
  it("is reported saved only once Hubble answers that it is on disk", async () => {
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: HISTORY.id, expectedKey: CHAT_KEY } });
    expect(answer).toMatchObject({ ok: true, result: { outcome: "added", project: "History IA" }, job: { status: "saved" }, hubbleTabId: 42 });
    expect(pageRequests).toEqual([expect.objectContaining({ kind: "capture", args: { workspaceId: HISTORY.id, captureId: answer.job.id, capture: { url: CHAT_URL, title: "WW1", turns: TURNS } } })]);
    expect(jobs()).toEqual([expect.objectContaining({ key: CHAT_KEY, status: "saved" })]);
  });

  it("a transient failure is never shown as saved, and goes in by itself once Hubble is back", async () => {
    pageAnswer = async () => ({ ok: false, error: "timeout" });
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: HISTORY.id } });
    expect(answer.ok).toBe(false);
    expect(answer).toMatchObject({ queued: true, error: "timeout", job: { status: "queued", attempts: 1 } });
    // Durable: written down, with the conversation, and an alarm in case this worker stops.
    expect(jobs()[0]).toMatchObject({ status: "queued", capture: { turns: TURNS } });
    expect(chrome.alarms.create).toHaveBeenCalled();

    // Hubble is back and says so (any report): the waiting save is delivered, under the same capture id.
    pageAnswer = async () => ({ ok: true, result: { outcome: "added", title: "WW1", turns: 2, truncated: false, project: "History IA" } });
    await report(100, [HISTORY]);
    await vi.waitFor(() => expect(jobs()[0]).toMatchObject({ status: "saved" }));
    expect(pageRequests).toHaveLength(2);
    expect(pageRequests[1].args.captureId).toBe(pageRequests[0].args.captureId);
    // What a reopened popup is told about this conversation.
    expect(await ask({ type: MSG_CAPTURE_STATUS, payload: { key: CHAT_KEY } })).toMatchObject({ ok: true, job: { status: "saved", result: { project: "History IA" } } });
  });

  it("Try again delivers the same save again — the page dedupes it by capture id, so no second copy", async () => {
    pageAnswer = async () => ({ ok: false, error: "no-response" });
    const first = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: HISTORY.id } });
    pageAnswer = async () => ({ ok: true, result: { outcome: "unchanged", title: "WW1", turns: 2, truncated: false } });
    const retried = await ask({ type: MSG_CAPTURE_RETRY, payload: { id: first.job.id } });
    expect(retried).toMatchObject({ ok: true, job: { id: first.job.id, status: "saved" } });
    expect(new Set(pageRequests.map((request) => request.args.captureId))).toEqual(new Set([first.job.id]));
    expect(jobs()).toHaveLength(1);
  });

  it("a worker stopped mid-save is picked up by the next one and delivered once", async () => {
    const id = "cap-left-behind";
    local[CAPTURE_JOBS_KEY] = [
      { id, key: CHAT_KEY, provider: "chatgpt", workspaceId: HISTORY.id, capture: { url: CHAT_URL, title: "WW1", turns: TURNS }, status: "saving", attempts: 1, leaseUntil: Date.now() - 1, createdAt: Date.now() - CAPTURE_LEASE_MS, updatedAt: Date.now() - CAPTURE_LEASE_MS },
    ];
    await boot();
    await vi.waitFor(() => expect(jobs()[0]).toMatchObject({ id, status: "saved" }));
    expect(pageRequests).toEqual([expect.objectContaining({ kind: "capture", args: expect.objectContaining({ captureId: id, workspaceId: HISTORY.id }) })]);
  });

  it("keeps the project it was saved to when a project is created in Hubble while it is on its way", async () => {
    await report(100, [HISTORY]);
    let release;
    pageAnswer = (payload) => new Promise((resolve) => (release = () => resolve({ ok: true, result: { outcome: "added", title: "WW1", turns: 2, project: "History IA", workspace: payload.args.workspaceId } })));
    const saving = ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: HISTORY.id } });
    await vi.waitFor(() => expect(pageRequests).toHaveLength(1));
    // Meanwhile: a new project is made in Hubble and opened.
    await report(200, [HISTORY, PHYSICS], { focus: PHYSICS.id });
    release();
    expect(await saving).toMatchObject({ ok: true, result: { project: "History IA" } });
    expect(pageRequests.map((request) => request.args.workspaceId)).toEqual([HISTORY.id]);
  });

  it("reloads a Hubble tab Chrome discarded rather than failing against it", async () => {
    hubbleTabs = [hubbleTab({ discarded: true })];
    const answer = await ask({ type: MSG_CAPTURE_CONVERSATION, payload: { tabId: 7, workspaceId: HISTORY.id } });
    expect(chrome.tabs.reload).toHaveBeenCalledWith(42);
    expect(answer).toMatchObject({ ok: true });
  });

  it("only the popup may ask about or retry a save", async () => {
    for (const sender of [{ id: EXTENSION_ID, tab: { id: 99 } }, { id: "someone-else" }]) {
      expect(await ask({ type: MSG_CAPTURE_STATUS, payload: { key: CHAT_KEY } }, sender)).toBeUndefined();
      expect(await ask({ type: MSG_CAPTURE_RETRY, payload: { id: "x" } }, sender)).toBeUndefined();
    }
  });
});
