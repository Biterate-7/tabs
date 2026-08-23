import { moveTabsBetweenWorkspaces } from "@/lib/workspace/store";
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
