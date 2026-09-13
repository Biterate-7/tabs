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

/**
 * Repairing references that point outside their own workspace.
 *
 * A tab whose sectionId names a section in a DIFFERENT workspace is a
 * dangling reference. Locally it is nearly invisible — the tab just looks
 * unsectioned. On the server it is a foreign key violation
 * (tabdump_tabs_section_same_workspace), and because that constraint is
 * deferred it fails the whole push at COMMIT with a 500, stranding every
 * tab in the workspace.
 *
 * moveTabsBetweenWorkspaces no longer creates these (see store.test.ts).
 * This is the other half: data already written by the version that did must
 * heal on load, or an affected browser retries a doomed push forever. The
 * tab itself is always kept — only the unresolvable reference is dropped.
 */
describe("loadWorkspaceStore repairs cross-workspace references", () => {
  function seedTwoWorkspaces(tab: Record<string, unknown>) {
    window.localStorage.setItem(
      "tabdump:workspaces:v1",
      JSON.stringify({
        version: 1,
        currentId: "w2",
        workspaces: [
          {
            id: "w1",
            name: "Origin",
            createdAt: 1,
            updatedAt: 2,
            sections: [{ id: "s-in-w1", parentId: null, name: "Reading", source: "user", createdAt: 1, updatedAt: 1 }],
            groups: [{ id: "g-in-w1", name: "Papers", createdAt: 1, updatedAt: 1 }],
            tabs: [],
          },
          {
            id: "w2",
            name: "Destination",
            createdAt: 1,
            updatedAt: 2,
            sections: [{ id: "s-in-w2", parentId: null, name: "Own", source: "user", createdAt: 1, updatedAt: 1 }],
            tabs: [{ id: "t1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com", ...tab }],
          },
        ],
      })
    );
  }

  function destinationTab() {
    const store = loadWorkspaceStore();
    expect(store).not.toBeNull();
    const w2 = store!.workspaces.find((w) => w.id === "w2")!;
    expect(w2.tabs).toHaveLength(1);
    return w2.tabs[0];
  }

  it("drops a sectionId belonging to another workspace", () => {
    seedTwoWorkspaces({ sectionId: "s-in-w1" });
    expect(destinationTab().sectionId).toBeUndefined();
  });

  it("drops a groupId belonging to another workspace", () => {
    seedTwoWorkspaces({ groupId: "g-in-w1" });
    expect(destinationTab().groupId).toBeUndefined();
  });

  it("drops a sectionId that names no section anywhere", () => {
    seedTwoWorkspaces({ sectionId: "s-does-not-exist" });
    expect(destinationTab().sectionId).toBeUndefined();
  });

  it("keeps a sectionId that does belong to this workspace", () => {
    seedTwoWorkspaces({ sectionId: "s-in-w2" });
    expect(destinationTab().sectionId).toBe("s-in-w2");
  });

  it("keeps the tab and its other fields when it drops the reference", () => {
    seedTwoWorkspaces({ sectionId: "s-in-w1", notes: "keep me", category: "research" });
    const tab = destinationTab();
    expect(tab.sectionId).toBeUndefined();
    expect(tab.notes).toBe("keep me");
    expect(tab.category).toBe("research");
    expect(tab.url).toBe("https://a.com");
  });

  it("clears sectionLocked when the section it referred to is dropped", () => {
    seedTwoWorkspaces({ sectionId: "s-in-w1", sectionLocked: true });
    const tab = destinationTab();
    expect(tab.sectionId).toBeUndefined();
    expect(tab.sectionLocked).toBeFalsy();
  });
});
