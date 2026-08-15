import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOrFocusTab } from "./extension-bridge";
import type { Tab } from "./types";

const EXTENSION_ID = "test-extension-id";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "tab-1",
    url: over.url ?? "https://example.com/page",
    normalizedUrl: over.normalizedUrl ?? over.url ?? "https://example.com/page",
    domain: over.domain ?? "example.com",
    ...over,
  };
}

type SendMessageMock = ReturnType<typeof vi.fn>;

function stubChromeRuntime(
  handler: (message: unknown, callback: (response: unknown) => void) => void
): SendMessageMock {
  const sendMessage = vi.fn(
    (_extensionId: string, message: unknown, callback: (response: unknown) => void) => {
      handler(message, callback);
    }
  );
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  return sendMessage;
}

/** Routes PING -> ok, LIST_TABS -> the given tabs, FOCUS_TAB -> the given result. */
function stubChromeWith(opts: {
  tabs?: Array<{ id: number; url?: string; windowId: number; lastAccessed?: number }>;
  focusOk?: boolean;
}): SendMessageMock {
  return stubChromeRuntime((message, callback) => {
    const type = (message as { type?: string }).type;
    if (type === "PING") {
      callback({ ok: true });
    } else if (type === "LIST_TABS") {
      callback(opts.tabs ?? []);
    } else if (type === "FOCUS_TAB") {
      callback({ ok: opts.focusOk ?? true });
    } else {
      callback({ ok: false, error: "unknown message type" });
    }
  });
}

let windowOpenSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_TABDUMP_EXTENSION_ID", EXTENSION_ID);
  windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("openOrFocusTab", () => {
  it("focuses the matching open browser tab and does not open a new one", async () => {
    const tab = makeTab({ url: "https://github.com/foo/bar", normalizedUrl: "https://github.com/foo/bar" });
    const sendMessage = stubChromeWith({
      tabs: [{ id: 42, url: "https://github.com/foo/bar", windowId: 7, lastAccessed: 100 }],
      focusOk: true,
    });

    await openOrFocusTab(tab);

    expect(sendMessage).toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB", tabId: 42, windowId: 7 }),
      expect.any(Function)
    );
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it("opens a new tab when no browser tab matches", async () => {
    const tab = makeTab({ url: "https://youtube.com/watch?v=1", normalizedUrl: "https://youtube.com/watch?v=1" });
    const sendMessage = stubChromeWith({
      tabs: [{ id: 1, url: "https://google.com", windowId: 1, lastAccessed: 1 }],
    });

    await openOrFocusTab(tab);

    expect(windowOpenSpy).toHaveBeenCalledWith("https://youtube.com/watch?v=1", "_blank", "noopener,noreferrer");
    expect(sendMessage).not.toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB" }),
      expect.any(Function)
    );
  });

  it("selects the most recently accessed tab when multiple browser tabs match", async () => {
    const tab = makeTab({ url: "https://example.com/dup", normalizedUrl: "https://example.com/dup" });
    stubChromeWith({
      tabs: [
        { id: 1, url: "https://example.com/dup", windowId: 1, lastAccessed: 500 },
        { id: 2, url: "https://example.com/dup", windowId: 1, lastAccessed: 900 },
        { id: 3, url: "https://example.com/dup", windowId: 2, lastAccessed: 100 },
      ],
    });
    const sendMessage = stubChromeRuntime((message, callback) => {
      const type = (message as { type?: string }).type;
      if (type === "PING") callback({ ok: true });
      else if (type === "LIST_TABS")
        callback([
          { id: 1, url: "https://example.com/dup", windowId: 1, lastAccessed: 500 },
          { id: 2, url: "https://example.com/dup", windowId: 1, lastAccessed: 900 },
          { id: 3, url: "https://example.com/dup", windowId: 2, lastAccessed: 100 },
        ]);
      else if (type === "FOCUS_TAB") callback({ ok: true });
    });

    await openOrFocusTab(tab);

    expect(sendMessage).toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB", tabId: 2, windowId: 1 }),
      expect.any(Function)
    );
  });

  it("falls back to tab id when lastAccessed is unavailable on tied/missing candidates", async () => {
    const tab = makeTab({ url: "https://example.com/dup", normalizedUrl: "https://example.com/dup" });
    const sendMessage = stubChromeWith({
      tabs: [
        { id: 5, url: "https://example.com/dup", windowId: 1 },
        { id: 9, url: "https://example.com/dup", windowId: 1 },
      ],
    });

    await openOrFocusTab(tab);

    expect(sendMessage).toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB", tabId: 9 }),
      expect.any(Function)
    );
  });

  it("matches using normalizeUrl semantics: trailing slash is not a meaningful difference", async () => {
    const tab = makeTab({ url: "https://example.com/page", normalizedUrl: "https://example.com/page" });
    const sendMessage = stubChromeWith({
      tabs: [{ id: 1, url: "https://example.com/page/", windowId: 1 }],
    });

    await openOrFocusTab(tab);

    expect(sendMessage).toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB", tabId: 1 }),
      expect.any(Function)
    );
  });

  it("matches using normalizeUrl semantics: tracking params are ignored but other query params are meaningful", async () => {
    const tab = makeTab({
      url: "https://example.com/page?id=abc",
      normalizedUrl: "https://example.com/page?id=abc",
    });
    const sendMessage = stubChromeWith({
      tabs: [
        // Same tracked resource (id=abc) plus a tracking param -> should match.
        { id: 1, url: "https://example.com/page?id=abc&utm_source=newsletter", windowId: 1 },
        // Different resource (id=xyz) -> must NOT match even though domain/path match.
        { id: 2, url: "https://example.com/page?id=xyz", windowId: 1 },
      ],
    });

    await openOrFocusTab(tab);

    expect(sendMessage).toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB", tabId: 1 }),
      expect.any(Function)
    );
  });

  it("falls back to opening a new tab when the extension is unreachable (PING fails)", async () => {
    const sendMessage = stubChromeRuntime((_message, callback) => {
      callback(undefined);
    });
    const tab = makeTab({});

    await expect(openOrFocusTab(tab)).resolves.toBeUndefined();

    expect(windowOpenSpy).toHaveBeenCalledWith(tab.url, "_blank", "noopener,noreferrer");
    expect(sendMessage).not.toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "LIST_TABS" }),
      expect.any(Function)
    );
  });

  it("falls back to opening a new tab when chrome is entirely unavailable", async () => {
    vi.stubGlobal("chrome", undefined);
    const tab = makeTab({});

    await openOrFocusTab(tab);

    expect(windowOpenSpy).toHaveBeenCalledWith(tab.url, "_blank", "noopener,noreferrer");
  });

  it("falls back to opening a new tab when no extension id is configured", async () => {
    vi.unstubAllEnvs();
    const sendMessage = stubChromeWith({ tabs: [] });
    const tab = makeTab({});

    await openOrFocusTab(tab);

    expect(windowOpenSpy).toHaveBeenCalledWith(tab.url, "_blank", "noopener,noreferrer");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to opening a new tab when LIST_TABS fails to return a usable response", async () => {
    const sendMessage = stubChromeRuntime((message, callback) => {
      const type = (message as { type?: string }).type;
      if (type === "PING") callback({ ok: true });
      else if (type === "LIST_TABS") callback(null);
    });
    const tab = makeTab({});

    await openOrFocusTab(tab);

    expect(windowOpenSpy).toHaveBeenCalledWith(tab.url, "_blank", "noopener,noreferrer");
    expect(sendMessage).not.toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB" }),
      expect.any(Function)
    );
  });

  it("falls back to opening a new tab when FOCUS_TAB fails (tab closed in the race window)", async () => {
    const tab = makeTab({ url: "https://example.com/page", normalizedUrl: "https://example.com/page" });
    stubChromeWith({
      tabs: [{ id: 1, url: "https://example.com/page", windowId: 1 }],
      focusOk: false,
    });

    await openOrFocusTab(tab);

    expect(windowOpenSpy).toHaveBeenCalledWith(tab.url, "_blank", "noopener,noreferrer");
  });

  it("never throws when the extension messaging call itself throws synchronously", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: () => {
          throw new Error("extension context invalidated");
        },
      },
    });
    const tab = makeTab({});

    await expect(openOrFocusTab(tab)).resolves.toBeUndefined();
    expect(windowOpenSpy).toHaveBeenCalledWith(tab.url, "_blank", "noopener,noreferrer");
  });

  it("times out and falls back if the extension never responds", async () => {
    vi.useFakeTimers();
    stubChromeRuntime(() => {
      // Never invokes the callback.
    });
    const tab = makeTab({});

    const promise = openOrFocusTab(tab);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(windowOpenSpy).toHaveBeenCalledWith(tab.url, "_blank", "noopener,noreferrer");
  });

  it("re-queries live tabs on every call so repeated clicks stay idempotent (no duplicate tabs)", async () => {
    const tab = makeTab({ url: "https://github.com/foo/bar", normalizedUrl: "https://github.com/foo/bar" });
    const sendMessage = stubChromeWith({
      tabs: [{ id: 42, url: "https://github.com/foo/bar", windowId: 7 }],
      focusOk: true,
    });

    await openOrFocusTab(tab);
    await openOrFocusTab(tab);

    const listTabsCalls = sendMessage.mock.calls.filter(
      (call) => (call[1] as { type?: string }).type === "LIST_TABS"
    );
    expect(listTabsCalls).toHaveLength(2);
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it("mixed saved/open tabs: focuses the one that's open, opens a new tab for the one that isn't", async () => {
    stubChromeWith({
      tabs: [
        { id: 1, url: "https://google.com", windowId: 1 },
        { id: 2, url: "https://github.com/org/repo", windowId: 1 },
        { id: 3, url: "https://unrelated.example/page", windowId: 2 },
      ],
      focusOk: true,
    });
    const sendMessage = stubChromeWith({
      tabs: [
        { id: 1, url: "https://google.com", windowId: 1 },
        { id: 2, url: "https://github.com/org/repo", windowId: 1 },
        { id: 3, url: "https://unrelated.example/page", windowId: 2 },
      ],
      focusOk: true,
    });

    const github = makeTab({
      id: "gh",
      url: "https://github.com/org/repo",
      normalizedUrl: "https://github.com/org/repo",
    });
    const youtube = makeTab({
      id: "yt",
      url: "https://youtube.com/watch?v=abc",
      normalizedUrl: "https://youtube.com/watch?v=abc",
    });

    await openOrFocusTab(github);
    expect(sendMessage).toHaveBeenCalledWith(
      EXTENSION_ID,
      expect.objectContaining({ type: "FOCUS_TAB", tabId: 2 }),
      expect.any(Function)
    );
    expect(windowOpenSpy).not.toHaveBeenCalled();

    await openOrFocusTab(youtube);
    expect(windowOpenSpy).toHaveBeenCalledWith(
      "https://youtube.com/watch?v=abc",
      "_blank",
      "noopener,noreferrer"
    );
  });
});
