import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  getCachedTitle,
  shouldSkipResolution,
  recordSuccess,
  recordFailure,
  clearTitleCache,
  __resetTitleCacheForTests,
} from "./cache";

beforeEach(() => {
  window.localStorage.clear();
  __resetTitleCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubThrowingLocalStorage(method: "setItem" | "getItem" | "removeItem") {
  vi.stubGlobal("localStorage", {
    ...window.localStorage,
    [method]: () => {
      throw new Error("storage unavailable");
    },
  });
}

describe("getCachedTitle", () => {
  it("returns null when nothing is cached", () => {
    expect(getCachedTitle("https://example.com")).toBeNull();
  });

  it("returns the title after a successful resolution is recorded", () => {
    recordSuccess("https://example.com", "Example Title", "generic");
    expect(getCachedTitle("https://example.com")).toEqual({
      title: "Example Title",
      source: "generic",
    });
  });

  it("persists across a fresh in-memory hydration from localStorage", () => {
    recordSuccess("https://example.com", "Example Title", "generic");
    __resetTitleCacheForTests();
    expect(getCachedTitle("https://example.com")).toEqual({
      title: "Example Title",
      source: "generic",
    });
  });

  it("does not cache a permanent failure as a title", () => {
    recordFailure("https://example.com", true);
    expect(getCachedTitle("https://example.com")).toBeNull();
  });

  it("ignores a corrupted localStorage blob instead of throwing", () => {
    window.localStorage.setItem("tabdump:titles:v1", "{not json");
    expect(getCachedTitle("https://example.com")).toBeNull();
  });
});

describe("shouldSkipResolution", () => {
  it("is false when there is no cache entry", () => {
    expect(shouldSkipResolution("https://example.com")).toBe(false);
  });

  it("is false for a non-permanent failure (never recorded)", () => {
    recordFailure("https://example.com", false);
    expect(shouldSkipResolution("https://example.com")).toBe(false);
  });

  it("is true shortly after a permanent failure is recorded", () => {
    recordFailure("https://example.com", true);
    expect(shouldSkipResolution("https://example.com")).toBe(true);
  });

  it("is false again once the cooldown window has elapsed", () => {
    vi.useFakeTimers();
    recordFailure("https://example.com", true);
    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // > 24h cooldown
    expect(shouldSkipResolution("https://example.com")).toBe(false);
  });
});

describe("storage unavailability", () => {
  it("degrades to in-memory-only without throwing when localStorage is blocked", () => {
    stubThrowingLocalStorage("setItem");
    expect(() => recordSuccess("https://example.com", "Title", "generic")).not.toThrow();
    expect(getCachedTitle("https://example.com")).toEqual({ title: "Title", source: "generic" });
  });
});

describe("clearTitleCache", () => {
  it("removes all cached entries", () => {
    recordSuccess("https://example.com", "Title", "generic");
    clearTitleCache();
    expect(getCachedTitle("https://example.com")).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    stubThrowingLocalStorage("removeItem");
    expect(() => clearTitleCache()).not.toThrow();
  });
});
