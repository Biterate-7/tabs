import { describe, expect, it } from "vitest";
import { moveTabAction, moveTabsAction, deleteTabsAction } from "./tabs";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeTab(id: string): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com" };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("move_tab action", () => {
  it("moves a single tab into the target workspace", () => {
    const store = makeStore(
      [makeWorkspace({ id: "physics", tabs: [makeTab("1")] }), makeWorkspace({ id: "ia", tabs: [] })],
      "physics"
    );
    const validated = moveTabAction.validate({ tabId: "1", targetWorkspaceId: "ia", sourceWorkspaceId: "physics" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = moveTabAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.movedCount).toBe(1);
    expect(result.store?.workspaces.find((w) => w.id === "ia")?.tabs.map((t) => t.id)).toEqual(["1"]);
    expect(result.store?.workspaces.find((w) => w.id === "physics")?.tabs).toEqual([]);
  });

  it("fails for a tab id that doesn't exist anywhere", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [] }), makeWorkspace({ id: "b", tabs: [] })], "a");
    const validated = moveTabAction.validate({ tabId: "ghost", targetWorkspaceId: "b" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = moveTabAction.run(store, validated.args);
    expect(result).toEqual({ ok: false, message: expect.any(String) });
  });

  it("fails for a target workspace id that doesn't exist", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const validated = moveTabAction.validate({ tabId: "1", targetWorkspaceId: "ghost" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = moveTabAction.run(store, validated.args);
    expect(result).toEqual({ ok: false, message: expect.stringContaining("ghost") });
  });

  it("rejects a tab that exists, but not in the claimed source workspace (unauthorized scope)", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [makeTab("1")] }),
        makeWorkspace({ id: "b", tabs: [] }),
        makeWorkspace({ id: "c", tabs: [] }),
      ],
      "a"
    );
    // Tab "1" really lives in workspace "a" — claiming source "c" must not
    // let the caller reach into "a" implicitly.
    const validated = moveTabAction.validate({ tabId: "1", targetWorkspaceId: "b", sourceWorkspaceId: "c" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = moveTabAction.run(store, validated.args);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("c");
    // And the tab must still be exactly where it started.
    expect(store.workspaces.find((w) => w.id === "a")?.tabs.map((t) => t.id)).toEqual(["1"]);
  });
});

describe("move_tabs action", () => {
  it("moves several tabs at once and reports any not found", () => {
    const store = makeStore(
      [
        makeWorkspace({ id: "physics", tabs: [makeTab("1"), makeTab("2"), makeTab("3")] }),
        makeWorkspace({ id: "ia", tabs: [] }),
      ],
      "physics"
    );
    const validated = moveTabsAction.validate({
      tabIds: ["1", "2", "ghost"],
      targetWorkspaceId: "ia",
      sourceWorkspaceId: "physics",
    });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = moveTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.movedCount).toBe(2);
    expect(result.data.notFoundTabIds).toEqual(["ghost"]);
    expect(result.store?.workspaces.find((w) => w.id === "ia")?.tabs.map((t) => t.id).sort()).toEqual(["1", "2"]);
  });

  it("rejects an empty tabIds array at validation time", () => {
    const validated = moveTabsAction.validate({ tabIds: [], targetWorkspaceId: "ia" });
    expect(validated.ok).toBe(false);
  });
});

describe("delete_tabs action", () => {
  it("permanently removes the given tabs from the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1"), makeTab("2"), makeTab("3")] })], "a");
    const validated = deleteTabsAction.validate({ workspaceId: "a", tabIds: ["1", "2"] });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = deleteTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deletedCount).toBe(2);
    expect(result.store?.workspaces.find((w) => w.id === "a")?.tabs.map((t) => t.id)).toEqual(["3"]);
  });

  it("reports ids that weren't found without failing the whole call", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const validated = deleteTabsAction.validate({ workspaceId: "a", tabIds: ["1", "ghost"] });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = deleteTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deletedCount).toBe(1);
    expect(result.data.notFoundTabIds).toEqual(["ghost"]);
  });

  it("fails when none of the given tab ids exist in the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [] })], "a");
    const validated = deleteTabsAction.validate({ workspaceId: "a", tabIds: ["ghost"] });
    if (!validated.ok) throw new Error("expected validation to pass");
    expect(deleteTabsAction.run(store, validated.args).ok).toBe(false);
  });

  it("fails for an unknown workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const validated = deleteTabsAction.validate({ workspaceId: "ghost", tabIds: ["1"] });
    if (!validated.ok) throw new Error("expected validation to pass");
    expect(deleteTabsAction.run(store, validated.args).ok).toBe(false);
  });

  it("does not touch other workspaces", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [makeTab("1")] }), makeWorkspace({ id: "b", tabs: [makeTab("2")] })],
      "a"
    );
    const validated = deleteTabsAction.validate({ workspaceId: "a", tabIds: ["1"] });
    if (!validated.ok) throw new Error("expected validation to pass");
    const result = deleteTabsAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store?.workspaces.find((w) => w.id === "b")?.tabs.map((t) => t.id)).toEqual(["2"]);
  });

  it("deduplicates repeated tab ids at validation time", () => {
    const validated = deleteTabsAction.validate({ workspaceId: "a", tabIds: ["1", "1", "2"] });
    expect(validated).toEqual({ ok: true, args: { workspaceId: "a", tabIds: ["1", "2"] } });
  });
});
