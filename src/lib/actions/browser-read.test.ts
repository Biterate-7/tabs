import { describe, expect, it } from "vitest";
import { getActiveTabAction, listBrowserTabsAction, listBrowserWindowsAction } from "./browser-read";
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

const store = makeStore([makeWorkspace({ id: "a" })], "a");

describe("listBrowserTabsAction", () => {
  it("fails with a clear message when the extension isn't connected", () => {
    const result = listBrowserTabsAction.run(store, { windowId: undefined, query: undefined, limit: undefined }, {});
    expect(result).toEqual({ ok: false, message: expect.stringContaining("isn't connected") });
  });

  it("returns every open tab from the snapshot", () => {
    const result = listBrowserTabsAction.run(store, { windowId: undefined, query: undefined, limit: undefined }, { browserContext: makeSnapshot() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(2);
    expect(result.data.tabs.map((t) => t.tabId)).toEqual([1, 2]);
  });

  it("filters by windowId", () => {
    const snapshot = makeSnapshot({
      tabs: [
        { tabId: 1, windowId: 1, url: "https://a.com", title: "A", pinned: false, active: true, index: 0 },
        { tabId: 3, windowId: 2, url: "https://c.com", title: "C", pinned: false, active: false, index: 0 },
      ],
    });
    const result = listBrowserTabsAction.run(store, { windowId: 2, query: undefined, limit: undefined }, { browserContext: snapshot });
    expect(result.ok && result.data.tabs.map((t) => t.tabId)).toEqual([3]);
  });

  it("filters by a keyword query over title/url", () => {
    const result = listBrowserTabsAction.run(store, { windowId: undefined, query: "b.com", limit: undefined }, { browserContext: makeSnapshot() });
    expect(result.ok && result.data.tabs.map((t) => t.tabId)).toEqual([2]);
  });

  it("caps results at the given limit and reports truncated", () => {
    const result = listBrowserTabsAction.run(store, { windowId: undefined, query: undefined, limit: 1 }, { browserContext: makeSnapshot() });
    expect(result.ok && result.data).toMatchObject({ total: 2, truncated: true });
    expect(result.ok && result.data.tabs).toHaveLength(1);
  });

  it("validate defaults every field to undefined when omitted", () => {
    expect(listBrowserTabsAction.validate({})).toEqual({ ok: true, args: { windowId: undefined, query: undefined, limit: undefined } });
  });
});

describe("getActiveTabAction", () => {
  it("fails when not connected", () => {
    expect(getActiveTabAction.run(store, {}, {})).toEqual({ ok: false, message: expect.stringContaining("isn't connected") });
  });

  it("returns the tab matching activeTabId", () => {
    const result = getActiveTabAction.run(store, {}, { browserContext: makeSnapshot() });
    expect(result.ok && result.data.tab?.tabId).toBe(1);
  });

  it("returns null when there is no active tab", () => {
    const result = getActiveTabAction.run(store, {}, { browserContext: makeSnapshot({ activeTabId: null }) });
    expect(result).toEqual({ ok: true, data: { tab: null } });
  });
});

describe("listBrowserWindowsAction", () => {
  it("fails when not connected", () => {
    expect(listBrowserWindowsAction.run(store, {}, {})).toEqual({ ok: false, message: expect.stringContaining("isn't connected") });
  });

  it("returns the windows from the snapshot", () => {
    const result = listBrowserWindowsAction.run(store, {}, { browserContext: makeSnapshot() });
    expect(result.ok && result.data.windows).toHaveLength(1);
  });
});
