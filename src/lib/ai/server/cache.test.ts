import { afterEach, describe, expect, it, vi } from "vitest";
import { readCache, writeCache, hashText, __clearServerCacheForTests } from "./cache";

afterEach(() => {
  __clearServerCacheForTests();
  vi.useRealTimers();
});

describe("readCache/writeCache", () => {
  it("returns undefined for a key that was never written", () => {
    expect(readCache("nope")).toBeUndefined();
  });

  it("returns undefined once a written entry's TTL has elapsed", () => {
    vi.useFakeTimers();
    writeCache("k", { ok: true, data: 1 }, 100);
    expect(readCache("k")).toEqual({ ok: true, data: 1 });
    vi.advanceTimersByTime(101);
    expect(readCache("k")).toBeUndefined();
  });
});

describe("hashText", () => {
  it("is deterministic for identical input", () => {
    expect(hashText("hello world")).toBe(hashText("hello world"));
  });

  it("differs for different input", () => {
    expect(hashText("hello")).not.toBe(hashText("world"));
  });
});
