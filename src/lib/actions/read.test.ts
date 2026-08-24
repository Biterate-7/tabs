import { describe, expect, it } from "vitest";
import { getTabAction, getWorkspaceAction, listWorkspacesAction, listWorkspaceTabsAction, searchTabsAction } from "./read";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeTab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", ...over };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("search_tabs action", () => {
  it("finds tabs matching the query across all workspaces by default", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Quantum Physics 101" })] }),
        makeWorkspace({ id: "b", tabs: [makeTab("2", { title: "Shopping list" })] }),
      ],
      "a"
    );
    const validated = searchTabsAction.validate({ query: "physics" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = searchTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.matches.map((m) => m.tabId)).toEqual(["1"]);
  });

  it("rejects a missing query", () => {
    expect(searchTabsAction.validate({}).ok).toBe(false);
  });

  it("returns a score and matchReason on every result", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics IA notes" })] })], "a");
    const validated = searchTabsAction.validate({ query: "physics" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = searchTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.matches[0]).toMatchObject({ tabId: "1", matchReason: "title", score: expect.any(Number) });
  });

  it("uses semanticHints from ctx to find a tab with no keyword overlap", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "S2 star orbit simulation" })] })], "a");
    const validated = searchTabsAction.validate({ query: "orbital mechanics" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const withoutHints = searchTabsAction.run(store, validated.args);
    expect(withoutHints.ok && withoutHints.data.matches).toEqual([]);

    const withHints = searchTabsAction.run(store, validated.args, {
      semanticHints: [{ tabId: "1", workspaceId: "a", score: 0.8 }],
    });
    expect(withHints.ok).toBe(true);
    if (!withHints.ok) return;
    expect(withHints.data.matches.map((m) => m.tabId)).toEqual(["1"]);
    expect(withHints.data.matches[0].matchReason).toBe("semantic");
  });

  it("never returns a tab from outside the given workspaceId scope", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics" })] }),
        makeWorkspace({ id: "b", tabs: [makeTab("2", { title: "Physics" })] }),
      ],
      "a"
    );
    const validated = searchTabsAction.validate({ query: "physics", workspaceId: "a" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = searchTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.matches.map((m) => m.tabId)).toEqual(["1"]);
  });

  it("only ever returns tabs present in the given store snapshot — semantic hints for unknown ids are simply ignored, not trusted to conjure results", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics" })] })], "a");
    const validated = searchTabsAction.validate({ query: "orbital mechanics" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = searchTabsAction.run(store, validated.args, {
      semanticHints: [{ tabId: "ghost-tab-not-in-store", workspaceId: "a", score: 0.99 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.matches).toEqual([]);
  });

  describe("browser tab search", () => {
    const browserContext = {
      tabs: [{ tabId: 7, windowId: 1, url: "https://x.com", title: "Physics research", pinned: false, active: true, index: 0 }],
      windows: [],
      activeTabId: 7,
    };

    it("merges live browser tab matches in alongside saved tabs, tagged by source", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics IA" })] })], "a");
      const validated = searchTabsAction.validate({ query: "physics" });
      if (!validated.ok) throw new Error("expected validation to pass");

      const result = searchTabsAction.run(store, validated.args, { browserContext });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sources = result.data.matches.map((m) => m.source).sort();
      expect(sources).toEqual(["browser", "tabdump"]);
      const browserMatch = result.data.matches.find((m) => m.source === "browser")!;
      expect(browserMatch).toMatchObject({ tabId: "browser:7", browserTabId: 7 });
    });

    it("does not include browser tabs when the extension isn't connected", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics IA" })] })], "a");
      const validated = searchTabsAction.validate({ query: "physics" });
      if (!validated.ok) throw new Error("expected validation to pass");

      const result = searchTabsAction.run(store, validated.args);
      expect(result.ok && result.data.matches.every((m) => m.source !== "browser")).toBe(true);
    });

    it("excludes browser tabs when includeBrowser is explicitly false", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics IA" })] })], "a");
      const validated = searchTabsAction.validate({ query: "physics", includeBrowser: false });
      if (!validated.ok) throw new Error("expected validation to pass");

      const result = searchTabsAction.run(store, validated.args, { browserContext });
      expect(result.ok && result.data.matches.every((m) => m.source !== "browser")).toBe(true);
    });

    it("can return a browser-only match with no saved-tab equivalent", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: [] })], "a");
      const validated = searchTabsAction.validate({ query: "physics" });
      if (!validated.ok) throw new Error("expected validation to pass");

      const result = searchTabsAction.run(store, validated.args, { browserContext });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.matches).toHaveLength(1);
      expect(result.data.matches[0].source).toBe("browser");
    });
  });
});

