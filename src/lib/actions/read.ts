import { matchesQuery } from "@/lib/workspace/search";
import { DEFAULT_SEARCH_LIMIT, rankBrowserTabs, rankTabs } from "@/lib/search/rank";
import type { SearchResult } from "@/lib/search/types";
import { asRecord, optionalBoolean, optionalInteger, optionalString, requiredString } from "./validate";
import { findTab, findWorkspace, tabSummary, workspaceSummary } from "./lookup";
import type { ActionDefinition } from "./types";

// Raised from 50: the old default was smaller than plenty of real
// workspaces (the landing page's own copy advertises pasting "20, 50, or
// even 100 tabs at once"), so an agent turn that never bothered to pass an
// explicit `limit` silently saw only part of the workspace. 100 still keeps
// a single tool response bounded — same JSON shape, same per-tab cost as
// before, just enough of them to cover a normal-sized workspace in one call
// without the model needing to think about pagination at all. Anything
// bigger still gets everything via `offset`/`nextOffset` below — this is a
// convenience default, not the safety limit (that's LIST_TABS_MAX_LIMIT).
const LIST_TABS_DEFAULT_LIMIT = 100;
// The hard per-call cap, unchanged — never returns more than this many tabs
// in one response no matter what `limit` is requested, so a single
// tool-calling turn's prompt size stays bounded regardless of workspace
// size. A workspace larger than this is paged through via `offset`, not by
// raising this further.
const LIST_TABS_MAX_LIMIT = 200;
const SAMPLE_TABS_CAP = 20;

type SearchTabsData = { matchCount: number; matches: SearchResult[]; truncated: boolean };

