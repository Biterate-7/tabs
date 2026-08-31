import { describe, expect, it } from "vitest";
import { createWorkspaceAction } from "./workspaces";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("create_workspace action", () => {
  it("creates a new workspace and returns its summary", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const validated = createWorkspaceAction.validate({ name: "College Research" });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = createWorkspaceAction.run(store, validated.args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.workspace.name).toBe("College Research");
    expect(result.store?.workspaces).toHaveLength(2);
  });

  it("rejects a missing name", () => {
    const validated = createWorkspaceAction.validate({});
    expect(validated).toEqual({ ok: false, message: expect.any(String) });
  });

  it("rejects a non-object args payload", () => {
    const validated = createWorkspaceAction.validate("not an object");
    expect(validated.ok).toBe(false);
  });
});
