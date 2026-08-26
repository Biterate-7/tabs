import { describe, expect, it } from "vitest";
import { ALLOWED_BROWSER_ACTIONS, isSafeOpenUrl, validateBrowserCommand } from "./browser-commands.js";

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

  it("exposes exactly the spec's read/open/close/pin/window actions", () => {
    expect([...ALLOWED_BROWSER_ACTIONS].sort()).toEqual(
      [
        "list_browser_tabs",
        "get_active_tab",
        "list_browser_windows",
        "open_url",
        "open_tabs",
        "close_tab",
        "close_tabs",
        "pin_tab",
        "unpin_tab",
        "move_tabs_to_window",
        "create_browser_window",
      ].sort()
    );
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
