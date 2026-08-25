import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTab,
  closeTabs,
  createBrowserWindow,
  getActiveTab,
  listBrowserTabs,
  listBrowserWindows,
  moveTabsToWindow,
  openTabs,
  openUrl,
  pinTab,
  unpinTab,
} from "./browser-actions.js";

function fakeTab(over) {
  return { id: 1, windowId: 1, url: "https://example.com", title: "Example", pinned: false, active: false, index: 0, ...over };
}

beforeEach(() => {
  globalThis.chrome = {
    tabs: {
      query: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
      move: vi.fn(),
    },
    windows: {
      getAll: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
});

describe("listBrowserTabs", () => {
  it("maps raw chrome tabs into the wire summary shape", async () => {
    chrome.tabs.query.mockResolvedValue([fakeTab({ id: 1 }), fakeTab({ id: 2, pinned: true })]);
    const result = await listBrowserTabs({});
    expect(chrome.tabs.query).toHaveBeenCalledWith({});
    expect(result.tabs).toEqual([
      { tabId: 1, windowId: 1, url: "https://example.com", title: "Example", favIconUrl: undefined, pinned: false, active: false, index: 0 },
      { tabId: 2, windowId: 1, url: "https://example.com", title: "Example", favIconUrl: undefined, pinned: true, active: false, index: 0 },
    ]);
  });

  it("scopes the query to one window when windowId is given", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    await listBrowserTabs({ windowId: 7 });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 7 });
  });
});

describe("getActiveTab", () => {
  it("returns the active tab in the last-focused window", async () => {
    chrome.tabs.query.mockResolvedValue([fakeTab({ id: 3, active: true })]);
    const result = await getActiveTab();
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(result.tab.tabId).toBe(3);
  });

  it("returns null when there is no active tab", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    expect(await getActiveTab()).toEqual({ tab: null });
  });
});

describe("listBrowserWindows", () => {
  it("maps raw chrome windows into the wire summary shape", async () => {
    chrome.windows.getAll.mockResolvedValue([
      { id: 1, focused: true, incognito: false, type: "normal", tabs: [{ id: 1 }, { id: 2 }] },
    ]);
    const result = await listBrowserWindows();
    expect(result.windows).toEqual([{ windowId: 1, focused: true, incognito: false, type: "normal", tabIds: [1, 2] }]);
  });
});

describe("openUrl", () => {
  it("creates a tab with the given url and active flag when it isn't already open", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 9, url: "https://a.com" }));
    const result = await openUrl({ url: "https://a.com", active: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://a.com", active: true });
    expect(result).toEqual({ tab: expect.objectContaining({ tabId: 9 }), alreadyOpen: false });
  });

  it("activates the existing tab instead of creating a duplicate when the url is already open", async () => {
    chrome.tabs.query.mockResolvedValue([fakeTab({ id: 5, windowId: 2, url: "https://a.com" })]);
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 5, windowId: 2, url: "https://a.com" }));
    const result = await openUrl({ url: "https://a.com", active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(2, { focused: true });
    expect(result).toEqual({ tab: expect.objectContaining({ tabId: 5 }), alreadyOpen: true });
  });

  it("matches a url that only differs by normalization (trailing slash)", async () => {
    chrome.tabs.query.mockResolvedValue([fakeTab({ id: 5, windowId: 2, url: "https://a.com/page" })]);
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 5, windowId: 2, url: "https://a.com/page" }));
    const result = await openUrl({ url: "https://a.com/page/", active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(result.alreadyOpen).toBe(true);
  });

  it("activates the active tab when multiple open tabs match", async () => {
    chrome.tabs.query.mockResolvedValue([
      fakeTab({ id: 1, windowId: 1, url: "https://a.com", active: false }),
      fakeTab({ id: 2, windowId: 3, url: "https://a.com", active: true }),
    ]);
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 2, windowId: 3, url: "https://a.com", active: true }));
    const result = await openUrl({ url: "https://a.com", active: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(result.tab.tabId).toBe(2);
  });

  it("focuses the matching tab's own window, even when it's a different window than the active one", async () => {
    chrome.tabs.query.mockResolvedValue([fakeTab({ id: 5, windowId: 42, url: "https://a.com" })]);
    chrome.tabs.update.mockResolvedValue(fakeTab({ id: 5, windowId: 42, url: "https://a.com" }));
    await openUrl({ url: "https://a.com", active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(42, { focused: true });
  });

  it("falls back to creating a new tab when the tab lookup itself fails", async () => {
    chrome.tabs.query.mockRejectedValue(new Error("query failed"));
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 9, url: "https://a.com" }));
    const result = await openUrl({ url: "https://a.com", active: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://a.com", active: true });
    expect(result.alreadyOpen).toBe(false);
  });

  it("does not treat a different page on the same site as already open", async () => {
    chrome.tabs.query.mockResolvedValue([fakeTab({ id: 1, url: "https://a.com/other-page" })]);
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 9, url: "https://a.com/page" }));
    const result = await openUrl({ url: "https://a.com/page", active: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://a.com/page", active: true });
    expect(result.alreadyOpen).toBe(false);
  });
});

