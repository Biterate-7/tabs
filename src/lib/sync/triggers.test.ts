import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSyncTriggers, looksOnline } from "./triggers";

/**
 * When sync runs, and — just as importantly — that nothing keeps running
 * after teardown.
 *
 * A leaked listener or timer is the classic StrictMode defect: development
 * mounts, unmounts and remounts an effect, and a subscription that did not
 * clean up leaves two of everything, firing twice forever.
 */

let now = 1_700_000_000_000;

function advance(ms: number): void {
  now += ms;
}

beforeEach(() => {
  now = 1_700_000_000_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cleanup", () => {
  it("removes every listener it added", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");

    const teardown = installSyncTriggers(() => {}, { now: () => now });

    const added = add.mock.calls.map(([type]) => type).filter((t) => t === "online" || t === "focus");
    expect(added.sort()).toEqual(["focus", "online"]);
    expect(docAdd.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);

    teardown();

    const removed = remove.mock.calls.map(([type]) => type).filter((t) => t === "online" || t === "focus");
    expect(removed.sort()).toEqual(["focus", "online"]);
    expect(docRemove.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);
  });

  it("stops firing after teardown", () => {
    const trigger = vi.fn();
    const teardown = installSyncTriggers(trigger, { periodMs: 1000, now: () => now });

    advance(5000);
    vi.advanceTimersByTime(1000);
    expect(trigger).toHaveBeenCalledTimes(1);

    teardown();
    advance(5000);
    vi.advanceTimersByTime(5000);
    // Still one: the timer is cleared and the listeners are gone.
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("is safe to tear down twice", () => {
    const teardown = installSyncTriggers(() => {}, { now: () => now });
    teardown();
    expect(() => teardown()).not.toThrow();
  });

  it("a second install does not inherit the first one's listeners", () => {
    // What a StrictMode mount/unmount/remount produces.
    const first = vi.fn();
    const teardownFirst = installSyncTriggers(first, { periodMs: 1000, now: () => now });
    teardownFirst();

    const second = vi.fn();
    const teardownSecond = installSyncTriggers(second, { periodMs: 1000, now: () => now });
    advance(5000);
    vi.advanceTimersByTime(1000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    teardownSecond();
  });
});

describe("coalescing", () => {
  it("collapses a burst of triggers into one", () => {
    const trigger = vi.fn();
    const teardown = installSyncTriggers(trigger, { now: () => now });

    // A returning user typically fires all three within milliseconds.
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(trigger).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("fires again once the window has passed", () => {
    const trigger = vi.fn();
    const teardown = installSyncTriggers(trigger, { now: () => now });

    window.dispatchEvent(new Event("focus"));
    expect(trigger).toHaveBeenCalledTimes(1);

    advance(10_000);
    window.dispatchEvent(new Event("focus"));
    expect(trigger).toHaveBeenCalledTimes(2);
    teardown();
  });
});

describe("visibility", () => {
  it("does not poll while the tab is hidden", () => {
    const trigger = vi.fn();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const teardown = installSyncTriggers(trigger, { periodMs: 1000, now: () => now });

    advance(5000);
    vi.advanceTimersByTime(3000);
    // A hidden tab has no user to serve and no reason to poll.
    expect(trigger).not.toHaveBeenCalled();
    teardown();
  });
});

describe("connectivity is a hint, not proof", () => {
  it("reads navigator.onLine when present", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(looksOnline()).toBe(false);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(looksOnline()).toBe(true);
  });
});
