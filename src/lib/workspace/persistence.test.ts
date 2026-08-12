import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  isStorageAvailable,
  loadWorkspace,
  saveWorkspace,
  clearWorkspaceStorage,
} from "./persistence";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * jsdom's `localStorage` is a legacy-platform-object whose methods can't be
 * shadowed by plain reassignment or `vi.spyOn` (both are silently ignored on
 * subsequent calls) — replacing the whole global is what actually sticks.
 */
function stubThrowingLocalStorage(method: "setItem" | "removeItem") {
  vi.stubGlobal("localStorage", {
    ...window.localStorage,
    [method]: () => {
      throw new Error("storage unavailable");
    },
  });
}

describe("isStorageAvailable", () => {
  it("returns true when localStorage works normally", () => {
    expect(isStorageAvailable()).toBe(true);
  });

  it("returns false when localStorage throws", () => {
    stubThrowingLocalStorage("setItem");
    expect(isStorageAvailable()).toBe(false);
  });
});

describe("loadWorkspace", () => {
  it("returns null when nothing is stored", () => {
    expect(loadWorkspace()).toBeNull();
  });

  it("returns null for corrupted JSON", () => {
    window.localStorage.setItem("tabdump:workspace:v1", "{not json");
    expect(loadWorkspace()).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    window.localStorage.setItem(
      "tabdump:workspace:v1",
      JSON.stringify({ tabs: "nope" })
    );
    expect(loadWorkspace()).toBeNull();
  });

  it("round-trips tabs saved by saveWorkspace", () => {
    const tabs = [makeTab({ id: "1" }), makeTab({ id: "2", category: "research" })];
    saveWorkspace(tabs);
    expect(loadWorkspace()).toEqual(tabs);
  });
});

describe("saveWorkspace", () => {
  it("returns true on success", () => {
    expect(saveWorkspace([makeTab({ id: "1" })])).toBe(true);
  });

  it("returns false when storage throws", () => {
    stubThrowingLocalStorage("setItem");
    expect(saveWorkspace([makeTab({ id: "1" })])).toBe(false);
  });
});

describe("clearWorkspaceStorage", () => {
  it("removes the stored workspace", () => {
    saveWorkspace([makeTab({ id: "1" })]);
    clearWorkspaceStorage();
    expect(loadWorkspace()).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    stubThrowingLocalStorage("removeItem");
    expect(() => clearWorkspaceStorage()).not.toThrow();
  });
});
