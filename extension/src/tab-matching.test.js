import { describe, expect, it } from "vitest";
import { findMatchingTab, normalizeUrlForMatch } from "./tab-matching.js";

function fakeTab(over) {
  return { id: 1, windowId: 1, url: "https://example.com", active: false, ...over };
}

describe("normalizeUrlForMatch", () => {
  it("returns null for an unparseable url", () => {
    expect(normalizeUrlForMatch("not a url")).toBeNull();
  });

  it("treats a trailing slash as equivalent to no trailing slash", () => {
    expect(normalizeUrlForMatch("https://example.com/")).toBe(normalizeUrlForMatch("https://example.com"));
  });

  it("ignores tracking params", () => {
    expect(normalizeUrlForMatch("https://example.com/page?utm_source=x")).toBe(
      normalizeUrlForMatch("https://example.com/page")
    );
  });

  it("keeps non-tracking query params significant", () => {
    expect(normalizeUrlForMatch("https://example.com/page?id=1")).not.toBe(
      normalizeUrlForMatch("https://example.com/page?id=2")
    );
  });
});

describe("findMatchingTab", () => {
  it("finds a tab with the exact same url", () => {
    const tabs = [fakeTab({ id: 1, url: "https://example.com" })];
    expect(findMatchingTab(tabs, "https://example.com")).toBe(tabs[0]);
  });

  it("returns undefined when no open tab matches", () => {
    const tabs = [fakeTab({ id: 1, url: "https://other.com" })];
    expect(findMatchingTab(tabs, "https://example.com")).toBeUndefined();
  });

  it("matches urls that differ only by normalization (trailing slash + tracking params)", () => {
    const tabs = [fakeTab({ id: 1, url: "https://example.com/page?utm_source=newsletter" })];
    expect(findMatchingTab(tabs, "https://example.com/page/")).toBe(tabs[0]);
  });

  it("does not treat genuinely different pages as identical", () => {
    const tabs = [fakeTab({ id: 1, url: "https://example.com/other-page" })];
    expect(findMatchingTab(tabs, "https://example.com/page")).toBeUndefined();
  });

  it("prefers the active tab when multiple open tabs match", () => {
    const tabs = [
      fakeTab({ id: 1, url: "https://example.com", active: false }),
      fakeTab({ id: 2, url: "https://example.com", active: true }),
      fakeTab({ id: 3, url: "https://example.com", active: false }),
    ];
    expect(findMatchingTab(tabs, "https://example.com")).toBe(tabs[1]);
  });

  it("falls back to the first match when none of the matching tabs are active", () => {
    const tabs = [
      fakeTab({ id: 1, url: "https://example.com", active: false }),
      fakeTab({ id: 2, url: "https://example.com", active: false }),
    ];
    expect(findMatchingTab(tabs, "https://example.com")).toBe(tabs[0]);
  });

  it("matches a tab in a different window just the same", () => {
    const tabs = [fakeTab({ id: 1, windowId: 99, url: "https://example.com" })];
    expect(findMatchingTab(tabs, "https://example.com")).toBe(tabs[0]);
  });

  it("returns undefined when the target url itself is unparseable", () => {
    const tabs = [fakeTab({ id: 1, url: "https://example.com" })];
    expect(findMatchingTab(tabs, "not a url")).toBeUndefined();
  });

  it("ignores tabs with no url (e.g. still loading)", () => {
    const tabs = [fakeTab({ id: 1, url: undefined })];
    expect(findMatchingTab(tabs, "https://example.com")).toBeUndefined();
  });

  it("returns undefined for an empty tab list", () => {
    expect(findMatchingTab([], "https://example.com")).toBeUndefined();
  });
});