describe("openTabs", () => {
  it("opens every url in the current window and reports none failed", async () => {
    chrome.tabs.create.mockResolvedValueOnce(fakeTab({ id: 1, url: "https://a.com" })).mockResolvedValueOnce(fakeTab({ id: 2, url: "https://b.com" }));
    const result = await openTabs({ urls: ["https://a.com", "https://b.com"], newWindow: false });
    expect(result.opened).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it("creates a new window for the first url when newWindow is true, then opens the rest into it", async () => {
    chrome.windows.create.mockResolvedValue({ id: 42, tabs: [fakeTab({ id: 1, windowId: 42, url: "https://a.com" })] });
    chrome.tabs.create.mockResolvedValue(fakeTab({ id: 2, windowId: 42, url: "https://b.com" }));

    const result = await openTabs({ urls: ["https://a.com", "https://b.com"], newWindow: true });

    expect(chrome.windows.create).toHaveBeenCalledWith({ url: "https://a.com", focused: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://b.com", active: false, windowId: 42 });
    expect(result.opened.map((t) => t.tabId)).toEqual([1, 2]);
  });

  it("keeps opening the rest of the batch when one url fails", async () => {
    chrome.tabs.create
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce(fakeTab({ id: 2, url: "https://b.com" }));

    const result = await openTabs({ urls: ["https://a.com", "https://b.com"], newWindow: false });

    expect(result.opened).toHaveLength(1);
    expect(result.failed).toEqual([{ url: "https://a.com", error: "blocked" }]);
  });
});

describe("closeTab / closeTabs", () => {
  it("closes an existing tab", async () => {
    chrome.tabs.get.mockResolvedValue(fakeTab({ id: 1 }));
    const result = await closeTab({ tabId: 1 });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
    expect(result).toEqual({ closed: true, tabId: 1 });
  });

  it("propagates an error for a tab that no longer exists", async () => {
    chrome.tabs.get.mockRejectedValue(new Error("No tab with id: 999."));
    await expect(closeTab({ tabId: 999 })).rejects.toThrow();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it("closes what it can in a batch and reports the rest as failed", async () => {
    chrome.tabs.get.mockResolvedValueOnce(fakeTab({ id: 1 })).mockRejectedValueOnce(new Error("gone")).mockResolvedValueOnce(fakeTab({ id: 3 }));

    const result = await closeTabs({ tabIds: [1, 2, 3] });

    expect(result.closed).toEqual([1, 3]);
    expect(result.failed).toEqual([{ tabId: 2, error: "gone" }]);
    expect(chrome.tabs.remove).toHaveBeenCalledTimes(2);
  });
});

describe("pinTab / unpinTab", () => {
  it("pins a tab and reports its previous pinned state", async () => {
    chrome.tabs.get.mockResolvedValue(fakeTab({ id: 1, pinned: false }));
    const result = await pinTab({ tabId: 1, pinned: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { pinned: true });
    expect(result).toEqual({ tabId: 1, pinned: true, previousPinned: false });
  });

  it("unpins a tab and reports its previous pinned state", async () => {
    chrome.tabs.get.mockResolvedValue(fakeTab({ id: 1, pinned: true }));
    const result = await unpinTab({ tabId: 1, pinned: false });
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { pinned: false });
    expect(result).toEqual({ tabId: 1, pinned: false, previousPinned: true });
  });

  it("is a no-op chrome call when the tab is already in the requested pinned state", async () => {
    chrome.tabs.get.mockResolvedValue(fakeTab({ id: 1, pinned: true }));
    const result = await pinTab({ tabId: 1, pinned: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(result).toEqual({ tabId: 1, pinned: true, previousPinned: true });
  });
});

describe("moveTabsToWindow", () => {
  it("moves tabs to the end of the target window", async () => {
    chrome.tabs.move.mockResolvedValue([fakeTab({ id: 1, windowId: 9 })]);
    const result = await moveTabsToWindow({ tabIds: [1], windowId: 9 });
    expect(chrome.tabs.move).toHaveBeenCalledWith([1], { windowId: 9, index: -1 });
    expect(result.moved).toHaveLength(1);
  });
});

describe("createBrowserWindow", () => {
  it("creates a window with the given urls", async () => {
    chrome.windows.create.mockResolvedValue({ id: 5, focused: true, incognito: false, type: "normal", tabs: [{ id: 1 }] });
    const result = await createBrowserWindow({ urls: ["https://a.com"], focused: true });
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: ["https://a.com"], focused: true });
    expect(result.window.windowId).toBe(5);
  });

  it("creates a blank window when urls is empty", async () => {
    chrome.windows.create.mockResolvedValue({ id: 6, focused: true, incognito: false, type: "normal", tabs: [] });
    await createBrowserWindow({ urls: [], focused: true });
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: undefined, focused: true });
  });
});
