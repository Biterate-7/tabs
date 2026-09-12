import { describe, expect, it, vi, afterEach } from "vitest";
import { createTimestamp, isValidTimestamp } from "./timestamps";
import { parseSingleUrl, parseUrls } from "./tabs/parse";
import { stampChangedTabs, tabContentChanged } from "./tabs/touch";
import { stripWrongTypedTabFields } from "./tabs/sanitize";
import {
  createWorkspace,
  createGroup,
  createSectionInWorkspace,
  renameWorkspace,
  updateWorkspaceTabs,
  assignTabsToSection,
} from "./workspace/store";
import { createCollection, renameCollection } from "./collections/relations";
import { addDependency, updateDependencyType } from "./dependencies/relations";
import type { Tab } from "./tabs/types";
import type { WorkspaceStore } from "./workspace/types";

function emptyStore(): WorkspaceStore {
  return { version: 1, currentId: "seed", workspaces: [] } as unknown as WorkspaceStore;
}

function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTimestamp", () => {
  it("returns epoch milliseconds, matching every entity already in the model", () => {
    const before = Date.now();
    const t = createTimestamp();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("is injectable for deterministic tests", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    expect(createTimestamp()).toBe(1_700_000_000_000);
  });
});

describe("isValidTimestamp", () => {
  it("accepts finite numbers", () => {
    for (const good of [0, 1, 1_700_000_000_000, -1]) expect(isValidTimestamp(good)).toBe(true);
  });

  it("rejects everything that would poison a comparison", () => {
    for (const bad of [NaN, Infinity, -Infinity, "1700000000000", null, undefined, {}, [], true]) {
      expect(isValidTimestamp(bad)).toBe(false);
    }
  });
});

describe("creation stamps both fields from one clock read", () => {
  it("gives a parsed tab createdAt === updatedAt", () => {
    const t = parseSingleUrl("https://example.com/a")!;
    expect(t.createdAt).toBeTypeOf("number");
    expect(t.updatedAt).toBe(t.createdAt);
  });

  it("gives every tab in one paste the same pair", () => {
    const { tabs } = parseUrls("https://a.com\nhttps://b.com\nhttps://c.com");
    for (const t of tabs) expect(t.updatedAt).toBe(t.createdAt);
  });

  it("gives a workspace createdAt === updatedAt", () => {
    const store = createWorkspace(emptyStore(), "W");
    const w = store.workspaces[0];
    expect(w.updatedAt).toBe(w.createdAt);
  });

  it("gives a group createdAt === updatedAt", () => {
    const store = createWorkspace(emptyStore(), "W");
    const { group } = createGroup(store, store.workspaces[0].id, "G");
    expect(group.updatedAt).toBe(group.createdAt);
  });

  it("gives a section createdAt === updatedAt", () => {
    const store = createWorkspace(emptyStore(), "W");
    const result = createSectionInWorkspace(store, store.workspaces[0].id, null, "S", "user")!;
    expect(result.section.updatedAt).toBe(result.section.createdAt);
  });

  it("gives a collection createdAt === updatedAt", () => {
    const { collection } = createCollection([], "w1", "C");
    expect(collection.updatedAt).toBe(collection.createdAt);
  });

  it("gives a dependency createdAt === updatedAt", () => {
    const [dep] = addDependency([], "a", "b");
    expect(dep.updatedAt).toBe(dep.createdAt);
  });
});

