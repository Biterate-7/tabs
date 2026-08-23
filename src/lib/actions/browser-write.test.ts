import { describe, expect, it } from "vitest";
import {
  closeTabAction,
  closeTabsAction,
  createBrowserWindowAction,
  importBrowserTabsToWorkspaceAction,
  openTabsAction,
  openUrlAction,
  openWorkspaceInBrowserAction,
  pinTabAction,
  unpinTabAction,
  moveTabsToWindowAction,
} from "./browser-write";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { BrowserContextSnapshot } from "@/lib/browser/protocol";

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}
function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

function makeSnapshot(over: Partial<BrowserContextSnapshot> = {}): BrowserContextSnapshot {
  return {
    tabs: [
      { tabId: 1, windowId: 1, url: "https://a.com", title: "A", pinned: false, active: true, index: 0 },
      { tabId: 2, windowId: 1, url: "https://b.com", title: "B", pinned: true, active: false, index: 1 },
    ],
    windows: [{ windowId: 1, focused: true, incognito: false, type: "normal", tabIds: [1, 2] }],
    activeTabId: 1,
    ...over,
  };
}

const NOT_CONNECTED = { ok: false, message: expect.stringContaining("isn't connected") };

describe("openUrlAction", () => {
  it("rejects a non-http(s) url", () => {
    expect(openUrlAction.validate({ url: "javascript:alert(1)" }).ok).toBe(false);
    expect(openUrlAction.validate({}).ok).toBe(false);
  });

  it("accepts a safe url", () => {
    expect(openUrlAction.validate({ url: "https://example.com" })).toEqual({ ok: true, args: { url: "https://example.com" } });
  });

  it("requires the extension to be connected to run", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    expect(openUrlAction.run(store, { url: "https://example.com" }, {})).toEqual(NOT_CONNECTED);
  });

  it("does not mutate the store — the client executes the real open afterward", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = openUrlAction.run(store, { url: "https://example.com" }, { browserContext: makeSnapshot() });
    expect(result).toEqual({ ok: true, data: { url: "https://example.com" }, store });
  });
});

describe("openTabsAction", () => {
  it("rejects an empty or oversized urls array, or one containing an unsafe url", () => {
    expect(openTabsAction.validate({ urls: [] }).ok).toBe(false);
    expect(openTabsAction.validate({ urls: ["https://a.com", "javascript:alert(1)"] }).ok).toBe(false);
    expect(openTabsAction.validate({ urls: Array.from({ length: 51 }, () => "https://a.com") }).ok).toBe(false);
  });

  it("runs successfully and reports the url count", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = openTabsAction.run(store, { urls: ["https://a.com", "https://b.com"] }, { browserContext: makeSnapshot() });
    expect(result).toEqual({ ok: true, data: { urlCount: 2, urls: ["https://a.com", "https://b.com"] }, store });
  });
});

describe("closeTabAction / closeTabsAction", () => {
  const store = makeStore([makeWorkspace({ id: "a" })], "a");

  it("close_tab fails for a tab id that isn't currently open", () => {
    const result = closeTabAction.run(store, { tabId: 999 }, { browserContext: makeSnapshot() });
    expect(result.ok).toBe(false);
  });

  it("close_tab succeeds for an open tab id", () => {
    const result = closeTabAction.run(store, { tabId: 1 }, { browserContext: makeSnapshot() });
    expect(result).toEqual({ ok: true, data: { tabId: 1 }, store });
  });

  it("close_tabs filters out ids that aren't currently open and fails only if none are", () => {
    const result = closeTabsAction.run(store, { tabIds: [1, 999] }, { browserContext: makeSnapshot() });
    expect(result).toEqual({ ok: true, data: { tabIds: [1], count: 1 }, store });

    const allMissing = closeTabsAction.run(store, { tabIds: [998, 999] }, { browserContext: makeSnapshot() });
    expect(allMissing.ok).toBe(false);
  });

  it("validate rejects malformed tabIds", () => {
    expect(closeTabsAction.validate({ tabIds: [] }).ok).toBe(false);
    expect(closeTabsAction.validate({ tabIds: ["1"] }).ok).toBe(false);
  });
});

