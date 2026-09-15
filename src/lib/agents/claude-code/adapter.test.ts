import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeAdapter } from "./adapter";
import { CLAUDE_CODE_PROVIDER } from "./types";
import type { ClaudeObservationResponse } from "./contract";

const SESSION = "b70abc10-f01a-48de-8d41-8ac936e8eff8";

function response(over: Partial<ClaudeObservationResponse> = {}): ClaudeObservationResponse {
  return {
    available: true,
    sessions: [],
    observations: [],
    cursor: "cursor-1",
    ...over,
  };
}

/** A scheduler the test drives by hand, so nothing depends on real time. */
function manualScheduler() {
  const handlers: Array<() => void> = [];
  return {
    scheduler: {
      setInterval: (handler: () => void) => {
        handlers.push(handler);
        return handlers.length as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (handle: ReturnType<typeof setInterval>) => {
        handlers.splice((handle as unknown as number) - 1, 1);
      },
    },
    tick: () => handlers.forEach((handler) => handler()),
    get count() {
      return handlers.length;
    },
  };
}

describe("the adapter's surface", () => {
  it("offers observation only — no way to act on a session", () => {
    const adapter = createClaudeCodeAdapter({ fetchObservations: async () => response() });

    expect(adapter.provider).toBe(CLAUDE_CODE_PROVIDER);
    for (const forbidden of ["start", "stop", "kill", "cancel", "exec", "prompt", "sendMessage", "write"]) {
      expect(adapter).not.toHaveProperty(forbidden);
    }
  });
});

describe("polling lifecycle", () => {
  it("polls immediately on the first subscription", async () => {
    const fetchObservations = vi.fn(async () => response());
    const adapter = createClaudeCodeAdapter({ fetchObservations, ...manualScheduler() });

    adapter.subscribe(vi.fn());
    await adapter.refresh();

    expect(fetchObservations).toHaveBeenCalled();
  });

  it("runs exactly one timer no matter how many subscribers there are", () => {
    const manual = manualScheduler();
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => response(),
      scheduler: manual.scheduler,
    });

    const first = adapter.subscribe(vi.fn());
    const second = adapter.subscribe(vi.fn());
    expect(manual.count).toBe(1);

    first();
    expect(manual.count).toBe(1);

    second();
    expect(manual.count).toBe(0);
  });

  it("stops polling once the last subscriber leaves", () => {
    const manual = manualScheduler();
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => response(),
      scheduler: manual.scheduler,
    });

    const unsubscribe = adapter.subscribe(vi.fn());
    unsubscribe();

    expect(manual.count).toBe(0);
  });

  it("tolerates unsubscribing twice", () => {
    const manual = manualScheduler();
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => response(),
      scheduler: manual.scheduler,
    });

    const unsubscribe = adapter.subscribe(vi.fn());
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("never runs two polls at once", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const fetchObservations = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return response();
    });

    const adapter = createClaudeCodeAdapter({ fetchObservations, ...manualScheduler() });

    await Promise.all([adapter.refresh(), adapter.refresh(), adapter.refresh()]);

    expect(maxConcurrent).toBe(1);
  });
});

describe("delivering observations", () => {
  it("hands observations to every subscriber", async () => {
    const observations = [{ provider: CLAUDE_CODE_PROVIDER, externalId: SESSION }];
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => response({ observations }),
      ...manualScheduler(),
    });

    const first = vi.fn();
    const second = vi.fn();
    adapter.subscribe(first);
    adapter.subscribe(second);
    await adapter.refresh();

    expect(first).toHaveBeenCalledWith(observations);
    expect(second).toHaveBeenCalledWith(observations);
  });

  it("does not notify anyone when a poll found nothing new", async () => {
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => response({ observations: [] }),
      ...manualScheduler(),
    });

    const observer = vi.fn();
    adapter.subscribe(observer);
    await adapter.refresh();

    expect(observer).not.toHaveBeenCalled();
  });

  it("carries the cursor forward between polls", async () => {
    const seen: string[] = [];
    let n = 0;
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async (cursor) => {
        seen.push(cursor);
        n += 1;
        return response({ cursor: `cursor-${n}` });
      },
      ...manualScheduler(),
    });

    await adapter.refresh();
    await adapter.refresh();
    await adapter.refresh();

    expect(seen).toEqual(["", "cursor-1", "cursor-2"]);
  });

  it("keeps the previous cursor when a poll fails, so nothing is skipped", async () => {
    const seen: string[] = [];
    let call = 0;
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async (cursor) => {
        seen.push(cursor);
        call += 1;
        if (call === 2) throw new Error("network");
        return response({ cursor: "cursor-1" });
      },
      ...manualScheduler(),
    });

    await adapter.refresh();
    await adapter.refresh();
    await adapter.refresh();

    expect(seen).toEqual(["", "cursor-1", "cursor-1"]);
  });

  it("survives a failing poll without throwing at its subscribers", async () => {
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => {
        throw new Error("offline");
      },
      ...manualScheduler(),
    });

    const observer = vi.fn();
    adapter.subscribe(observer);

    await expect(adapter.refresh()).resolves.toBeUndefined();
    expect(observer).not.toHaveBeenCalled();
    expect(adapter.isAvailable()).toBe(false);
  });
});

describe("availability and sessions", () => {
  it("reports availability from the last poll", async () => {
    let available = true;
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => response({ available }),
      ...manualScheduler(),
    });

    await adapter.refresh();
    expect(adapter.isAvailable()).toBe(true);

    available = false;
    await adapter.refresh();
    expect(adapter.isAvailable()).toBe(false);
  });

  it("exposes the sessions seen on the last poll", async () => {
    const sessions = [
      { externalId: SESSION, projectPath: "C:/p", lastObservedAt: 1 },
    ];
    const adapter = createClaudeCodeAdapter({
      fetchObservations: async () => response({ sessions }),
      ...manualScheduler(),
    });

    await adapter.refresh();
    expect(adapter.getSessions()).toEqual(sessions);
  });
});
