import { describe, expect, it } from "vitest";
import { createGroupAction, renameGroupAction } from "./groups";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("create_group action", () => {
  it("creates a group within the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = createGroupAction.validate({ workspaceId: "a", name: "Midterms" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = createGroupAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.group.name).toBe("Midterms");
    expect(result.store?.workspaces[0].groups?.[0].name).toBe("Midterms");
  });

  it("fails for a nonexistent workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = createGroupAction.validate({ workspaceId: "ghost", name: "X" });
    if (!validated.ok) throw new Error("expected validation to pass");
    expect(createGroupAction.run(store, validated.args).ok).toBe(false);
  });
});

describe("rename_group action", () => {
  it("renames an existing group", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const created = createGroupAction.run(store, { workspaceId: "a", name: "Old" });
    if (!created.ok) throw new Error("expected create to pass");
    const groupId = (created.data as { group: { groupId: string } }).group.groupId;

    const validated = renameGroupAction.validate({ workspaceId: "a", groupId, name: "New" });
    if (!validated.ok) throw new Error("expected validation to pass");

    const result = renameGroupAction.run(created.store!, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store?.workspaces[0].groups?.[0].name).toBe("New");
  });

  it("fails for a group id that doesn't exist in the workspace", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = renameGroupAction.validate({ workspaceId: "a", groupId: "ghost", name: "New" });
    if (!validated.ok) throw new Error("expected validation to pass");
    expect(renameGroupAction.run(store, validated.args).ok).toBe(false);
  });
});
