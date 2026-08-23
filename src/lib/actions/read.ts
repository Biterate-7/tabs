import { matchesQuery } from "@/lib/workspace/search";
import { DEFAULT_SEARCH_LIMIT, rankTabs } from "@/lib/search/rank";
import type { SearchResult } from "@/lib/search/types";
import { asRecord, optionalInteger, optionalString, requiredString } from "./validate";
import { findTab, findWorkspace, tabSummary, workspaceSummary } from "./lookup";
import type { ActionDefinition } from "./types";

const LIST_TABS_DEFAULT_LIMIT = 50;
const LIST_TABS_MAX_LIMIT = 200;
const SAMPLE_TABS_CAP = 20;

type SearchTabsData = { matchCount: number; matches: SearchResult[]; truncated: boolean };

export const searchTabsAction: ActionDefinition<{ query: string; workspaceId?: string }, SearchTabsData> = {
  name: "search_tabs",
  description:
    "Search saved tabs across the user's entire TabDump library by natural-language query — a hybrid of keyword matching (title, URL, domain, workspace name) and semantic similarity to what was actually saved on the page. Searches across every workspace unless workspaceId is given. Use this to find tabs the user refers to by topic (e.g. \"Physics IA tabs\", \"my MUN research\") before acting on them — the returned tabId values can be passed directly to move_tabs or other actions without asking the user for ids.",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      query: { type: "STRING", description: "A natural-language description of what to find, e.g. \"Physics IA\" or \"tabs about orbital mechanics\"." },
      workspaceId: { type: "STRING", description: "Optional — limit the search to one workspace. Omit to search everywhere." },
    },
    required: ["query"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `query` string." };
    const query = requiredString(record, "query");
    if (!query) return { ok: false, message: "`query` is required and must be a non-empty string." };
    return { ok: true, args: { query, workspaceId: optionalString(record, "workspaceId") } };
  },
  run(store, args, ctx) {
    if (args.workspaceId && !findWorkspace(store, args.workspaceId)) {
      return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };
    }
    const scope = args.workspaceId
      ? store.workspaces.filter((w) => w.id === args.workspaceId)
      : store.workspaces;

    // Overfetch (topK) so `truncated` reflects the true candidate count,
    // then cap what's actually returned to Gemini at DEFAULT_SEARCH_LIMIT.
    const allMatches = rankTabs({
      workspaces: scope,
      query: args.query,
      semanticHints: ctx?.semanticHints,
      limit: DEFAULT_SEARCH_LIMIT * 4,
    });

    return {
      ok: true,
      data: {
        matchCount: allMatches.length,
        matches: allMatches.slice(0, DEFAULT_SEARCH_LIMIT),
        truncated: allMatches.length > DEFAULT_SEARCH_LIMIT,
      },
    };
  },
};

export const getTabAction: ActionDefinition<{ tabId: string; workspaceId?: string }, ReturnType<typeof tabSummary>> = {
  name: "get_tab",
  description: "Look up one saved tab by id and return its full details.",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      tabId: { type: "STRING", description: "The tab's id, from a prior search_tabs/list_workspace_tabs result." },
      workspaceId: { type: "STRING", description: "Optional — narrows the lookup to one workspace." },
    },
    required: ["tabId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `tabId` string." };
    const tabId = requiredString(record, "tabId");
    if (!tabId) return { ok: false, message: "`tabId` is required and must be a non-empty string." };
    return { ok: true, args: { tabId, workspaceId: optionalString(record, "workspaceId") } };
  },
  run(store, args) {
    const found = findTab(store, args.tabId, args.workspaceId);
    if (!found) {
      return {
        ok: false,
        message: args.workspaceId
          ? `No tab with id "${args.tabId}" was found in workspace "${args.workspaceId}".`
          : `No tab with id "${args.tabId}" was found.`,
      };
    }
    return { ok: true, data: tabSummary(found.tab, found.workspace) };
  },
};

export const listWorkspacesAction: ActionDefinition<Record<string, never>, { workspaces: ReturnType<typeof workspaceSummary>[] }> = {
  name: "list_workspaces",
  description: "List every workspace the user has, with tab and group counts. Use this to resolve a workspace name (e.g. \"Physics IA\") to its id.",
  readOnly: true,
  parameters: { type: "OBJECT", properties: {}, required: [] },
  validate() {
    return { ok: true, args: {} };
  },
  run(store) {
    return { ok: true, data: { workspaces: store.workspaces.map(workspaceSummary) } };
  },
};

type GetWorkspaceData = ReturnType<typeof workspaceSummary> & { sampleTabs: ReturnType<typeof tabSummary>[] };

export const getWorkspaceAction: ActionDefinition<{ workspaceId: string }, GetWorkspaceData> = {
  name: "get_workspace",
  description: "Get one workspace's details — name, tab/group counts, and a small sample of its tabs.",
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
    return {
      ok: true,
      data: {
        ...workspaceSummary(workspace),
        sampleTabs: workspace.tabs.slice(0, SAMPLE_TABS_CAP).map((t) => tabSummary(t, workspace)),
      },
    };
  },
};

type ListWorkspaceTabsData = { workspaceId: string; total: number; tabs: ReturnType<typeof tabSummary>[]; truncated: boolean };

export const listWorkspaceTabsAction: ActionDefinition<{ workspaceId: string; query?: string; limit?: number }, ListWorkspaceTabsData> = {
  name: "list_workspace_tabs",
  description: "List the tabs saved in one workspace, optionally filtered by keyword. Use this to enumerate tabs before a bulk move.",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING" },
      query: { type: "STRING", description: "Optional keyword filter." },
      limit: { type: "INTEGER", description: `Max tabs to return (default ${LIST_TABS_DEFAULT_LIMIT}, capped at ${LIST_TABS_MAX_LIMIT}).` },
    },
    required: ["workspaceId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `workspaceId` string." };
    const workspaceId = requiredString(record, "workspaceId");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    return { ok: true, args: { workspaceId, query: optionalString(record, "query"), limit: optionalInteger(record, "limit") } };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };

    const limit = Math.min(Math.max(args.limit ?? LIST_TABS_DEFAULT_LIMIT, 1), LIST_TABS_MAX_LIMIT);
    const filtered = args.query ? workspace.tabs.filter((t) => matchesQuery(t, args.query!)) : workspace.tabs;

    return {
      ok: true,
      data: {
        workspaceId: workspace.id,
        total: filtered.length,
        tabs: filtered.slice(0, limit).map((t) => tabSummary(t, workspace)),
        truncated: filtered.length > limit,
      },
    };
  },
};