describe("get_tab action", () => {
  it("returns the tab's summary", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Foo" })] })], "a");
    const validated = getTabAction.validate({ tabId: "1" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = getTabAction.run(store, validated.args);
    expect(result).toEqual({ ok: true, data: expect.objectContaining({ tabId: "1", title: "Foo" }) });
  });

  it("fails for an id that doesn't exist", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [] })], "a");
    const validated = getTabAction.validate({ tabId: "ghost" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = getTabAction.run(store, validated.args);
    expect(result.ok).toBe(false);
  });
});

describe("list_workspaces action", () => {
  it("lists every workspace with counts", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", name: "A", tabs: [makeTab("1")] }), makeWorkspace({ id: "b", name: "B" })],
      "a"
    );
    const result = listWorkspacesAction.run(store, {});
    expect(result).toEqual({
      ok: true,
      data: {
        workspaces: [
          expect.objectContaining({ workspaceId: "a", name: "A", tabCount: 1 }),
          expect.objectContaining({ workspaceId: "b", name: "B", tabCount: 0 }),
        ],
      },
    });
  });
});

describe("get_workspace action", () => {
  it("fails for a workspace id that doesn't exist", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = getWorkspaceAction.validate({ workspaceId: "ghost" });
    if (!validated.ok) throw new Error("expected validation to pass");
    expect(getWorkspaceAction.run(store, validated.args).ok).toBe(false);
  });
});

