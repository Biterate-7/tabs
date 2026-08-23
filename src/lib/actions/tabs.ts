import { moveTabsBetweenWorkspaces, updateWorkspaceTabs } from "@/lib/workspace/store";
import { removeTabs } from "@/lib/workspace/cleanup";
import type { WorkspaceStore } from "@/lib/workspace/types";
import { asRecord, optionalString, requiredString, requiredStringArray } from "./validate";
import { findWorkspace, tabSummary } from "./lookup";
import type { ActionDefinition } from "./types";

const MOVED_SUMMARY_CAP = 25;

type MoveTabsArgs = { tabIds: string[]; targetWorkspaceId: string; sourceWorkspaceId?: string };

type MoveTabsData = {
  movedCount: number;
  notFoundTabIds: string[];
  targetWorkspaceId: string;
  targetWorkspaceName: string;
  movedTabs: ReturnType<typeof tabSummary>[];
};

function runMove(store: WorkspaceStore, args: MoveTabsArgs) {
  const target = findWorkspace(store, args.targetWorkspaceId);
  if (!target) return { ok: false as const, message: `No workspace found with id "${args.targetWorkspaceId}".` };
  if (args.sourceWorkspaceId && !findWorkspace(store, args.sourceWorkspaceId)) {
    return { ok: false as const, message: `No workspace found with id "${args.sourceWorkspaceId}".` };
  }

  const result = moveTabsBetweenWorkspaces(store, args.tabIds, args.targetWorkspaceId, args.sourceWorkspaceId);
  if (result.moved.length === 0) {
    return {
      ok: false as const,
      message: args.sourceWorkspaceId
        ? `None of the given tab ids were found in workspace "${args.sourceWorkspaceId}".`
        : "None of the given tab ids were found in any workspace.",
    };
  }

  const targetAfter = findWorkspace(result.store, args.targetWorkspaceId)!;
  return {
    ok: true as const,
    data: {
      movedCount: result.moved.length,
      notFoundTabIds: result.notFound,
      targetWorkspaceId: targetAfter.id,
      targetWorkspaceName: targetAfter.name,
      movedTabs: result.moved.slice(0, MOVED_SUMMARY_CAP).map((t) => tabSummary(t, targetAfter)),
    },
    store: result.store,
  };
}

export const moveTabAction: ActionDefinition<{ tabId: string; targetWorkspaceId: string; sourceWorkspaceId?: string }, MoveTabsData> = {
  name: "move_tab",
  description: "Move one saved tab into a different workspace.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      tabId: { type: "STRING" },
      targetWorkspaceId: { type: "STRING", description: "The destination workspace's id." },
      sourceWorkspaceId: {
        type: "STRING",
        description: "Optional — when given, the tab must exist in exactly this workspace, or the move fails.",
      },
    },
    required: ["tabId", "targetWorkspaceId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `tabId` and `targetWorkspaceId` strings." };
    const tabId = requiredString(record, "tabId");
    const targetWorkspaceId = requiredString(record, "targetWorkspaceId");
    if (!tabId) return { ok: false, message: "`tabId` is required and must be a non-empty string." };
    if (!targetWorkspaceId) return { ok: false, message: "`targetWorkspaceId` is required and must be a non-empty string." };
    return { ok: true, args: { tabId, targetWorkspaceId, sourceWorkspaceId: optionalString(record, "sourceWorkspaceId") } };
  },
  run(store, args) {
    return runMove(store, { tabIds: [args.tabId], targetWorkspaceId: args.targetWorkspaceId, sourceWorkspaceId: args.sourceWorkspaceId });
  },
};

export const moveTabsAction: ActionDefinition<MoveTabsArgs, MoveTabsData> = {
  name: "move_tabs",
  description: "Move several saved tabs into a different workspace in one call.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      tabIds: { type: "ARRAY", items: { type: "STRING" }, description: "The tab ids to move." },
      targetWorkspaceId: { type: "STRING", description: "The destination workspace's id." },
      sourceWorkspaceId: {
        type: "STRING",
        description: "Optional — when given, every tab must exist in exactly this workspace, or it's reported as not found.",
      },
    },
    required: ["tabIds", "targetWorkspaceId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `tabIds` (array) and `targetWorkspaceId` (string)." };
    const tabIds = requiredStringArray(record, "tabIds");
    const targetWorkspaceId = requiredString(record, "targetWorkspaceId");
    if (!tabIds) return { ok: false, message: "`tabIds` is required and must be a non-empty array of strings." };
    if (!targetWorkspaceId) return { ok: false, message: "`targetWorkspaceId` is required and must be a non-empty string." };
    return { ok: true, args: { tabIds, targetWorkspaceId, sourceWorkspaceId: optionalString(record, "sourceWorkspaceId") } };
  },
  run(store, args) {
    return runMove(store, args);
  },
};

const DELETE_SUMMARY_CAP = 25;

type DeleteTabsArgs = { workspaceId: string; tabIds: string[] };
type DeleteTabsData = { deletedCount: number; notFoundTabIds: string[]; workspaceId: string; deletedTabs: ReturnType<typeof tabSummary>[] };

/**
 * Permanently removes saved tabs from a workspace — the TabDump-side
 * counterpart to close_tabs (which only ever touches real, currently-open
 * browser tabs; see src/lib/actions/browser-write.ts). This DOES mutate
 * WorkspaceStore, so unlike close_tabs it's fully covered by the existing
 * store undo system (a whole-store before/after snapshot — see
 * src/lib/undo/history.ts) rather than needing its own revert bookkeeping.
 * Still always requires confirmation for more than one tab at a time — see
 * ALWAYS_CONFIRM_IF_BULK in plan.ts — since it's the one TabDump write
 * action that can't be gotten back by re-saving (a deleted tab's original
 * save metadata, category, and group membership are gone for good even
 * though the whole store CAN be restored via Undo immediately after).
 */
export const deleteTabsAction: ActionDefinition<DeleteTabsArgs, DeleteTabsData> = {
  name: "delete_tabs",
  description:
    "Permanently delete one or more saved tabs from a workspace — e.g. \"delete these duplicate tabs\", \"remove these tabs from TabDump\". This only affects saved TabDump tabs, never the user's real open browser tabs (use close_tabs for that). Deleting more than one tab always requires the user's confirmation before anything is actually removed.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING" },
      tabIds: { type: "ARRAY", items: { type: "STRING" }, description: "The saved tab ids to delete." },
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
    return { ok: true, args: { workspaceId, tabIds: [...new Set(tabIds)] } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };

    const presentIds = new Set(workspace.tabs.map((t) => t.id));
    const wanted = args.tabIds.filter((id) => presentIds.has(id));
    const notFoundTabIds = args.tabIds.filter((id) => !presentIds.has(id));
    if (wanted.length === 0) {
      return { ok: false, message: `None of the given tab ids were found in workspace "${args.workspaceId}".` };
    }

    const deletedTabs = workspace.tabs.filter((t) => wanted.includes(t.id));
    const remaining = removeTabs(workspace.tabs, wanted);
    const next = updateWorkspaceTabs(store, workspace.id, remaining);

    return {
      ok: true,
      data: {
        deletedCount: wanted.length,
        notFoundTabIds,
        workspaceId: workspace.id,
        deletedTabs: deletedTabs.slice(0, DELETE_SUMMARY_CAP).map((t) => tabSummary(t, workspace)),
      },
      store: next,
    };
  },
};
