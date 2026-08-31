import { describe, expect, it } from "vitest";
import { assignTabsToGroupAction } from "./group-membership";
import { createGroupAction } from "./groups";
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

function withGroup(store: WorkspaceStore, workspaceId: string, name: string) {
  const created = createGroupAction.run(store, { workspaceId, name });
  if (!created.ok) throw new Error("expected create_group to succeed");
  return { store: created.store!, groupId: (created.data as { group: { groupId: string } }).group.groupId };
}

describe("assign_tabs_to_group action", () => {
  it("validates required fields", () => {
    expect(assignTabsToGroupAction.validate({}).ok).toBe(false);
    expect(assignTabsToGroupAction.validate({ workspaceId: "a" }).ok).toBe(false);
    expect(assignTabsToGroupAction.validate({ workspaceId: "a", tabIds: [], groupId: "g1" }).ok).toBe(false);
    expect(assignTabsToGroupAction.validate({ workspaceId: "a", tabIds: ["1"], groupId: "" }).ok).toBe(false);
  });

  it("rejects duplicate tab ids", () => {
    const result = assignTabsToGroupAction.validate({ workspaceId: "a", tabIds: ["1", "1"], groupId: "g1" });
    expect(result.ok).toBe(false);
  });

  it("assigns one tab to a group", () => {
    const base = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const { store, groupId } = withGroup(base, "a", "Physics");

    const validated = assignTabsToGroupAction.validate({ workspaceId: "a", tabIds: ["1"], groupId });
    if (!validated.ok) throw new Error("expected validation to pass");
    const result = assignTabsToGroupAction.run(store, validated.args);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.assignedCount).toBe(1);
    expect(result.data.groupName).toBe("Physics");
    expect(result.store?.workspaces[0].tabs[0].groupId).toBe(groupId);
  });

  it("assigns multiple tabs in one call", () => {
    const base = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1"), makeTab("2"), makeTab("3")] })], "a");
    const { store, groupId } = withGroup(base, "a", "Physics");

    const result = assignTabsToGroupAction.run(store, { workspaceId: "a", tabIds: ["1", "2"], groupId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.assignedCount).toBe(2);
    expect(result.store?.workspaces[0].tabs.filter((t) => t.groupId === groupId)).toHaveLength(2);
  });

  it("re-assigns an already-grouped tab into a different group", () => {
    const base = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const first = withGroup(base, "a", "IA");
    const second = withGroup(first.store, "a", "References");

    const assigned = assignTabsToGroupAction.run(second.store, { workspaceId: "a", tabIds: ["1"], groupId: first.groupId });
    if (!assigned.ok) throw new Error("expected first assign to succeed");

    const reassigned = assignTabsToGroupAction.run(assigned.store!, { workspaceId: "a", tabIds: ["1"], groupId: second.groupId });
    expect(reassigned.ok).toBe(true);
    if (!reassigned.ok) return;
    expect(reassigned.store?.workspaces[0].tabs[0].groupId).toBe(second.groupId);
  });

  it("fails for a nonexistent workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const result = assignTabsToGroupAction.run(store, { workspaceId: "ghost", tabIds: ["1"], groupId: "g1" });
    expect(result.ok).toBe(false);
  });

  it("fails for a nonexistent group", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const result = assignTabsToGroupAction.run(store, { workspaceId: "a", tabIds: ["1"], groupId: "ghost" });
    expect(result.ok).toBe(false);
  });

  it("fails when none of the given tab ids exist in the workspace", () => {
    const base = makeStore([makeWorkspace({ id: "a", tabs: [] })], "a");
    const { store, groupId } = withGroup(base, "a", "Physics");
    const result = assignTabsToGroupAction.run(store, { workspaceId: "a", tabIds: ["ghost"], groupId });
    expect(result.ok).toBe(false);
  });

  it("reports not-found ids while still assigning the ones that do exist (partial success)", () => {
    const base = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const { store, groupId } = withGroup(base, "a", "Physics");
    const result = assignTabsToGroupAction.run(store, { workspaceId: "a", tabIds: ["1", "ghost"], groupId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.assignedCount).toBe(1);
    expect(result.data.notFoundTabIds).toEqual(["ghost"]);
  });

  it("rejects assigning a tab into a group from a different workspace", () => {
    const base = makeStore(
      [makeWorkspace({ id: "a", tabs: [] }), makeWorkspace({ id: "b", tabs: [makeTab("1")] })],
      "a"
    );
    const { store, groupId } = withGroup(base, "a", "Physics");
    // The tab is in workspace "b", but the group belongs to "a" — scoping
    // the call to workspaceId "b" means the group lookup fails there.
    const result = assignTabsToGroupAction.run(store, { workspaceId: "b", tabIds: ["1"], groupId });
    expect(result.ok).toBe(false);
  });
});
