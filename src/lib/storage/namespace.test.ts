import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCOPED_STORAGE_KEYS,
  copyAnonymousDataInto,
  getStorageNamespace,
  hasAnonymousData,
  hasNamespaceData,
  namespacedKey,
  scopedKey,
  setStorageNamespace,
} from "./namespace";

const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
});

describe("scopedKey", () => {
  it("leaves every key untouched while signed out", () => {
    // The guarantee that installing accounts moves nobody's existing data:
    // signed out, these are byte for byte the keys TabDump always used.
    for (const key of SCOPED_STORAGE_KEYS) {
      expect(scopedKey(key)).toBe(key);
    }
  });

  it("prefixes with the account once signed in", () => {
    setStorageNamespace(ADA);
    expect(scopedKey("tabdump:workspaces:v1")).toBe(`tabdump:u:${ADA}:workspaces:v1`);
  });

  it("gives two accounts different keys for the same data", () => {
    setStorageNamespace(ADA);
    const adaKey = scopedKey("tabdump:workspaces:v1");
    setStorageNamespace(GRACE);
    expect(scopedKey("tabdump:workspaces:v1")).not.toBe(adaKey);
  });

  it("round-trips through setStorageNamespace", () => {
    expect(getStorageNamespace()).toBeNull();
    setStorageNamespace(ADA);
    expect(getStorageNamespace()).toBe(ADA);
    setStorageNamespace(null);
    expect(getStorageNamespace()).toBeNull();
  });

  it("handles a key that doesn't carry the shared prefix", () => {
    setStorageNamespace(ADA);
    expect(namespacedKey("something-else", ADA)).toBe(`tabdump:u:${ADA}:something-else`);
  });
});

describe("cross-account isolation", () => {
  it("stops one account from reading another's stored data", () => {
    setStorageNamespace(ADA);
    window.localStorage.setItem(scopedKey("tabdump:workspaces:v1"), '{"owner":"ada"}');

    setStorageNamespace(GRACE);
    expect(window.localStorage.getItem(scopedKey("tabdump:workspaces:v1"))).toBeNull();

    window.localStorage.setItem(scopedKey("tabdump:workspaces:v1"), '{"owner":"grace"}');
    expect(window.localStorage.getItem(scopedKey("tabdump:workspaces:v1"))).toBe('{"owner":"grace"}');

    // And Ada's is still exactly where she left it.
    setStorageNamespace(ADA);
    expect(window.localStorage.getItem(scopedKey("tabdump:workspaces:v1"))).toBe('{"owner":"ada"}');
  });

  it("hides signed-in data from the signed-out state and vice versa", () => {
    window.localStorage.setItem("tabdump:workspaces:v1", '{"owner":"anonymous"}');

    setStorageNamespace(ADA);
    expect(window.localStorage.getItem(scopedKey("tabdump:workspaces:v1"))).toBeNull();

    setStorageNamespace(null);
    expect(window.localStorage.getItem(scopedKey("tabdump:workspaces:v1"))).toBe('{"owner":"anonymous"}');
  });
});

describe("hasAnonymousData / hasNamespaceData", () => {
  it("reports an empty browser as empty", () => {
    expect(hasAnonymousData()).toBe(false);
    expect(hasNamespaceData(ADA)).toBe(false);
  });

  it("notices signed-out data in any of the scoped keys", () => {
    window.localStorage.setItem("tabdump:graph:v1", "{}");
    expect(hasAnonymousData()).toBe(true);
  });

  it("ignores unrelated keys", () => {
    // Appearance settings are device-level and deliberately unscoped, so
    // they must never read as "this browser has workspaces to bring in".
    window.localStorage.setItem("tabdump:settings:v1", "{}");
    expect(hasAnonymousData()).toBe(false);
  });

  it("notices an account's own data", () => {
    window.localStorage.setItem(namespacedKey("tabdump:workspaces:v1", ADA), "{}");
    expect(hasNamespaceData(ADA)).toBe(true);
    expect(hasNamespaceData(GRACE)).toBe(false);
  });
});

describe("copyAnonymousDataInto", () => {
  it("copies every scoped key that exists", () => {
    window.localStorage.setItem("tabdump:workspaces:v1", '{"w":1}');
    window.localStorage.setItem("tabdump:collections:v1", '{"c":1}');

    const { copied, failed } = copyAnonymousDataInto(ADA);

    expect(copied).toEqual(["tabdump:workspaces:v1", "tabdump:collections:v1"]);
    expect(failed).toEqual([]);
    expect(window.localStorage.getItem(namespacedKey("tabdump:workspaces:v1", ADA))).toBe('{"w":1}');
    expect(window.localStorage.getItem(namespacedKey("tabdump:collections:v1", ADA))).toBe('{"c":1}');
  });

  it("leaves the signed-out data exactly where it was", () => {
    // Copy, never move: declining or undoing costs the user nothing, and
    // signing out brings them straight back to their own data.
    window.localStorage.setItem("tabdump:workspaces:v1", '{"w":1}');

    copyAnonymousDataInto(ADA);

    expect(window.localStorage.getItem("tabdump:workspaces:v1")).toBe('{"w":1}');
  });

  it("never overwrites data the account already has", () => {
    window.localStorage.setItem("tabdump:workspaces:v1", '{"anonymous":true}');
    window.localStorage.setItem(namespacedKey("tabdump:workspaces:v1", ADA), '{"real":true}');

    const { copied } = copyAnonymousDataInto(ADA);

    expect(copied).toEqual([]);
    expect(window.localStorage.getItem(namespacedKey("tabdump:workspaces:v1", ADA))).toBe('{"real":true}');
  });

  it("is idempotent", () => {
    window.localStorage.setItem("tabdump:workspaces:v1", '{"w":1}');

    expect(copyAnonymousDataInto(ADA).copied).toHaveLength(1);
    expect(copyAnonymousDataInto(ADA).copied).toHaveLength(0);
  });

  it("copies into one account only", () => {
    window.localStorage.setItem("tabdump:workspaces:v1", '{"w":1}');

    copyAnonymousDataInto(ADA);

    expect(window.localStorage.getItem(namespacedKey("tabdump:workspaces:v1", GRACE))).toBeNull();
  });

  it("reports a key it couldn't write instead of throwing", () => {
    window.localStorage.setItem("tabdump:workspaces:v1", '{"w":1}');
    // A full quota mid-copy: reported back so the caller can say so,
    // rather than aborting the sign-in that triggered it.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    try {
      const { copied, failed } = copyAnonymousDataInto(ADA);
      expect(copied).toEqual([]);
      expect(failed).toEqual(["tabdump:workspaces:v1"]);
    } finally {
      setItem.mockRestore();
    }
  });
});
