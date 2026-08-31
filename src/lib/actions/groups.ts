import { createGroup } from "@/lib/workspace/store";
import { asRecord, requiredString } from "./validate";
import { findWorkspace } from "./lookup";
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
