import { assignTabsToGroup, removeTabsFromGroup } from "@/lib/workspace/store";
import { asRecord, requiredString, requiredStringArray } from "./validate";
import { findGroup, findWorkspace, tabSummary } from "./lookup";
import type { ActionDefinition } from "./types";

const ASSIGN_SUMMARY_CAP = 25;

function dedupe(tabIds: string[]): string[] | null {
  return new Set(tabIds).size === tabIds.length ? tabIds : null;
}

type AssignArgs = { workspaceId: string; tabIds: string[]; groupId: string };
type AssignData = {
  assignedCount: number;
  notFoundTabIds: string[];
  groupId: string;
  groupName: string;
  workspaceId: string;
  assignedTabs: ReturnType<typeof tabSummary>[];
};

/**
 * Puts one or more already-saved tabs into a group — the action Auto-
 * Organize's group proposals and natural-language requests like "put these
 * tabs into General Relativity" both resolve to. Every tab must already
 * live in `workspaceId` (a tab can only belong to a group in its own
 * workspace — see Tab.groupId's doc); use move_tabs first if it doesn't.
 * Also serves as "move a tab from one group to another" — just call this
 * again with the new groupId, it overwrites the old one.
 */
export const assignTabsToGroupAction: ActionDefinition<AssignArgs, AssignData> = {
  name: "assign_tabs_to_group",
  description:
    "Assign one or more saved tabs to a group within their workspace — e.g. \"put these tabs into General Relativity\", \"group my Physics tabs into IA and References\", \"move these tabs into the MUN research group\". Every tab must already be in the same workspace as the group; call move_tabs first if a tab needs to move workspaces too. Also works to move a tab from one group to another — just call this again with the new group's id.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING", description: "The workspace both the tabs and the group belong to." },
      tabIds: { type: "ARRAY", items: { type: "STRING" }, description: "The tab ids to assign." },
      groupId: { type: "STRING", description: "The destination group's id, from create_group or list_groups." },
    },
    required: ["workspaceId", "tabIds", "groupId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `workspaceId`, `tabIds`, and `groupId`." };
    const workspaceId = requiredString(record, "workspaceId");
    const groupId = requiredString(record, "groupId");
    const tabIds = requiredStringArray(record, "tabIds");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    if (!groupId) return { ok: false, message: "`groupId` is required and must be a non-empty string." };
    if (!tabIds) return { ok: false, message: "`tabIds` is required and must be a non-empty array of strings." };
    const deduped = dedupe(tabIds);
    if (!deduped) return { ok: false, message: "`tabIds` must not contain duplicate ids." };
    return { ok: true, args: { workspaceId, tabIds: deduped, groupId } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    const group = findGroup(workspace, args.groupId);
    if (!group) return { ok: false, message: `No group found with id "${args.groupId}" in workspace "${args.workspaceId}".` };

    const presentIds = new Set(workspace.tabs.map((t) => t.id));
    const notFoundTabIds = args.tabIds.filter((id) => !presentIds.has(id));
    if (notFoundTabIds.length === args.tabIds.length) {
      return { ok: false, message: `None of the given tab ids were found in workspace "${args.workspaceId}".` };
    }

    const next = assignTabsToGroup(store, args.workspaceId, args.tabIds, args.groupId);
    const targetWorkspace = findWorkspace(next, args.workspaceId)!;
    const assignedTabs = targetWorkspace.tabs.filter((t) => t.groupId === args.groupId && args.tabIds.includes(t.id));

    return {
      ok: true,
      data: {
        assignedCount: assignedTabs.length,
        notFoundTabIds,
        groupId: group.id,
        groupName: group.name,
        workspaceId: args.workspaceId,
        assignedTabs: assignedTabs.slice(0, ASSIGN_SUMMARY_CAP).map((t) => tabSummary(t, targetWorkspace)),
      },
      store: next,
    };
  },
};

type RemoveArgs = { workspaceId: string; tabIds: string[] };
type RemoveData = { removedCount: number; notFoundTabIds: string[]; workspaceId: string };

export const removeTabsFromGroupAction: ActionDefinition<RemoveArgs, RemoveData> = {
  name: "remove_tabs_from_group",
  description:
    "Remove one or more saved tabs from whatever group they're currently in, leaving them in the same workspace but ungrouped — e.g. \"remove these tabs from the group\", \"ungroup these tabs\". A tab that's already ungrouped is left as-is.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING" },
      tabIds: { type: "ARRAY", items: { type: "STRING" }, description: "The tab ids to remove from their group." },
    },
    required: ["workspaceId", "tabIds"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `workspaceId` and `tabIds`." };
    const workspaceId = requiredString(record, "workspaceId");
    const tabIds = requiredStringArray(record, "tabIds");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    if (!tabIds) return { ok: false, message: "`tabIds` is required and must be a non-empty array of strings." };
    const deduped = dedupe(tabIds);
    if (!deduped) return { ok: false, message: "`tabIds` must not contain duplicate ids." };
    return { ok: true, args: { workspaceId, tabIds: deduped } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };

    const byId = new Map(workspace.tabs.map((t) => [t.id, t]));
    const notFoundTabIds = args.tabIds.filter((id) => !byId.has(id));
    if (notFoundTabIds.length === args.tabIds.length) {
      return { ok: false, message: `None of the given tab ids were found in workspace "${args.workspaceId}".` };
    }
    const removedCount = args.tabIds.filter((id) => byId.get(id)?.groupId !== undefined).length;

    const next = removeTabsFromGroup(store, args.workspaceId, args.tabIds);
    return { ok: true, data: { removedCount, notFoundTabIds, workspaceId: args.workspaceId }, store: next };
  },
};
