import { assignTabsToGroup } from "@/lib/workspace/store";
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
 * Organize's group proposals resolve to. Every tab must already live in
 * `workspaceId` (a tab can only belong to a group in its own workspace —
 * see Tab.groupId's doc).
 */
export const assignTabsToGroupAction: ActionDefinition<AssignArgs, AssignData> = {
  name: "assign_tabs_to_group",
  description:
    "Assign one or more saved tabs to a group within their workspace. Every tab must already be in the same workspace as the group.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING", description: "The workspace both the tabs and the group belong to." },
      tabIds: { type: "ARRAY", items: { type: "STRING" }, description: "The tab ids to assign." },
      groupId: { type: "STRING", description: "The destination group's id, from create_group." },
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
