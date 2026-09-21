import { beforeEach, describe, expect, it, vi } from "vitest";
import { RETIRED_STORAGE_KEYS, SCOPED_STORAGE_KEYS } from "./namespace";
import { isRetiredKey, sweepRetiredStorage } from "./retired";

/**
 * Removing a feature has to remove its storage.
 *
 * The Agent World is gone from the code, which leaves `tabdump:agent-world:v1`
 * sitting in every existing user's localStorage — under the signed-out key and
 * under one namespaced key per account that ever used it — with nothing left in
 * the shipped app that could read or clear it. These cases pin both halves:
 * that the retired key really goes, and that nothing else does.
 */

const RETIRED = "tabdump:agent-world:v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("isRetiredKey", () => {
  it("matches the global spelling", () => {
    expect(isRetiredKey(RETIRED, [RETIRED])).toBe(true);
  });

  it("matches the namespaced spelling, for any account", () => {
    expect(isRetiredKey("tabdump:u:user-1:agent-world:v1", [RETIRED])).toBe(true);
    expect(isRetiredKey("tabdump:u:someone-else:agent-world:v1", [RETIRED])).toBe(true);
  });

  it("does not match a key that merely starts the same way", () => {
    expect(isRetiredKey("tabdump:agent-world:v2", [RETIRED])).toBe(false);
    expect(isRetiredKey("tabdump:agent-worlds:v1", [RETIRED])).toBe(false);
  });

  it("does not match any key TabDump still writes", () => {
    for (const key of SCOPED_STORAGE_KEYS) {
      expect(isRetiredKey(key, RETIRED_STORAGE_KEYS)).toBe(false);
      expect(isRetiredKey(`tabdump:u:user-1:${key.slice("tabdump:".length)}`, RETIRED_STORAGE_KEYS)).toBe(
        false
      );
    }
  });

  it("ignores another origin's keys entirely", () => {
    expect(isRetiredKey("agent-world:v1", [RETIRED])).toBe(false);
    expect(isRetiredKey("someoneelse:agent-world:v1", [RETIRED])).toBe(false);
  });
});

describe("sweepRetiredStorage", () => {
  it("removes the retired key in both spellings and reports the count", () => {
    window.localStorage.setItem(RETIRED, "{}");
    window.localStorage.setItem("tabdump:u:a:agent-world:v1", "{}");
    window.localStorage.setItem("tabdump:u:b:agent-world:v1", "{}");

    expect(sweepRetiredStorage([RETIRED])).toBe(3);
    expect(window.localStorage.getItem(RETIRED)).toBeNull();
    expect(window.localStorage.getItem("tabdump:u:a:agent-world:v1")).toBeNull();
    expect(window.localStorage.getItem("tabdump:u:b:agent-world:v1")).toBeNull();
  });

  it("leaves every other key untouched", () => {
    // The blast radius test. A bug here deletes somebody's workspaces.
    const survivors: Record<string, string> = {
      "tabdump:workspaces:v1": "w",
      "tabdump:u:a:workspaces:v1": "w",
      "tabdump:collections:v1": "c",
      "tabdump:agents:v1": "a",
      "tabdump:connectors:v1": "n",
      "tabdump:appearance:v1": "p",
      "unrelated-app:data": "x",
    };
    for (const [key, value] of Object.entries(survivors)) {
      window.localStorage.setItem(key, value);
    }
    window.localStorage.setItem(RETIRED, "{}");

    expect(sweepRetiredStorage([RETIRED])).toBe(1);
    for (const [key, value] of Object.entries(survivors)) {
      expect(window.localStorage.getItem(key)).toBe(value);
    }
  });

  it("removes every match even though removal reindexes the store", () => {
    // Removing during enumeration silently skips entries. Enough keys here
    // that an in-loop removal would leave some behind.
    for (let index = 0; index < 8; index += 1) {
      // Interleaved with keys that must survive, so a naive in-loop removal
      // skips retired entries rather than merely reordering them.
      window.localStorage.setItem(`tabdump:u:user-${index}:workspaces:v1`, "w");
      window.localStorage.setItem(`tabdump:u:user-${index}:agent-world:v1`, "{}");
    }

    sweepRetiredStorage([RETIRED]);

    const leftovers: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && isRetiredKey(key, [RETIRED])) leftovers.push(key);
    }
    expect(leftovers).toEqual([]);
  });

  it("is a no-op the second time", () => {
    window.localStorage.setItem(RETIRED, "{}");
    expect(sweepRetiredStorage([RETIRED])).toBe(1);
    expect(sweepRetiredStorage([RETIRED])).toBe(0);
  });

  it("does nothing, and does not throw, when there is nothing to remove", () => {
    expect(sweepRetiredStorage([RETIRED])).toBe(0);
  });

  it("survives storage being unavailable", () => {
    // A private window, a blocked origin, or a full quota. A failed cleanup
    // must never stop the app from starting.
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });

    expect(() => sweepRetiredStorage([RETIRED])).not.toThrow();
    expect(sweepRetiredStorage([RETIRED])).toBe(0);

    if (original) Object.defineProperty(window, "localStorage", original);
  });

  it("survives one key refusing to be removed, and still clears the rest", () => {
    window.localStorage.setItem(RETIRED, "{}");
    window.localStorage.setItem("tabdump:u:a:agent-world:v1", "{}");

    const realRemove = Storage.prototype.removeItem;
    const spy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === RETIRED) throw new Error("locked");
        realRemove.call(this, key);
      });

    expect(sweepRetiredStorage([RETIRED])).toBe(1);
    spy.mockRestore();

    expect(window.localStorage.getItem("tabdump:u:a:agent-world:v1")).toBeNull();
  });

  it("does nothing when given an empty retired list", () => {
    window.localStorage.setItem(RETIRED, "{}");
    expect(sweepRetiredStorage([])).toBe(0);
    expect(window.localStorage.getItem(RETIRED)).toBe("{}");
  });
});

describe("the shipped retired list", () => {
  it("names the Agent World's key", () => {
    expect(RETIRED_STORAGE_KEYS).toContain(RETIRED);
  });

  it("names nothing the app still writes", () => {
    // A key in both lists would be swept on every load, moments after being
    // written. The two lists must stay disjoint.
    for (const key of RETIRED_STORAGE_KEYS) {
      expect(SCOPED_STORAGE_KEYS).not.toContain(key);
    }
  });
});
