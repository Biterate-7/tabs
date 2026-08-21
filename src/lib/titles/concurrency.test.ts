import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("runWithConcurrency", () => {
  it("returns results in the same order as the input", async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: 6 }, () => deferred<void>());

    const run = runWithConcurrency(gates, 2, async (gate) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
    });

    // Let the first wave of workers start and block on their gates.
    await new Promise((r) => setTimeout(r, 0));
    expect(active).toBe(2);

    for (const gate of gates) gate.resolve();
    await run;

    expect(maxActive).toBe(2);
  });

  it("resolves a failing item as undefined instead of rejecting the batch", async () => {
    const results = await runWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results).toEqual([1, undefined, 3]);
  });

  it("handles an empty input list", async () => {
    const results = await runWithConcurrency([], 4, async (n: number) => n);
    expect(results).toEqual([]);
  });

  it("handles a limit larger than the item count", async () => {
    const results = await runWithConcurrency([1, 2], 10, async (n) => n);
    expect(results).toEqual([1, 2]);
  });
});
