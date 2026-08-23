import { createGroup, renameGroup } from "@/lib/workspace/store";
import { asRecord, requiredString } from "./validate";
import { findGroup, findWorkspace } from "./lookup";
import type { ActionDefinition } from "./types";

type GroupData = { group: { groupId: string; name: string; workspaceId: string } };

export const createGroupAction: ActionDefinition<{ workspaceId: string; name: string }, GroupData> = {
  name: "create_group",
  description: "Create a named sub-group within a workspace, for organizing tabs into finer categories than the workspace itself.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING" },
      name: { type: "STRING", description: "The new group's name." },
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
    if (!findWorkspace(store, args.workspaceId)) {
      return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    }
    const { store: next, group } = createGroup(store, args.workspaceId, args.name);
    return { ok: true, data: { group: { groupId: group.id, name: group.name, workspaceId: args.workspaceId } }, store: next };
  },
};

export const renameGroupAction: ActionDefinition<{ workspaceId: string; groupId: string; name: string }, GroupData> = {
  name: "rename_group",
  description: "Rename an existing group within a workspace.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING" },
      groupId: { type: "STRING" },
      name: { type: "STRING", description: "The group's new name." },
    },
    required: ["workspaceId", "groupId", "name"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `workspaceId`, `groupId`, and `name` strings." };
    const workspaceId = requiredString(record, "workspaceId");
    const groupId = requiredString(record, "groupId");
    const name = requiredString(record, "name");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    if (!groupId) return { ok: false, message: "`groupId` is required and must be a non-empty string." };
    if (!name) return { ok: false, message: "`name` is required and must be a non-empty string." };
    return { ok: true, args: { workspaceId, groupId, name } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    if (!findGroup(workspace, args.groupId)) {
      return { ok: false, message: `No group found with id "${args.groupId}" in workspace "${args.workspaceId}".` };
    }
    const next = renameGroup(store, args.workspaceId, args.groupId, args.name);
    return { ok: true, data: { group: { groupId: args.groupId, name: args.name, workspaceId: args.workspaceId } }, store: next };
  },
};
