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
});
