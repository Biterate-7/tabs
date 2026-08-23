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