export const searchTabsAction: ActionDefinition<{ query: string; workspaceId?: string; includeBrowser?: boolean }, SearchTabsData> = {
  name: "search_tabs",
  description:
    "Search across the user's saved TabDump tabs AND, when the browser extension is connected, their actual currently-open browser tabs — a hybrid of keyword matching (title, URL, domain, workspace name) and semantic similarity for saved tabs. Searches across every workspace unless workspaceId is given. Use this to find tabs the user refers to by topic (e.g. \"Physics IA tabs\", \"my MUN research\", \"find anything about South Ossetia\") before acting on them — the returned tabId values can be passed directly to move_tabs/open_tabs or other actions without asking the user for ids. Each result's `source` is \"tabdump\" (a saved tab — has workspaceId/workspaceName) or \"browser\" (a live open tab — has browserTabId/browserWindowId instead, usable with close_tab(s)/pin_tab/import_browser_tabs_to_workspace). Set includeBrowser to false to search only saved tabs.",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      query: { type: "STRING", description: "A natural-language description of what to find, e.g. \"Physics IA\" or \"tabs about orbital mechanics\"." },
      workspaceId: { type: "STRING", description: "Optional — limit the saved-tab search to one workspace. Omit to search everywhere. Doesn't affect browser-tab results." },
      includeBrowser: { type: "BOOLEAN", description: "Whether to also search live open browser tabs when the extension is connected. Defaults to true." },
    },
    required: ["query"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `query` string." };
    const query = requiredString(record, "query");
    if (!query) return { ok: false, message: "`query` is required and must be a non-empty string." };
    return {
      ok: true,
      args: { query, workspaceId: optionalString(record, "workspaceId"), includeBrowser: optionalBoolean(record, "includeBrowser") },
    };
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
    const tabdumpMatches = rankTabs({
      workspaces: scope,
      query: args.query,
      semanticHints: ctx?.semanticHints,
      limit: DEFAULT_SEARCH_LIMIT * 4,
    });

    const includeBrowser = args.includeBrowser ?? true;
    const browserMatches =
      includeBrowser && ctx?.browserContext
        ? rankBrowserTabs({ tabs: ctx.browserContext.tabs, query: args.query, limit: DEFAULT_SEARCH_LIMIT * 4 })
        : [];

    const allMatches = [...tabdumpMatches, ...browserMatches].sort((a, b) => b.score - a.score);

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

type ListWorkspaceTabsData = {
  workspaceId: string;
  /** Count of tabs matching the filter across the WHOLE workspace, not just this page. */
  total: number;
  /** The zero-based index this page started at — echoes the request (0 when `offset` was omitted). */
  offset: number;
  tabs: ReturnType<typeof tabSummary>[];
  /** True iff tabs remain beyond this page — i.e. this response is NOT the complete workspace. */
  truncated: boolean;
  /**
   * Present only when `truncated` is true — pass this straight back as
   * `offset` to get the next page. Its absence (rather than some sentinel
   * like -1) is itself the "there is no next page" signal, so a caller can't
   * mistake a stale/copied value for "keep going."
   */
  nextOffset?: number;
  /**
   * Present only when `truncated` is true — a plain-language, impossible-to-
   * miss restatement of the same fact `truncated`/`nextOffset` encode
   * structurally. A lone boolean buried in a JSON tool result is easy for a
   * model to skim past (this is exactly how the original bug happened —
   * see AGENTS.md/agent.ts's system instruction for how this gets used);
   * spelling out the exact next call to make is what actually gets acted on.
   */
  note?: string;
};

export const listWorkspaceTabsAction: ActionDefinition<{ workspaceId: string; query?: string; limit?: number; offset?: number }, ListWorkspaceTabsData> = {
  name: "list_workspace_tabs",
  description:
    `List the tabs saved in one workspace, optionally filtered by keyword. Use this to enumerate tabs before a bulk move, or to gather a workspace's full contents before summarizing it. Returns up to ${LIST_TABS_DEFAULT_LIMIT} tabs by default (${LIST_TABS_MAX_LIMIT} max per call) in a stable order, plus \`total\`/\`truncated\`/\`nextOffset\`. When \`truncated\` is true, the workspace has more tabs than this one call returned — call this again with \`offset\` set to the returned \`nextOffset\` (and the same \`query\`, if any) to keep paging until \`truncated\` is false, before treating the result as the whole workspace.`,
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      workspaceId: { type: "STRING" },
      query: { type: "STRING", description: "Optional keyword filter." },
      limit: { type: "INTEGER", description: `Max tabs to return (default ${LIST_TABS_DEFAULT_LIMIT}, capped at ${LIST_TABS_MAX_LIMIT}).` },
      offset: { type: "INTEGER", description: "Zero-based index to start listing from, for paging through a workspace larger than one call's limit. Pass the previous call's `nextOffset` to continue. Defaults to 0." },
    },
    required: ["workspaceId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `workspaceId` string." };
    const workspaceId = requiredString(record, "workspaceId");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    return {
      ok: true,
      args: {
        workspaceId,
        query: optionalString(record, "query"),
        limit: optionalInteger(record, "limit"),
        offset: optionalInteger(record, "offset"),
      },
    };
  },
  run(store, args) {
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };

    const limit = Math.min(Math.max(args.limit ?? LIST_TABS_DEFAULT_LIMIT, 1), LIST_TABS_MAX_LIMIT);
    // Negative/absent offsets are just "start from the top" — never an
    // error, so a model that omits `offset` on its first call (the common
    // case) behaves exactly as before this field existed.
    const offset = Math.max(args.offset ?? 0, 0);
    // `workspace.tabs` is a plain array in stable insertion order, and this
    // action never mutates it — the same (query, offset, limit) always
    // slices the same window, so sequential pages neither skip nor repeat a
    // tab even across separate calls within one agent turn.
    const filtered = args.query ? workspace.tabs.filter((t) => matchesQuery(t, args.query!)) : workspace.tabs;
    const page = filtered.slice(offset, offset + limit);
    const truncated = offset + page.length < filtered.length;

    return {
      ok: true,
      data: {
        workspaceId: workspace.id,
        total: filtered.length,
        offset,
        tabs: page.map((t) => tabSummary(t, workspace)),
        truncated,
        ...(truncated
          ? {
              nextOffset: offset + page.length,
              note: `Returned ${page.length} of ${filtered.length} matching tabs (offset ${offset}–${offset + page.length - 1}). ${filtered.length - offset - page.length} more remain — call list_workspace_tabs again with offset: ${offset + page.length}${args.query ? ` and the same query: "${args.query}"` : ""} to get the rest before treating this as the complete workspace.`,
            }
          : {}),
      },
    };
  },
};
