import { afterEach, describe, expect, it, vi } from "vitest";
import { withCache, readCache, writeCache, hashText, __clearServerCacheForTests } from "./cache";
import type { GeminiResult } from "@/lib/ai/gemini/types";

afterEach(() => {
  __clearServerCacheForTests();
  vi.useRealTimers();
});

describe("withCache", () => {
  it("calls compute on a miss and caches a successful result", async () => {
    const compute = vi.fn(async (): Promise<GeminiResult<string>> => ({ ok: true, data: "value" }));

    const first = await withCache("key-1", compute);
    const second = await withCache("key-1", compute);

    expect(first).toEqual({ ok: true, data: "value" });
    expect(second).toEqual({ ok: true, data: "value" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls for the same key into one compute()", async () => {
    let resolveCompute!: (result: GeminiResult<string>) => void;
    const compute = vi.fn(
      () => new Promise<GeminiResult<string>>((resolve) => { resolveCompute = resolve; })
    );

    const a = withCache("key-concurrent", compute);
    const b = withCache("key-concurrent", compute);
    const c = withCache("key-concurrent", compute);

    expect(compute).toHaveBeenCalledTimes(1);
    resolveCompute({ ok: true, data: "shared" });

    expect(await a).toEqual({ ok: true, data: "shared" });
    expect(await b).toEqual({ ok: true, data: "shared" });
    expect(await c).toEqual({ ok: true, data: "shared" });
  });

  it("clears the in-flight entry even when compute() rejects, so a later call can retry instead of hanging forever", async () => {
    const compute = vi
      .fn<() => Promise<GeminiResult<string>>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, data: "recovered" });

    await expect(withCache("key-reject", compute)).rejects.toThrow("boom");

    const retry = await withCache("key-reject", compute);
    expect(retry).toEqual({ ok: true, data: "recovered" });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("does not cache-coalesce two different keys", async () => {
    const compute = vi.fn(async (): Promise<GeminiResult<string>> => ({ ok: true, data: "v" }));

    await withCache("key-a", compute);
    await withCache("key-b", compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("caches a failure briefly so a retry within the failure TTL doesn't call compute again", async () => {
    const compute = vi.fn(async (): Promise<GeminiResult<string>> => ({ ok: false, reason: "rate-limited" }));

    const first = await withCache("key-fail", compute, { failureTtlMs: 60_000 });
    const second = await withCache("key-fail", compute, { failureTtlMs: 60_000 });

    expect(first).toEqual({ ok: false, reason: "rate-limited" });
    expect(second).toEqual({ ok: false, reason: "rate-limited" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("retries after a cached failure's TTL expires", async () => {
    vi.useFakeTimers();
    const compute = vi
      .fn<() => Promise<GeminiResult<string>>>()
      .mockResolvedValueOnce({ ok: false, reason: "timeout" })
      .mockResolvedValueOnce({ ok: true, data: "recovered" });

    const first = await withCache("key-retry", compute, { failureTtlMs: 1000 });
    expect(first).toEqual({ ok: false, reason: "timeout" });

    vi.advanceTimersByTime(1001);

    const second = await withCache("key-retry", compute, { failureTtlMs: 1000 });
    expect(second).toEqual({ ok: true, data: "recovered" });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("expires a cached success after its TTL", async () => {
    vi.useFakeTimers();
    const compute = vi.fn(async (): Promise<GeminiResult<string>> => ({ ok: true, data: "v" }));

    await withCache("key-expire", compute, { successTtlMs: 500 });
    vi.advanceTimersByTime(600);
    await withCache("key-expire", compute, { successTtlMs: 500 });

    expect(compute).toHaveBeenCalledTimes(2);
  });
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
