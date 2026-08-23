import { createGroup, renameGroup } from "@/lib/workspace/store";
import { matchesQuery } from "@/lib/workspace/search";
import { asRecord, optionalInteger, optionalString, requiredString } from "./validate";
import { findGroup, findWorkspace, tabSummary } from "./lookup";
import type { ActionDefinition } from "./types";

const GROUP_SAMPLE_TABS_CAP = 20;
const LIST_GROUP_TABS_DEFAULT_LIMIT = 50;
const LIST_GROUP_TABS_MAX_LIMIT = 200;

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

type ListGroupsData = { workspaceId: string; groups: { groupId: string; name: string; tabCount: number }[] };

export const listGroupsAction: ActionDefinition<{ workspaceId: string }, ListGroupsData> = {
  name: "list_groups",
  description:
    "List the groups within one workspace, each with its tab count. Use this to resolve a group name (e.g. \"General Relativity\") to its id, or to answer \"what groups do I have in Physics?\".",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: { workspaceId: { type: "STRING" } },
    required: ["workspaceId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `workspaceId` string." };
    const workspaceId = requiredString(record, "workspaceId");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    return { ok: true, args: { workspaceId } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    const groups = (workspace.groups ?? []).map((g) => ({
      groupId: g.id,
      name: g.name,
      tabCount: workspace.tabs.filter((t) => t.groupId === g.id).length,
    }));
    return { ok: true, data: { workspaceId: workspace.id, groups } };
  },
};

type GetGroupData = { groupId: string; name: string; workspaceId: string; tabCount: number; sampleTabs: ReturnType<typeof tabSummary>[] };

export const getGroupAction: ActionDefinition<{ workspaceId: string; groupId: string }, GetGroupData> = {
  name: "get_group",
  description: "Get one group's details — name, tab count, and a small sample of its tabs. Use this to answer \"what's in General Relativity?\".",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: { workspaceId: { type: "STRING" }, groupId: { type: "STRING" } },
    required: ["workspaceId", "groupId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `workspaceId` and `groupId` strings." };
    const workspaceId = requiredString(record, "workspaceId");
    const groupId = requiredString(record, "groupId");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    if (!groupId) return { ok: false, message: "`groupId` is required and must be a non-empty string." };
    return { ok: true, args: { workspaceId, groupId } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    const group = findGroup(workspace, args.groupId);
    if (!group) return { ok: false, message: `No group found with id "${args.groupId}" in workspace "${args.workspaceId}".` };
    const tabs = workspace.tabs.filter((t) => t.groupId === group.id);
    return {
      ok: true,
      data: {
        groupId: group.id,
        name: group.name,
        workspaceId: workspace.id,
        tabCount: tabs.length,
        sampleTabs: tabs.slice(0, GROUP_SAMPLE_TABS_CAP).map((t) => tabSummary(t, workspace)),
      },
    };
  },
};

type ListGroupTabsData = { groupId: string; total: number; tabs: ReturnType<typeof tabSummary>[]; truncated: boolean };

export const listGroupTabsAction: ActionDefinition<{ workspaceId: string; groupId: string; query?: string; limit?: number }, ListGroupTabsData> = {
  name: "list_group_tabs",
  description: "List the tabs inside one group, optionally filtered by keyword.",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING" },
      groupId: { type: "STRING" },
      query: { type: "STRING", description: "Optional keyword filter." },
      limit: { type: "INTEGER", description: `Max tabs to return (default ${LIST_GROUP_TABS_DEFAULT_LIMIT}, capped at ${LIST_GROUP_TABS_MAX_LIMIT}).` },
    },
    required: ["workspaceId", "groupId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `workspaceId` and `groupId` strings." };
    const workspaceId = requiredString(record, "workspaceId");
    const groupId = requiredString(record, "groupId");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    if (!groupId) return { ok: false, message: "`groupId` is required and must be a non-empty string." };
    return { ok: true, args: { workspaceId, groupId, query: optionalString(record, "query"), limit: optionalInteger(record, "limit") } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    const group = findGroup(workspace, args.groupId);
    if (!group) return { ok: false, message: `No group found with id "${args.groupId}" in workspace "${args.workspaceId}".` };

    const limit = Math.min(Math.max(args.limit ?? LIST_GROUP_TABS_DEFAULT_LIMIT, 1), LIST_GROUP_TABS_MAX_LIMIT);
    const groupTabs = workspace.tabs.filter((t) => t.groupId === group.id);
    const filtered = args.query ? groupTabs.filter((t) => matchesQuery(t, args.query!)) : groupTabs;

    return {
      ok: true,
      data: {
        groupId: group.id,
        total: filtered.length,
        tabs: filtered.slice(0, limit).map((t) => tabSummary(t, workspace)),
        truncated: filtered.length > limit,
      },
    };
  },
};
