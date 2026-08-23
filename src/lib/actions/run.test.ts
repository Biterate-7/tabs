import { describe, expect, it } from "vitest";
import { runAction } from "./run";
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

describe("runAction (registry dispatch)", () => {
  it("rejects an unknown action name", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = runAction("delete_everything", {}, store);
    expect(result).toEqual({ ok: false, name: "delete_everything", message: expect.stringContaining("Unknown action") });
  });

  it("surfaces a validation failure without touching the store", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = runAction("create_workspace", {}, store);
    expect(result.ok).toBe(false);
  });

  it("runs a read action and returns the same store reference (no mutation)", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const result = runAction("list_workspaces", {}, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store).toBe(store);
  });

  it("runs a write action and returns a new store reflecting the change", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = runAction("create_workspace", { name: "New" }, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store).not.toBe(store);
    expect(result.store.workspaces).toHaveLength(2);
  });

  it("rejects a tab id that belongs to a different workspace than the one claimed (unauthorized scope)", () => {
    const store = makeStore(
      [makeWorkspace({ id: "a", tabs: [makeTab("1")] }), makeWorkspace({ id: "b", tabs: [] })],
      "a"
    );
    const result = runAction("move_tab", { tabId: "1", targetWorkspaceId: "b", sourceWorkspaceId: "b" }, store);
    expect(result.ok).toBe(false);
  });
});