describe("pinTabAction / unpinTabAction", () => {
  const store = makeStore([makeWorkspace({ id: "a" })], "a");

  it("forces the correct pinned flag regardless of what's asked", () => {
    expect(pinTabAction.run(store, { tabId: 1 }, { browserContext: makeSnapshot() })).toEqual({ ok: true, data: { tabId: 1, pinned: true }, store });
    expect(unpinTabAction.run(store, { tabId: 2 }, { browserContext: makeSnapshot() })).toEqual({ ok: true, data: { tabId: 2, pinned: false }, store });
  });

  it("fails for a tab id that isn't open", () => {
    expect(pinTabAction.run(store, { tabId: 999 }, { browserContext: makeSnapshot() }).ok).toBe(false);
  });
});

describe("moveTabsToWindowAction", () => {
  it("fails for a window id that isn't open", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = moveTabsToWindowAction.run(store, { tabIds: [1], windowId: 999 }, { browserContext: makeSnapshot() });
    expect(result.ok).toBe(false);
  });

  it("succeeds for an existing window id", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = moveTabsToWindowAction.run(store, { tabIds: [1], windowId: 1 }, { browserContext: makeSnapshot() });
    expect(result).toEqual({ ok: true, data: { tabIds: [1], windowId: 1 }, store });
  });
});

describe("createBrowserWindowAction", () => {
  it("defaults urls to [] and focused to true", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = createBrowserWindowAction.run(store, { urls: undefined, focused: undefined }, { browserContext: makeSnapshot() });
    expect(result).toEqual({ ok: true, data: { urls: [], focused: true }, store });
  });

  it("rejects an unsafe url in the optional urls array", () => {
    expect(createBrowserWindowAction.validate({ urls: ["javascript:alert(1)"] }).ok).toBe(false);
  });
});

describe("openWorkspaceInBrowserAction", () => {
  it("resolves the workspace's tab urls", () => {
    const workspace = makeWorkspace({
      id: "a",
      name: "Physics IA",
      tabs: [
        { id: "t1", url: "https://x.com/1", normalizedUrl: "https://x.com/1", domain: "x.com" },
        { id: "t2", url: "https://x.com/2", normalizedUrl: "https://x.com/2", domain: "x.com" },
      ],
    });
    const store = makeStore([workspace], "a");
    const result = openWorkspaceInBrowserAction.run(store, { workspaceId: "a" }, { browserContext: makeSnapshot() });
    expect(result).toEqual({
      ok: true,
      data: { workspaceId: "a", workspaceName: "Physics IA", urls: ["https://x.com/1", "https://x.com/2"], tabCount: 2, truncated: false },
      store,
    });
  });

  it("fails for an empty workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = openWorkspaceInBrowserAction.run(store, { workspaceId: "a" }, { browserContext: makeSnapshot() });
    expect(result.ok).toBe(false);
  });

  it("fails for an unknown workspace id", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = openWorkspaceInBrowserAction.run(store, { workspaceId: "ghost" }, { browserContext: makeSnapshot() });
    expect(result.ok).toBe(false);
  });
});

describe("importBrowserTabsToWorkspaceAction", () => {
  it("merges the browser context's open tabs into the target workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = importBrowserTabsToWorkspaceAction.run(store, { workspaceId: "a" }, { browserContext: makeSnapshot() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ workspaceId: "a", workspaceName: "Untitled", importedCount: 2 });
    expect(result.store!.workspaces[0].tabs).toHaveLength(2);
  });

  it("preserves favicon metadata when the browser tab has one", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const snapshot = makeSnapshot({
      tabs: [{ tabId: 1, windowId: 1, url: "https://a.com", title: "A", favIconUrl: "https://a.com/favicon.ico", pinned: false, active: true, index: 0 }],
    });
    const result = importBrowserTabsToWorkspaceAction.run(store, { workspaceId: "a" }, { browserContext: snapshot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store!.workspaces[0].tabs[0].favicon).toBe("https://a.com/favicon.ico");
  });

  it("defaults to the current workspace when none is given", () => {
    const store = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "b");
    const result = importBrowserTabsToWorkspaceAction.run(store, { workspaceId: undefined }, { browserContext: makeSnapshot() });
    expect(result.ok && result.data.workspaceId).toBe("b");
  });

  it("does not duplicate a tab already saved in the workspace", () => {
    const workspace = makeWorkspace({ id: "a", tabs: [{ id: "t1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com" }] });
    const store = makeStore([workspace], "a");
    const result = importBrowserTabsToWorkspaceAction.run(store, { workspaceId: "a" }, { browserContext: makeSnapshot() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matching = result.store!.workspaces[0].tabs.filter((t) => t.url === "https://a.com");
    expect(matching).toHaveLength(2);
    expect(matching.some((t) => t.isDuplicate)).toBe(true);
  });
});