describe("mutation stamps updatedAt and never createdAt", () => {
  it("renaming a workspace moves updatedAt only", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let store = createWorkspace(emptyStore(), "Before");
    const created = store.workspaces[0];

    vi.spyOn(Date, "now").mockReturnValue(2000);
    store = renameWorkspace(store, created.id, "After");
    const renamed = store.workspaces[0];

    expect(renamed.name).toBe("After");
    expect(renamed.createdAt).toBe(created.createdAt);
    expect(renamed.updatedAt).toBe(2000);
    expect(renamed.updatedAt).not.toBe(renamed.createdAt);
  });

  it("retyping a dependency moves updatedAt only", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const deps = addDependency([], "a", "b");

    const retyped = updateDependencyType(deps, deps[0].id, "reference", 2000);
    expect(retyped[0].createdAt).toBe(1000);
    expect(retyped[0].updatedAt).toBe(2000);
  });

  it("does not stamp a dependency whose type did not actually change", () => {
    const deps = addDependency([], "a", "b", "reference", 1000);
    const same = updateDependencyType(deps, deps[0].id, "reference", 2000);
    expect(same[0]).toBe(deps[0]);
    expect(same[0].updatedAt).toBe(1000);
  });

  it("renaming a collection moves updatedAt only", () => {
    const { collections, collection } = createCollection([], "w1", "Before", [], 1000);
    // renameCollection reads the clock itself rather than taking it as an
    // argument, so the clock is what gets mocked here.
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const renamed = renameCollection(collections, collection.id, "After");
    expect(renamed[0].createdAt).toBe(1000);
    expect(renamed[0].updatedAt).toBe(2000);
  });

  it("renaming one collection leaves the others alone", () => {
    let collections = createCollection([], "w1", "A", [], 1000).collections;
    collections = createCollection(collections, "w1", "B", [], 1000).collections;
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const renamed = renameCollection(collections, collections[0].id, "A2");
    expect(renamed[0].updatedAt).toBe(2000);
    expect(renamed[1].updatedAt).toBe(1000);
    expect(renamed[1]).toBe(collections[1]);
  });
});

describe("only the entity that changed is stamped", () => {
  it("editing one tab leaves the others' updatedAt alone", () => {
    const a = tab({ id: "a", url: "https://a.com", normalizedUrl: "https://a.com", createdAt: 1000, updatedAt: 1000 });
    const b = tab({ id: "b", url: "https://b.com", normalizedUrl: "https://b.com", createdAt: 1000, updatedAt: 1000 });

    const next = stampChangedTabs([a, b], [{ ...a, notes: "edited" }, b], 2000);

    expect(next[0].updatedAt).toBe(2000);
    expect(next[0].createdAt).toBe(1000);
    expect(next[1].updatedAt).toBe(1000);
    expect(next[1]).toBe(b);
  });

  it("assigning a section stamps only the assigned tabs", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let store = createWorkspace(emptyStore(), "W");
    const wid = store.workspaces[0].id;
    store = updateWorkspaceTabs(store, wid, [
      tab({ id: "a", createdAt: 1000, updatedAt: 1000 }),
      tab({ id: "b", url: "https://b.com", normalizedUrl: "https://b.com", createdAt: 1000, updatedAt: 1000 }),
    ]);

    vi.spyOn(Date, "now").mockReturnValue(2000);
    store = assignTabsToSection(store, wid, ["a"], "sec-1");

    const [ta, tb] = store.workspaces[0].tabs;
    expect(ta.sectionId).toBe("sec-1");
    expect(ta.updatedAt).toBe(2000);
    expect(tb.updatedAt).toBe(1000);
  });

  it("re-saving identical tabs stamps nothing", () => {
    const tabs = [
      tab({ id: "a", createdAt: 1000, updatedAt: 1000 }),
      tab({ id: "b", url: "https://b.com", normalizedUrl: "https://b.com", createdAt: 1000, updatedAt: 1000 }),
    ];
    const next = stampChangedTabs(tabs, tabs.map((t) => ({ ...t })), 9999);
    for (const t of next) expect(t.updatedAt).toBe(1000);
  });

  it("recomputed isDuplicate is not a modification", () => {
    // markDuplicates rewrites isDuplicate across the whole list, so treating
    // it as material would stamp every tab whenever any tab moved.
    const before = tab({ id: "a", createdAt: 1000, updatedAt: 1000, isDuplicate: false });
    const after = { ...before, isDuplicate: true };
    expect(tabContentChanged(before, after)).toBe(false);
    expect(stampChangedTabs([before], [after], 9999)[0].updatedAt).toBe(1000);
  });
});

