import { describe, expect, it } from "vitest";
import { ALLOWED_BROWSER_ACTIONS, CONTEXT_ACTIONS, MAX_SESSION_TABS, isSafeOpenUrl, validateBrowserCommand } from "./browser-commands.js";

describe("isSafeOpenUrl", () => {
  it("allows http and https urls", () => {
    expect(isSafeOpenUrl("https://example.com")).toBe(true);
    expect(isSafeOpenUrl("http://example.com/path?q=1")).toBe(true);
  });

  it("rejects javascript:, data:, and chrome: urls", () => {
    expect(isSafeOpenUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeOpenUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeOpenUrl("chrome://settings")).toBe(false);
    expect(isSafeOpenUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects unparseable input and non-strings", () => {
    expect(isSafeOpenUrl("not a url")).toBe(false);
    expect(isSafeOpenUrl(undefined)).toBe(false);
    expect(isSafeOpenUrl(123)).toBe(false);
  });

  it("rejects an absurdly long url", () => {
    expect(isSafeOpenUrl(`https://example.com/${"a".repeat(5000)}`)).toBe(false);
  });
});

describe("validateBrowserCommand", () => {
  it("rejects an action not on the allowlist", () => {
    const result = validateBrowserCommand("eval_javascript", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown or disallowed/i);
  });

  it("exposes exactly the spec's read/open/close/pin/window/history actions, and context detection's", () => {
    expect([...ALLOWED_BROWSER_ACTIONS].sort()).toEqual(
      [
        "get_context_settings",
        "set_context_settings",
        "request_context_access",
        "get_context_activity",
        "forget_context_activity",
        "clear_context_activity",
        "capture_context_conversation",
        "list_browser_tabs",
        "get_active_tab",
        "list_browser_windows",
        "get_history",
        "open_url",
        "open_tabs",
        "open_session",
        "close_tab",
        "close_tabs",
        "pin_tab",
        "unpin_tab",
        "move_tabs_to_window",
        "create_browser_window",
        "deliver_to_desktop",
      ].sort()
    );
  });

  describe("context detection's commands", () => {
    it("are listed apart, so background.js can refuse them to anything but Hubble's page", () => {
      expect([...CONTEXT_ACTIONS].every((action) => ALLOWED_BROWSER_ACTIONS.includes(action))).toBe(true);
    });

    it("check their arguments", () => {
      expect(validateBrowserCommand("get_context_activity", { since: 3, epoch: "e1" })).toEqual({ ok: true, args: { since: 3, epoch: "e1" } });
      expect(validateBrowserCommand("get_context_activity", { since: -1 }).ok).toBe(false);
      expect(validateBrowserCommand("get_context_activity", { epoch: "" }).ok).toBe(false);
      expect(validateBrowserCommand("request_context_access", { provider: "chatgpt" })).toEqual({ ok: true, args: { provider: "chatgpt" } });
      expect(validateBrowserCommand("request_context_access", { provider: "grok" }).ok).toBe(false);
      expect(validateBrowserCommand("forget_context_activity", { keys: [] }).ok).toBe(false);
      expect(validateBrowserCommand("forget_context_activity", { keys: Array(401).fill("k") }).ok).toBe(false);
      expect(validateBrowserCommand("set_context_settings", { settings: [] }).ok).toBe(false);
      expect(validateBrowserCommand("set_context_settings", { settings: { mode: "auto", excludedHosts: Array(5000).fill("example.com") } }).ok).toBe(false);
      expect(validateBrowserCommand("capture_context_conversation", { url: "javascript:alert(1)", workspaceId: "p" }).ok).toBe(false);
      expect(validateBrowserCommand("capture_context_conversation", { url: "https://chatgpt.com/c/abcdef12", workspaceId: "" }).ok).toBe(false);
    });
  });

  describe("deliver_to_desktop (Hubble Desktop's relay)", () => {
    const base = { port: 41517, id: "a".repeat(32), secret: "b".repeat(64), action: "browser_tabs" };

    it("accepts an answer or a refusal for a known question, to Hubble Desktop's ports only", () => {
      expect(validateBrowserCommand("deliver_to_desktop", { ...base, ok: true, result: { tabs: [] } })).toEqual({ ok: true, args: { ...base, ok: true, result: { tabs: [] } } });
      const declined = validateBrowserCommand("deliver_to_desktop", { ...base, ok: false, error: "x".repeat(500) });
      expect(declined.ok).toBe(true);
      expect(declined.args.error).toHaveLength(300);
    });

    it("refuses anything else", () => {
      for (const bad of [
        { ...base, port: 80, ok: true, result: {} },
        { ...base, port: "41517", ok: true, result: {} },
        { ...base, id: "../x", ok: true, result: {} },
        { ...base, secret: "short", ok: true, result: {} },
        { ...base, action: "open_tabs", ok: true, result: {} },
        { ...base, ok: true, result: [] },
        { ...base, ok: true },
        { ...base, ok: "yes", result: {} },
        { ...base, ok: false },
      ]) {
        expect(validateBrowserCommand("deliver_to_desktop", bad).ok, JSON.stringify(bad)).toBe(false);
      }
    });

    it("refuses an answer too large for Hubble Desktop to take", () => {
      expect(validateBrowserCommand("deliver_to_desktop", { ...base, ok: true, result: { big: "x".repeat(8 * 1024 * 1024) } }).ok).toBe(false);
    });
  });

  it("validates list_browser_tabs' optional windowId", () => {
    expect(validateBrowserCommand("list_browser_tabs", {})).toEqual({ ok: true, args: { windowId: undefined } });
    expect(validateBrowserCommand("list_browser_tabs", { windowId: 3 })).toEqual({ ok: true, args: { windowId: 3 } });
    expect(validateBrowserCommand("list_browser_tabs", { windowId: "3" }).args.windowId).toBeUndefined();
  });

  it("rejects open_url with a missing or unsafe url", () => {
    expect(validateBrowserCommand("open_url", {}).ok).toBe(false);
    expect(validateBrowserCommand("open_url", { url: "javascript:alert(1)" }).ok).toBe(false);
  });

  it("accepts open_url with a safe url and defaults active to true and reuseCurrentTab to false", () => {
    expect(validateBrowserCommand("open_url", { url: "https://example.com" })).toEqual({
      ok: true,
      args: { url: "https://example.com", active: true, reuseCurrentTab: false },
    });
  });

  it("passes reuseCurrentTab through as a strict boolean", () => {
    expect(validateBrowserCommand("open_url", { url: "https://example.com", reuseCurrentTab: true })).toEqual({
      ok: true,
      args: { url: "https://example.com", active: true, reuseCurrentTab: true },
    });
    expect(validateBrowserCommand("open_url", { url: "https://example.com", reuseCurrentTab: "yes" })).toEqual({
      ok: true,
      args: { url: "https://example.com", active: true, reuseCurrentTab: true },
    });
  });

  it("rejects open_tabs with an empty or oversized urls array", () => {
    expect(validateBrowserCommand("open_tabs", { urls: [] }).ok).toBe(false);
    expect(validateBrowserCommand("open_tabs", { urls: Array.from({ length: 51 }, () => "https://x.com") }).ok).toBe(false);
  });

  it("rejects open_tabs if any url in the batch is unsafe", () => {
    const result = validateBrowserCommand("open_tabs", { urls: ["https://a.com", "javascript:alert(1)"] });
    expect(result.ok).toBe(false);
  });

  it("accepts a well-formed open_tabs command", () => {
    const result = validateBrowserCommand("open_tabs", { urls: ["https://a.com", "https://b.com"], newWindow: true });
    expect(result).toEqual({ ok: true, args: { urls: ["https://a.com", "https://b.com"], newWindow: true } });
  });

  it("rejects close_tab/close_tabs with malformed tab ids", () => {
    expect(validateBrowserCommand("close_tab", {}).ok).toBe(false);
    expect(validateBrowserCommand("close_tab", { tabId: "abc" }).ok).toBe(false);
    expect(validateBrowserCommand("close_tabs", { tabIds: [] }).ok).toBe(false);
    expect(validateBrowserCommand("close_tabs", { tabIds: [1, "2"] }).ok).toBe(false);
  });

  it("accepts valid close_tab/close_tabs commands", () => {
    expect(validateBrowserCommand("close_tab", { tabId: 5 })).toEqual({ ok: true, args: { tabId: 5 } });
    expect(validateBrowserCommand("close_tabs", { tabIds: [1, 2, 3] })).toEqual({ ok: true, args: { tabIds: [1, 2, 3] } });
  });

  it("pin_tab/unpin_tab always force their own pinned flag regardless of what's passed in", () => {
    expect(validateBrowserCommand("pin_tab", { tabId: 1, pinned: false })).toEqual({ ok: true, args: { tabId: 1, pinned: true } });
    expect(validateBrowserCommand("unpin_tab", { tabId: 1, pinned: true })).toEqual({ ok: true, args: { tabId: 1, pinned: false } });
  });

  it("validates move_tabs_to_window requires both tabIds and windowId", () => {
    expect(validateBrowserCommand("move_tabs_to_window", { tabIds: [1] }).ok).toBe(false);
    expect(validateBrowserCommand("move_tabs_to_window", { windowId: 1 }).ok).toBe(false);
    expect(validateBrowserCommand("move_tabs_to_window", { tabIds: [1, 2], windowId: 9 })).toEqual({
      ok: true,
      args: { tabIds: [1, 2], windowId: 9 },
    });
  });

  it("create_browser_window defaults to an empty urls array and focused true", () => {
    expect(validateBrowserCommand("create_browser_window", {})).toEqual({ ok: true, args: { urls: [], focused: true } });
  });

  it("create_browser_window rejects an unsafe url in its optional urls array", () => {
    expect(validateBrowserCommand("create_browser_window", { urls: ["javascript:alert(1)"] }).ok).toBe(false);
  });
});

describe("get_history validation", () => {
  it("rejects a missing or negative startTime", () => {
    expect(validateBrowserCommand("get_history", {}).ok).toBe(false);
    expect(validateBrowserCommand("get_history", { startTime: -1 }).ok).toBe(false);
    expect(validateBrowserCommand("get_history", { startTime: "1000" }).ok).toBe(false);
  });

  it("accepts a bare startTime, defaulting endTime to undefined and maxResults to the cap", () => {
    expect(validateBrowserCommand("get_history", { startTime: 1000 })).toEqual({
      ok: true,
      args: { startTime: 1000, endTime: undefined, maxResults: 5000 },
    });
  });

  it("rejects an endTime earlier than startTime", () => {
    expect(validateBrowserCommand("get_history", { startTime: 1000, endTime: 500 }).ok).toBe(false);
  });

  it("accepts a well-formed range with an explicit maxResults", () => {
    expect(validateBrowserCommand("get_history", { startTime: 1000, endTime: 2000, maxResults: 100 })).toEqual({
      ok: true,
      args: { startTime: 1000, endTime: 2000, maxResults: 100 },
    });
  });

  it("caps an oversized maxResults instead of rejecting it", () => {
    const result = validateBrowserCommand("get_history", { startTime: 0, maxResults: 999999 });
    expect(result).toEqual({ ok: true, args: { startTime: 0, endTime: undefined, maxResults: 5000 } });
  });

  it("rejects a zero or malformed maxResults", () => {
    expect(validateBrowserCommand("get_history", { startTime: 0, maxResults: 0 }).ok).toBe(false);
    expect(validateBrowserCommand("get_history", { startTime: 0, maxResults: -5 }).ok).toBe(false);
    expect(validateBrowserCommand("get_history", { startTime: 0, maxResults: "lots" }).ok).toBe(false);
  });
});

describe("open_session", () => {
  const tabs = [{ url: "https://a.example/" }, { url: "https://b.example/", pinned: true }];

  it("accepts a request id and ordinary web addresses, normalising pinned", () => {
    expect(validateBrowserCommand("open_session", { requestId: "r1", tabs })).toEqual({
      ok: true,
      args: { requestId: "r1", tabs: [{ url: "https://a.example/", pinned: false }, { url: "https://b.example/", pinned: true }] },
    });
  });

  it("refuses a missing or oversized request id", () => {
    expect(validateBrowserCommand("open_session", { tabs }).ok).toBe(false);
    expect(validateBrowserCommand("open_session", { requestId: "x".repeat(101), tabs }).ok).toBe(false);
  });

  it("refuses any address that is not an ordinary web page", () => {
    for (const url of ["javascript:alert(1)", "chrome://settings", "file:///etc/passwd", "data:text/html,x"]) {
      expect(validateBrowserCommand("open_session", { requestId: "r", tabs: [{ url: "https://a.example/" }, { url }] }).ok).toBe(false);
    }
    expect(validateBrowserCommand("open_session", { requestId: "r", tabs: [{ url: "https://a.example/", pinned: "yes" }] }).ok).toBe(false);
  });

  it("refuses an empty launch and one larger than a session holds", () => {
    expect(validateBrowserCommand("open_session", { requestId: "r", tabs: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_SESSION_TABS + 1 }, (_, i) => ({ url: `https://example.com/${i}` }));
    expect(validateBrowserCommand("open_session", { requestId: "r", tabs: many }).ok).toBe(false);
    expect(validateBrowserCommand("open_session", { requestId: "r", tabs: many.slice(0, MAX_SESSION_TABS) }).ok).toBe(true);
  });
});
