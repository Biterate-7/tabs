import { createWorkspace, renameWorkspace } from "@/lib/workspace/store";
import { asRecord, requiredString } from "./validate";
import { findWorkspace, workspaceSummary } from "./lookup";
import type { ActionDefinition } from "./types";

type WorkspaceData = { workspace: ReturnType<typeof workspaceSummary> };

export const createWorkspaceAction: ActionDefinition<{ name: string }, WorkspaceData> = {
  name: "create_workspace",
  description: "Create a new, empty workspace with the given name.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: { name: { type: "STRING", description: "The new workspace's name." } },
    required: ["name"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `name` string." };
    const name = requiredString(record, "name");
    if (!name) return { ok: false, message: "`name` is required and must be a non-empty string." };
    return { ok: true, args: { name } };
  },
  run(store, args) {
    const next = createWorkspace(store, args.name);
    const created = next.workspaces[next.workspaces.length - 1];
    return { ok: true, data: { workspace: workspaceSummary(created) }, store: next };
  },
};

export const renameWorkspaceAction: ActionDefinition<{ workspaceId: string; name: string }, WorkspaceData> = {
  name: "rename_workspace",
  description: "Rename an existing workspace.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING", description: "The workspace to rename." },
      name: { type: "STRING", description: "The new name." },
    },
    required: ["workspaceId", "name"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `workspaceId` and `name` strings." };
    const workspaceId = requiredString(record, "workspaceId");
    const name = requiredString(record, "name");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    if (!name) return { ok: false, message: "`name` is required and must be a non-empty string." };
    return { ok: true, args: { workspaceId, name } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    const next = renameWorkspace(store, args.workspaceId, args.name);
    const renamed = findWorkspace(next, args.workspaceId)!;
    return { ok: true, data: { workspace: workspaceSummary(renamed) }, store: next };
  },
};