describe("lastAccessedAt stays a separate field", () => {
  it("is not the same field as updatedAt", () => {
    const before = tab({ id: "a", createdAt: 1000, updatedAt: 1000 });
    const opened = { ...before, lastAccessedAt: 5000 };
    const [next] = stampChangedTabs([before], [opened], 2000);

    // Opening a tab IS a change to persisted state, so updatedAt moves —
    // but to the mutation clock, never to lastAccessedAt's value.
    expect(next.updatedAt).toBe(2000);
    expect(next.lastAccessedAt).toBe(5000);
    expect(next.updatedAt).not.toBe(next.lastAccessedAt);
  });

  it("leaves lastAccessedAt untouched when something else changes", () => {
    const before = tab({ id: "a", createdAt: 1000, updatedAt: 1000, lastAccessedAt: 5000 });
    const [next] = stampChangedTabs([before], [{ ...before, notes: "x" }], 2000);
    expect(next.lastAccessedAt).toBe(5000);
    expect(next.updatedAt).toBe(2000);
  });
});

describe("legacy data without timestamps", () => {
  it("loads a tab that has neither field", () => {
    const legacy = tab({ id: "a" });
    expect(legacy.createdAt).toBeUndefined();
    expect(legacy.updatedAt).toBeUndefined();
    expect(() => stampChangedTabs([legacy], [legacy], 2000)).not.toThrow();
  });

  it("does not invent a createdAt when a legacy tab is modified", () => {
    const legacy = tab({ id: "a" });
    const [next] = stampChangedTabs([legacy], [{ ...legacy, notes: "edited" }], 2000);
    expect(next.updatedAt).toBe(2000);
    expect(next.createdAt).toBeUndefined();
  });

  it("does not stamp legacy tabs merely because they were re-saved", () => {
    // The invariant that matters: opening an old workspace must not make
    // every tab look freshly modified.
    const legacy = [tab({ id: "a" }), tab({ id: "b", url: "https://b.com", normalizedUrl: "https://b.com" })];
    const next = stampChangedTabs(legacy, legacy.map((t) => ({ ...t })), 9999);
    for (const t of next) expect(t.updatedAt).toBeUndefined();
  });
});

describe("malformed persisted timestamps are repaired, not fatal", () => {
  it.each([123.5, NaN, Infinity, "yesterday", null, {}, [], true])(
    "drops a createdAt of %s",
    (bad) => {
      const dirty = { ...tab({ id: "a" }), createdAt: bad } as unknown as Tab;
      const repaired = stripWrongTypedTabFields(dirty);
      // 123.5 is a finite number and therefore legitimate; everything else goes.
      if (typeof bad === "number" && Number.isFinite(bad)) {
        expect(repaired.createdAt).toBe(bad);
      } else {
        expect(repaired.createdAt).toBeUndefined();
      }
    }
  );

  it.each([NaN, Infinity, "now", null, {}, [], true])("drops an updatedAt of %s", (bad) => {
    const dirty = { ...tab({ id: "a" }), updatedAt: bad } as unknown as Tab;
    expect(stripWrongTypedTabFields(dirty).updatedAt).toBeUndefined();
  });

  it("keeps the tab itself and every valid field", () => {
    const dirty = { ...tab({ id: "a", notes: "keep" }), createdAt: "bad", updatedAt: 1000 } as unknown as Tab;
    const repaired = stripWrongTypedTabFields(dirty);
    expect(repaired.id).toBe("a");
    expect(repaired.notes).toBe("keep");
    expect(repaired.createdAt).toBeUndefined();
    expect(repaired.updatedAt).toBe(1000);
  });
});
