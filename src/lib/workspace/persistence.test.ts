import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  isStorageAvailable,
  loadWorkspace,
  saveWorkspace,
  clearWorkspaceStorage,
  loadWorkspaceStore,
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

/**
 * localStorage is untrusted persisted input, not something TabDump can
 * assume it wrote itself in the current schema: a user can edit it, an
 * import written before the type checks existed can have left a wrong-typed
 * field in it, and an export from a newer build can carry a changed shape.
 *
 * This matters more than it looks. `title?.trim()` appears in ~13 render
 * paths and `?.` guards null, not a number — so a single tab with
 * `"title": 12345` used to take the WHOLE app down at startup with
 * "This page couldn't load", graph view included. Found by seeding exactly
 * this into the packaged desktop build, not by a unit test.
 *
 * The contract is recovery, not deletion: keep every record, strip only the
 * fields that are the wrong type. Nothing here removes a tab.
 */
describe("loadWorkspaceStore tolerates wrong-typed tab fields", () => {
  function seed(tab: Record<string, unknown>) {
    window.localStorage.setItem(
      "tabdump:workspaces:v1",
      JSON.stringify({
        version: 1,
        currentId: "w1",
        workspaces: [
          {
            id: "w1",
            name: "W",
            createdAt: 1,
            updatedAt: 2,
            tabs: [{ id: "t1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com", ...tab }],
          },
        ],
      })
    );
  }

  it.each(["title", "category", "favicon", "notes", "organizationReason"])(
    "drops a non-string %s instead of loading it",
    (field) => {
      seed({ [field]: 12345 });
      const store = loadWorkspaceStore();
      expect(store).not.toBeNull();
      const tab = store!.workspaces[0].tabs[0] as unknown as Record<string, unknown>;
      expect(tab[field]).toBeUndefined();
    }
  );

  it("survives the exact expression that crashed the app", () => {
    for (const bad of [12345, { evil: true }, ["a"], true]) {
      seed({ title: bad });
      const store = loadWorkspaceStore();
      const tab = store!.workspaces[0].tabs[0];
      expect(() => tab.title?.trim() || tab.domain).not.toThrow();
    }
  });

  it("keeps the tab itself, and every well-typed field on it", () => {
    seed({ title: 12345, category: "research", notes: "keep me" });
    const store = loadWorkspaceStore();
    const tab = store!.workspaces[0].tabs[0];
    expect(store!.workspaces[0].tabs).toHaveLength(1);
    expect(tab.url).toBe("https://a.com");
    expect(tab.category).toBe("research");
    expect(tab.notes).toBe("keep me");
    expect(tab.title).toBeUndefined();
  });

  it("keeps a tab whose url is unsafe rather than deleting the user's data", () => {
    // Inert: openTab refuses it (see open-tab.ts). Silently deleting rows a
    // previous version stored would be worse than keeping an unopenable one.
    seed({ url: "javascript://example.com/%0aalert(1)" });
    const store = loadWorkspaceStore();
    expect(store!.workspaces[0].tabs).toHaveLength(1);
  });
})