describe("list_workspace_tabs action", () => {
  it("filters by query within the given workspace", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics" }), makeTab("2", { title: "Shopping" })] })],
      "a"
    );
    const validated = listWorkspaceTabsAction.validate({ workspaceId: "a", query: "physics" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = listWorkspaceTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tabs.map((t) => t.tabId)).toEqual(["1"]);
  });

  function makeTabs(n: number, prefix = "t"): Tab[] {
    return Array.from({ length: n }, (_, i) => makeTab(`${prefix}${i + 1}`, { title: `Tab ${i + 1}` }));
  }

  function run(store: WorkspaceStore, args: Record<string, unknown>) {
    const validated = listWorkspaceTabsAction.validate(args);
    if (!validated.ok) throw new Error(`expected validation to pass: ${validated.message}`);
    const result = listWorkspaceTabsAction.run(store, validated.args);
    if (!result.ok) throw new Error(`expected run to succeed: ${result.message}`);
    return result.data;
  }

  describe("pagination", () => {
    it("returns every tab uncut and marks it complete for a workspace under the default limit (regression: pre-fix default was 50)", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: makeTabs(40) })], "a");
      const data = run(store, { workspaceId: "a" });

      expect(data.tabs).toHaveLength(40);
      expect(data.total).toBe(40);
      expect(data.offset).toBe(0);
      expect(data.truncated).toBe(false);
      expect(data.nextOffset).toBeUndefined();
      expect(data.note).toBeUndefined();
    });

    it("returns all 53 tabs in a single default call — the exact workspace size from the original bug report", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: makeTabs(53) })], "a");
      // No `limit`/`offset` at all — this is what a model does by default
      // when it doesn't specifically reason about page size.
      const data = run(store, { workspaceId: "a" });

      expect(data.tabs).toHaveLength(53);
      expect(data.tabs.map((t) => t.tabId)).toEqual(makeTabs(53).map((t) => t.id));
      expect(data.total).toBe(53);
      expect(data.truncated).toBe(false);
    });

    it("truncates a workspace larger than the default page size, and the returned nextOffset/note lead to the rest", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: makeTabs(130) })], "a");

      const first = run(store, { workspaceId: "a" });
      expect(first.tabs).toHaveLength(100);
      expect(first.total).toBe(130);
      expect(first.offset).toBe(0);
      expect(first.truncated).toBe(true);
      expect(first.nextOffset).toBe(100);
      expect(first.note).toMatch(/30 more/);
      expect(first.note).toContain("offset: 100");

      const second = run(store, { workspaceId: "a", offset: first.nextOffset });
      expect(second.tabs).toHaveLength(30);
      expect(second.offset).toBe(100);
      expect(second.truncated).toBe(false);
      expect(second.nextOffset).toBeUndefined();
      expect(second.note).toBeUndefined();

      // The two pages together are exactly the whole workspace, in order.
      expect([...first.tabs, ...second.tabs].map((t) => t.tabId)).toEqual(makeTabs(130).map((t) => t.id));
    });

    it("walks a workspace larger than even the max per-call limit across multiple pages with no duplicate or skipped tabs", () => {
      const total = 250; // > LIST_TABS_MAX_LIMIT (200) and not a multiple of the 100 default page size
      const store = makeStore([makeWorkspace({ id: "a", tabs: makeTabs(total) })], "a");

      const collected: string[] = [];
      let offset: number | undefined = undefined;
      let pages = 0;
      for (;;) {
        pages += 1;
        if (pages > 10) throw new Error("pagination did not terminate");
        const data: ReturnType<typeof run> = run(store, offset === undefined ? { workspaceId: "a" } : { workspaceId: "a", offset });
        collected.push(...data.tabs.map((t) => t.tabId));
        if (!data.truncated) break;
        expect(data.nextOffset).toBeDefined();
        offset = data.nextOffset;
      }

      expect(pages).toBe(3); // 100 + 100 + 50
      expect(collected).toEqual(makeTabs(total).map((t) => t.id)); // exact order, no dupes, no gaps
      expect(new Set(collected).size).toBe(total);
    });

    it("preserves existing behavior for a caller-provided `limit` — it still governs page size, combined with `offset`", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: makeTabs(53) })], "a");

      const first = run(store, { workspaceId: "a", limit: 10 });
      expect(first.tabs.map((t) => t.tabId)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]);
      expect(first.truncated).toBe(true);
      expect(first.nextOffset).toBe(10);

      const second = run(store, { workspaceId: "a", limit: 10, offset: 10 });
      expect(second.tabs.map((t) => t.tabId)).toEqual(["t11", "t12", "t13", "t14", "t15", "t16", "t17", "t18", "t19", "t20"]);
      expect(second.truncated).toBe(true);
      expect(second.nextOffset).toBe(20);
    });

    it("clamps a limit above the max and an offset past the end without erroring", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: makeTabs(10) })], "a");

      const overLimit = run(store, { workspaceId: "a", limit: 100000 });
      expect(overLimit.tabs).toHaveLength(10);
      expect(overLimit.truncated).toBe(false);

      const pastEnd = run(store, { workspaceId: "a", offset: 500 });
      expect(pastEnd.tabs).toEqual([]);
      expect(pastEnd.total).toBe(10);
      expect(pastEnd.truncated).toBe(false);
    });

    it("carries a query filter across pages consistently — total/truncation reflect the FILTERED count, not the whole workspace", () => {
      const matching = makeTabs(130, "keep").map((t) => ({ ...t, title: `keep ${t.title}` }));
      const nonMatching = makeTabs(10, "skip").map((t) => ({ ...t, title: `skip ${t.title}` }));
      const store = makeStore([makeWorkspace({ id: "a", tabs: [...matching, ...nonMatching] })], "a");

      const first = run(store, { workspaceId: "a", query: "keep" });
      expect(first.tabs).toHaveLength(100);
      expect(first.total).toBe(130); // matches "keep" only, not all 140
      expect(first.truncated).toBe(true);
      expect(first.note).toContain('query: "keep"');

      const second = run(store, { workspaceId: "a", query: "keep", offset: first.nextOffset });
      expect(second.tabs).toHaveLength(30);
      expect(second.truncated).toBe(false);
      // Never leaks a non-matching tab in across pages.
      expect([...first.tabs, ...second.tabs].every((t) => t.tabId.startsWith("keep"))).toBe(true);
    });

    it("returns identical pages for identical (query, offset, limit) arguments — deterministic, not just non-overlapping", () => {
      const store = makeStore([makeWorkspace({ id: "a", tabs: makeTabs(130) })], "a");
      const first = run(store, { workspaceId: "a", offset: 40, limit: 25 });
      const second = run(store, { workspaceId: "a", offset: 40, limit: 25 });
      expect(second.tabs.map((t) => t.tabId)).toEqual(first.tabs.map((t) => t.tabId));
    });
  });
});
