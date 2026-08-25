import "server-only";
import { generateContent, generateContentStream } from "@/lib/ai/gemini/client";
import { chatModel, analysisModel } from "@/lib/ai/config";
import type { AgentContent, GeminiContent, GeminiResult } from "@/lib/ai/gemini/types";
import { runAgentLoop } from "@/lib/actions/agent";
import { applyPlan, isValidPlanInput } from "@/lib/actions/plan";
import { isValidWorkspaceStore } from "@/lib/workspace/persistence";
import type { WorkspaceStore } from "@/lib/workspace/types";
import type { MatchReason, SearchResult, SemanticHint } from "@/lib/search/types";
import type { BrowserContextSnapshot, BrowserTabInfo, BrowserWindowInfo } from "@/lib/browser/protocol";
import type { SemanticClusterHint } from "@/lib/organize/types";
import { isValidOrganizationPlanInput, validateOrganizationPlan } from "@/lib/organize/validate";
import { applyOrganizationPlan } from "@/lib/organize/apply";

export const runtime = "nodejs";

const MAX_CONTEXT_ITEMS = 12;
const MAX_CONTEXT_CHARS = 600;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 800;
// Silently slicing the user's own question is a real correctness bug, not
// just a size cap: a question longer than this got cut off mid-sentence
// before ever reaching the model, and Gemini then — correctly — told the
// user their query "was cut off," which read as a hallucination but was
// actually an honest description of what this route had already done to
// their input. 500 chars is well under a couple of ordinary sentences (the
// bug report's own reproduction was cut off by it); 4000 comfortably covers
// realistic questions, including a detailed multi-topic one, while still
// bounding worst-case prompt size against something pathological.
const MAX_QUESTION_CHARS = 4000;
const CHAT_MAX_OUTPUT_TOKENS = 1024;
const ANALYSIS_MAX_OUTPUT_TOKENS = 2048;
// A tool-calling turn's final answer can be a full markdown summary of a
// whole workspace (headings + a bullet per tab) — 1024 was tuned for short
// action confirmations ("Moved 7 tabs to Physics IA") and silently truncated
// anything longer, e.g. summarizing a workspace with 50+ tabs (see
// AgentTurnResult.truncated in src/lib/ai/gemini/client.ts for the other
// half of this fix — always detect and flag it when it does still happen).
const AGENT_MAX_OUTPUT_TOKENS = 4096;
const MAX_SEMANTIC_HINTS = 50;
/** Higher than MAX_SEMANTIC_HINTS since Auto-Organize needs a clustering signal across the whole library, not just top query matches — still just tabId→opaque-cluster-key pairs, never vectors (AGENTS.md section 17). */
const MAX_SEMANTIC_CLUSTER_HINTS = 1000;
/** How many of the previous turn's search results get carried into this turn's prompt for follow-ups like "move those" — smaller than what search_tabs itself returns within a turn, to keep cross-turn prompt growth bounded. */
const RECENT_SEARCH_RESULTS_LIMIT = 12;

type ContextItem = { tabId: string; title: string; url: string; text: string };
type HistoryItem = { role: "user" | "model"; text: string };
type Mode = "chat" | "agent" | "agent-apply" | "agent-organize-apply" | "collection-overview" | "collection-gaps";

const MODES: Mode[] = ["chat", "agent", "agent-apply", "agent-organize-apply", "collection-overview", "collection-gaps"];

const ERROR_STATUS: Record<string, number> = {
  "missing-key": 503,
  "rate-limited": 429,
  "network-error": 502,
  timeout: 504,
  "gemini-error": 502,
  "malformed-response": 502,
};

const ERROR_MESSAGE: Record<string, string> = {
  "missing-key": "AI features aren't configured yet.",
  "rate-limited": "Too many requests right now — try again shortly.",
  "network-error": "Couldn't reach the AI service.",
  timeout: "Gemini took too long to respond — try again.",
  "gemini-error": "The AI service returned an error.",
  "malformed-response": "The AI service returned something we couldn't parse.",
};

const CHAT_SYSTEM_INSTRUCTION = `You are Ask TabDump, an assistant that answers questions using ONLY the "Saved context" the user provides below — their own saved browser tabs. Never use outside knowledge, and never invent a fact, URL, or title that isn't in the given context.

If the context doesn't contain enough information to answer, reply with exactly: "I couldn't find enough information in your saved tabs to answer that." Otherwise answer concisely and naturally, referring to the saved items in plain language (e.g. "your saved article on X says..."). Do not output the [N] index markers themselves in your reply — they're only for your own reference.`;

const AGENT_SYSTEM_INSTRUCTION = `You are Ask TabDump, an assistant for a browser tab manager called TabDump. You can answer questions about the user's saved tabs, and you can also perform actions on their TabDump data — creating or renaming workspaces and groups, moving tabs between workspaces, and assigning or removing tabs from groups within a workspace — using the tools available to you.

A workspace can contain groups, and a tab can belong to at most one group within its own workspace. Use assign_tabs_to_group for requests like "put these tabs into General Relativity," "group my Physics tabs," or "move these tabs into the MUN research group" — create the group first with create_group if it doesn't exist yet, and move the tabs into the right workspace first with move_tabs if they aren't there yet (assign_tabs_to_group requires every tab to already be in the same workspace as the group). Use remove_tabs_from_group for "remove these tabs from the group" or "ungroup these tabs." Use list_groups, get_group, or list_group_tabs to answer read-only questions like "what groups do I have?", "what's in General Relativity?", or "show me my Physics groups."

You can also control the user's real, currently-open Chrome tabs and windows — listing them, opening URLs (including a whole saved workspace's tabs), closing tabs, pinning/unpinning (bulk_pin_tabs/bulk_unpin_tabs for more than one tab at once), moving tabs between windows, creating a new window, and saving currently-open tabs into a TabDump workspace (import_browser_tabs_to_workspace — pass tabIds to import only a specific subset, e.g. after finding them with search_tabs or list_browser_tabs, rather than every open tab). Use find_unsaved_browser_tabs for "what tabs do I have open that aren't saved in TabDump?" or "which open tabs are already saved?". These are ordinary tools alongside the TabDump ones above, not a separate assistant — choose whichever tool (or combination) actually answers the request, e.g. search_tabs then open_tabs for "find my Physics IA tabs and open them," or search_tabs then move_tabs then open_tabs for "find my Physics IA tabs, put them into Physics IA, and open them." Every browser tool requires the extension to be connected — if a browser tool call fails because it isn't, tell the user plainly (e.g. "Your TabDump browser extension isn't connected, so I can't do that") rather than guessing or silently doing nothing. Closing more than one browser tab, or deleting more than one saved tab (delete_tabs), in the same call always needs the user's confirmation before anything is actually closed/deleted — that's handled automatically, you don't need to ask separately.

Use find_duplicates for "find duplicate tabs", "which tabs are duplicates?", or "close/clean up the duplicate tabs" — it covers both saved TabDump tabs (across every workspace) and, when connected, the user's actual open browser tabs, each grouped separately with a reason and confidence ("high" for an identical URL, "medium" for a likely equivalent one like a www/non-www variant). It's read-only: once the user's confirmed which copies to remove, follow up with delete_tabs for saved-tab duplicates or close_tabs for open-tab duplicates.

search_tabs also searches the user's actual open browser tabs (tagged source "browser" in its results, alongside saved tabs tagged source "tabdump") whenever the extension is connected — this is what makes a broad request like "find anything about South Ossetia" or "open everything related to my research" span both at once. Pass includeBrowser: false to search only saved tabs.

Ground every factual answer ONLY in the "Saved context" given below and in what tool results actually return — never use outside knowledge, and never invent a fact, workspace, tab, id, or URL you weren't actually given.

Workspace, tab, and group ids are opaque strings you cannot guess. Call list_workspaces, search_tabs, or list_workspace_tabs first to resolve a name the user mentioned (e.g. "Physics workspace") to its real id before calling an action that needs one. If a tool call fails, read its error and adjust — e.g. create the destination workspace first if a move target doesn't exist yet — rather than giving up immediately.

Use search_tabs whenever the user is asking to find something by topic across their whole library (e.g. "find my Physics IA tabs", "where are my MUN tabs?") — it searches every workspace by keyword AND meaning, not just exact words. Use list_workspace_tabs instead when the user is clearly asking about one specific, already-identified workspace (e.g. "what's in this workspace?"). When you present search_tabs results to the user, organize them — e.g. grouped by workspace — rather than one flat paragraph, and mention the total count and how many workspaces they span. If search_tabs returns nothing, or only very low-scoring matches, say so honestly (e.g. "I couldn't find any strong matches for X") — never present a weak or empty result as a confident answer, and never invent tabs that weren't returned.

list_workspace_tabs returns at most one page at a time. Before summarizing, describing, or otherwise answering about a workspace's ENTIRE contents (e.g. "summarize this workspace," "summarize all my saved tabs"), check its result's "truncated" field — if true, you only have part of the workspace so far. Keep calling list_workspace_tabs again with "offset" set to the previous result's "nextOffset" (same "query", if any) until "truncated" is false, and only then write your answer from everything you collected. Never summarize or describe a workspace as complete from a result you know was truncated.

If a "Recent search results" list is given below, and the user refers to those results (e.g. "move those", "put the GitHub ones in Development"), reuse those exact tabs — filtering by title/domain/workspace as the user describes — instead of calling search_tabs again, unless they're clearly asking about something new.

If the user asks you to organize, clean up, sort, or tidy their tabs or workspaces (e.g. "organize my tabs", "clean up this workspace", "organize everything by subject", "group my research tabs", "sort my tabs into useful workspaces", "clean up my entire TabDump"), call propose_auto_organize instead of trying to work it out yourself with create_workspace/move_tabs calls — it analyzes the whole library and returns an already-validated, ready-to-review plan. Use scope "current" only when the user is clearly talking about just the workspace they're currently in; use "all" (the default) for anything broader. Call it once and stop — do not follow it with your own create_workspace/move_tabs calls.

Once you're done, reply with a short, natural-language summary of what you found or did (e.g. "Done — I moved 7 Physics tabs into Physics IA."). Never show raw tool-call JSON, ids, or the words "function call" to the user.`;

const OVERVIEW_SYSTEM_INSTRUCTION = `You analyze a user's saved TabDump tabs (given as numbered "Saved context" items) and summarize them. Base everything strictly on the given items — never invent tabs, themes, or facts not supported by them. "importantResourceIndexes" must only contain the [N] numbers of items you found genuinely useful/representative.`;

const GAPS_SYSTEM_INSTRUCTION = `You analyze a user's saved TabDump tabs (given as numbered "Saved context" items) to suggest what topics look well-covered vs. under-researched. This is only a suggestion based on what they happened to save, not an objective judgment of the subject — phrase gaps tentatively ("you may be missing...", "consider looking into...").`;

// Gemini's responseSchema uses its protobuf-derived Type enum, which is
// UPPERCASE ("OBJECT"/"STRING"/"ARRAY"/"INTEGER") — not JSON Schema's
// lowercase convention. A lowercase type here is rejected by the API with a
// 400, which is a real bug this fixes (see commit for the diagnosis).
const OVERVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    overview: { type: "STRING" },
    themes: { type: "ARRAY", items: { type: "STRING" } },
    importantResourceIndexes: { type: "ARRAY", items: { type: "INTEGER" } },
    keyInsights: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["overview", "themes", "importantResourceIndexes", "keyInsights"],
};

const GAPS_SCHEMA = {
  type: "OBJECT",
  properties: {
    covered: { type: "ARRAY", items: { type: "STRING" } },
    gaps: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["covered", "gaps"],
};

function isContextArray(value: unknown): value is ContextItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof (v as ContextItem).tabId === "string" &&
        typeof (v as ContextItem).title === "string" &&
        typeof (v as ContextItem).url === "string" &&
        typeof (v as ContextItem).text === "string"
    )
  );
}

function isHistoryArray(value: unknown): value is HistoryItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        (v as HistoryItem).role !== undefined &&
        ["user", "model"].includes((v as HistoryItem).role) &&
        typeof (v as HistoryItem).text === "string"
    )
  );
}

const MATCH_REASONS: MatchReason[] = ["title", "url", "workspace", "group", "semantic", "keyword"];

function isSemanticHintArray(value: unknown): value is SemanticHint[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof (v as SemanticHint).tabId === "string" &&
        typeof (v as SemanticHint).workspaceId === "string" &&
        typeof (v as SemanticHint).score === "number"
    )
  );
}

function isSemanticClusterHintArray(value: unknown): value is SemanticClusterHint[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof (v as SemanticClusterHint).tabId === "string" &&
        typeof (v as SemanticClusterHint).clusterKey === "string"
    )
  );
}

function isBrowserTabInfoArray(value: unknown): value is BrowserTabInfo[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof (v as BrowserTabInfo).tabId === "number" &&
        typeof (v as BrowserTabInfo).windowId === "number" &&
        typeof (v as BrowserTabInfo).url === "string" &&
        typeof (v as BrowserTabInfo).title === "string"
    )
  );
}

function isBrowserWindowInfoArray(value: unknown): value is BrowserWindowInfo[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof (v as BrowserWindowInfo).windowId === "number" &&
        Array.isArray((v as BrowserWindowInfo).tabIds)
    )
  );
}

/**
 * `browserContext` is optional client-supplied data (see
 * src/lib/browser/context.ts) — `undefined` legitimately means "the
 * extension wasn't connected when this request was made," which the
 * browser read actions turn into a clear, honest error rather than ever
 * guessing at live browser state. A malformed (present but wrong-shaped)
 * value is rejected as a 400, same as every other typed input this route
 * accepts.
 */
function isValidBrowserContext(value: unknown): value is BrowserContextSnapshot {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isBrowserTabInfoArray(v.tabs) &&
    isBrowserWindowInfoArray(v.windows) &&
    (v.activeTabId === null || typeof v.activeTabId === "number")
  );
}

/**
 * `source: "browser"` results (see rankBrowserTabs) never carry a
 * workspaceId/workspaceName — they're a live open tab, not necessarily
 * saved anywhere — so this only requires those two for the (default,
 * absent-source-means-tabdump — see SearchResult's doc) tabdump case.
 */
function isSearchResultArray(value: unknown): value is SearchResult[] {
  return (
    Array.isArray(value) &&
    value.every((v) => {
      if (!v || typeof v !== "object") return false;
      const r = v as SearchResult;
      const baseValid =
        typeof r.tabId === "string" &&
        typeof r.title === "string" &&
        typeof r.url === "string" &&
        typeof r.domain === "string" &&
        typeof r.score === "number" &&
        MATCH_REASONS.includes(r.matchReason);
      if (!baseValid) return false;
      if (r.source === "browser") return true;
      return typeof r.workspaceId === "string" && typeof r.workspaceName === "string";
    })
  );
}

/**
 * The one place a prior turn's search results re-enter the conversation as
 * plain text context — never as something Gemini can execute directly.
 * Acting on any of these ids still goes through the normal validated
 * action layer (move_tabs, etc.), exactly as if Gemini had just searched
 * for them itself.
 */
function buildRecentSearchResultsBlock(results: SearchResult[]): string {
  if (results.length === 0) return "";
  const lines = results.slice(0, RECENT_SEARCH_RESULTS_LIMIT).map((r) =>
    r.source === "browser"
      ? `- tabId: ${r.tabId} | title: ${r.title} | domain: ${r.domain} | source: open browser tab (browserTabId: ${r.browserTabId})`
      : `- tabId: ${r.tabId} | title: ${r.title} | domain: ${r.domain} | source: saved tab | workspace: ${r.workspaceName} (id: ${r.workspaceId})`
  );
  return `Recent search results (from your last search_tabs call in this conversation):\n${lines.join("\n")}\n\n`;
}

function buildContextBlock(context: ContextItem[]): string {
  return context
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(
      (item, i) =>
        `[${i + 1}] Title: ${item.title}\nURL: ${item.url}\n${item.text.slice(0, MAX_CONTEXT_CHARS)}`
    )
    .join("\n\n");
}

function errorResponse(failure: Extract<GeminiResult<unknown>, { ok: false }>): Response {
  return Response.json(
    { error: ERROR_MESSAGE[failure.reason], detail: failure.detail },
    { status: ERROR_STATUS[failure.reason] }
  );
}

/**
 * Applying an approved plan needs no Gemini call and no question/context —
 * it's pure, deterministic execution of an already-decided list of
 * actions — so it's handled entirely separately from the question-driven
 * modes below. `plan` is untrusted client input (it round-tripped through
 * the browser after the user clicked Apply): applyPlan() revalidates every
 * step from scratch against `store` via the same runAction() every other
 * mode uses, exactly as if Gemini had just called it — the preview the
 * user saw is never itself treated as authorization to skip that.
 */
/**
 * Applies an approved OrganizationPlan for real — the Auto-Organize
 * counterpart to handleAgentApply above, same "never trust a stale
 * preview" revalidation pattern (see src/lib/organize/apply.ts). Separate
 * mode rather than reusing "agent-apply" because an OrganizationPlan isn't
 * a flat `{name,args}[]` — its target workspace ids often aren't known
 * until create_workspace actually runs during apply.
 */
function handleAgentOrganizeApply(b: Record<string, unknown> | null): Response {
  const storeInput = b?.store;
  if (!isValidWorkspaceStore(storeInput)) {
    return Response.json({ error: "Expected a valid { store: WorkspaceStore }." }, { status: 400 });
  }
  const planInput = b?.organizationPlan;
  if (!isValidOrganizationPlanInput(planInput)) {
    return Response.json({ error: "Expected a valid { organizationPlan: OrganizationPlan }." }, { status: 400 });
  }
  const browserContextInput = b?.browserContext;
  if (!isValidBrowserContext(browserContextInput)) {
    return Response.json({ error: "Expected a valid { browserContext } or none at all." }, { status: 400 });
  }

  const validation = validateOrganizationPlan(planInput, storeInput);
  if (!validation.ok) {
    return Response.json({ error: `That organization plan is no longer valid: ${validation.errors[0]}` }, { status: 400 });
  }

  const result = applyOrganizationPlan(planInput, storeInput, { browserContext: browserContextInput as BrowserContextSnapshot | undefined });
  return Response.json({
    text: result.text,
    actions: result.actions,
    ...(result.storeChanged ? { store: result.store } : {}),
  });
}

function handleAgentApply(b: Record<string, unknown> | null): Response {
  const storeInput = b?.store;
  if (!isValidWorkspaceStore(storeInput)) {
    return Response.json({ error: "Expected a valid { store: WorkspaceStore }." }, { status: 400 });
  }
  const planInput = b?.plan;
  if (!isValidPlanInput(planInput)) {
    return Response.json({ error: "Expected a non-empty { plan: {name, args}[] }." }, { status: 400 });
  }
  const browserContextInput = b?.browserContext;
  if (!isValidBrowserContext(browserContextInput)) {
    return Response.json({ error: "Expected a valid { browserContext } or none at all." }, { status: 400 });
  }

  const result = applyPlan(planInput, storeInput, { browserContext: browserContextInput as BrowserContextSnapshot | undefined });
  return Response.json({
    text: result.text,
    actions: result.actions,
    ...(result.storeChanged ? { store: result.store } : {}),
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestStartedAt = Date.now();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const b = body as Record<string, unknown> | null;
  const mode = (b?.mode as Mode | undefined) ?? "chat";

  if (!MODES.includes(mode)) {
    return Response.json({ error: "Invalid mode." }, { status: 400 });
  }

  if (mode === "agent-apply") {
    return handleAgentApply(b);
  }
  if (mode === "agent-organize-apply") {
    return handleAgentOrganizeApply(b);
  }

  const question = b?.question;
  const context = b?.context;
  const history = b?.history ?? [];

  if (typeof question !== "string" || question.trim().length === 0) {
    return Response.json({ error: "Expected a non-empty { question: string }." }, { status: 400 });
  }
  if (!isContextArray(context)) {
    return Response.json({ error: "Expected { context: {tabId,title,url,text}[] }." }, { status: 400 });
  }
  if (!isHistoryArray(history)) {
    return Response.json({ error: "Expected { history: {role,text}[] }." }, { status: 400 });
  }

  const contextBlock = buildContextBlock(context);
  const cappedQuestion = question.slice(0, MAX_QUESTION_CHARS);
  const prompt = `Saved context:\n${contextBlock || "(no saved tabs matched this question)"}\n\nUser question: ${cappedQuestion}`;

  const historyContents: GeminiContent[] = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((h) => ({ role: h.role, text: h.text.slice(0, MAX_HISTORY_CHARS) }));

  if (mode === "chat") {
    console.log(
      `[ask-route] request received; starting Gemini stream request ${Date.now() - requestStartedAt}ms after body parsed (historyMessages=${historyContents.length}, contextItems=${context.length})`
    );
    const result = await generateContentStream({
      model: chatModel(),
      systemInstruction: CHAT_SYSTEM_INSTRUCTION,
      contents: [...historyContents, { role: "user", text: prompt }],
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    });

    if (!result.ok) return errorResponse(result);

    return new Response(result.data, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (mode === "agent") {
    const storeInput = b?.store;
    if (!isValidWorkspaceStore(storeInput)) {
      return Response.json({ error: "Expected a valid { store: WorkspaceStore }." }, { status: 400 });
    }
    const store: WorkspaceStore = storeInput;

    const semanticHintsInput = b?.semanticHints;
    if (semanticHintsInput !== undefined && !isSemanticHintArray(semanticHintsInput)) {
      return Response.json({ error: "Expected { semanticHints: {tabId,workspaceId,score}[] }." }, { status: 400 });
    }
    const semanticHints = (semanticHintsInput as SemanticHint[] | undefined)?.slice(0, MAX_SEMANTIC_HINTS);

    const semanticClustersInput = b?.semanticClusters;
    if (semanticClustersInput !== undefined && !isSemanticClusterHintArray(semanticClustersInput)) {
      return Response.json({ error: "Expected { semanticClusters: {tabId,clusterKey}[] }." }, { status: 400 });
    }
    const semanticClusters = (semanticClustersInput as SemanticClusterHint[] | undefined)?.slice(0, MAX_SEMANTIC_CLUSTER_HINTS);

    const recentSearchResultsInput = b?.recentSearchResults;
    if (recentSearchResultsInput !== undefined && !isSearchResultArray(recentSearchResultsInput)) {
      return Response.json({ error: "Expected { recentSearchResults: SearchResult[] }." }, { status: 400 });
    }
    const recentSearchResults = (recentSearchResultsInput as SearchResult[] | undefined) ?? [];

    const browserContextInput = b?.browserContext;
    if (!isValidBrowserContext(browserContextInput)) {
      return Response.json({ error: "Expected a valid { browserContext } or none at all." }, { status: 400 });
    }
    const browserContext = browserContextInput as BrowserContextSnapshot | undefined;

    const semanticSearchDegradedInput = b?.semanticSearchDegraded;
    if (semanticSearchDegradedInput !== undefined && typeof semanticSearchDegradedInput !== "boolean") {
      return Response.json({ error: "Expected { semanticSearchDegraded: boolean } or none at all." }, { status: 400 });
    }
    const semanticSearchDegraded = semanticSearchDegradedInput === true;

    // Measured directly against the real agent loop (see AGENT_SYSTEM_INSTRUCTION's
    // "resolve a name... before calling an action that needs one" guidance):
    // without the second sentence here, the model reliably called
    // list_workspaces FIRST anyway, purely to re-derive the id already given
    // on the line above it — a whole extra ~15-25s non-streaming round trip
    // for something already answered. Spelling out "you already have it"
    // stops that specific redundant call without discouraging list_workspaces
    // for what it's actually for: resolving a DIFFERENT workspace the user
    // named, or discovering ones that aren't the current one.
    const currentWorkspace = store.workspaces.find((w) => w.id === store.currentId);
    const preamble = currentWorkspace
      ? `Current workspace: "${currentWorkspace.name}" (id: ${currentWorkspace.id}) — you already have its id, no need to call list_workspaces just to look it up again.\n\n`
      : "";
    const recentSearchBlock = buildRecentSearchResultsBlock(recentSearchResults);
    const browserPreamble = browserContext
      ? "The TabDump browser extension is connected — browser control actions (list_browser_tabs, open_tabs, close_tabs, etc.) are available.\n\n"
      : "The TabDump browser extension is NOT connected right now — do not call any browser control action; if the user asks to see, open, close, or otherwise control their actual browser tabs, tell them plainly that the extension isn't connected instead.\n\n";
    // The client couldn't get a query embedding this turn (e.g. the embedding
    // service was briefly unreachable) — search_tabs and the "Saved context"
    // below still work, but only via keyword/metadata matching, not meaning.
    // Most requests (list_workspaces, move_tabs, browser control, etc.) don't
    // need semantic matching at all and are unaffected; this note only matters
    // for a request that actually depends on finding tabs by topic/meaning,
    // and tells the model to say so plainly rather than presenting a
    // keyword-only result as if it were a complete semantic match.
    const semanticPreamble = semanticSearchDegraded
      ? 'Semantic (meaning-based) search is temporarily unavailable — search_tabs and the "Saved context" below only reflect keyword/metadata matching right now, not similarity in meaning. If the user\'s request depends on finding tabs by topic or meaning rather than exact words, say so plainly (e.g. "semantic search is temporarily unavailable, so I could only match by keyword") instead of presenting keyword-only results as a complete answer.\n\n'
      : "";
    const agentPrompt = `${preamble}${browserPreamble}${semanticPreamble}${recentSearchBlock}Saved context:\n${contextBlock || "(no saved tabs matched this question)"}\n\nUser question: ${cappedQuestion}`;

    const contents: AgentContent[] = [
      ...historyContents.map((h): AgentContent => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: "user", parts: [{ text: agentPrompt }] },
    ];

    console.log(`[ask-route] agent request started ${Date.now() - requestStartedAt}ms after body parsed (question length=${cappedQuestion.length}, historyMessages=${historyContents.length})`);
    const agentResult = await runAgentLoop({
      model: chatModel(),
      systemInstruction: AGENT_SYSTEM_INSTRUCTION,
      contents,
      store,
      maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
      semanticHints,
      browserContext,
      semanticClusters,
    });
    console.log(`[ask-route] agent request total: ${Date.now() - requestStartedAt}ms`);

    if (!agentResult.ok) return errorResponse(agentResult);

    if (agentResult.kind === "organize") {
      return Response.json({
        text: agentResult.text,
        organizePlan: agentResult.organizePlan,
      });
    }

    if (agentResult.kind === "preview") {
      return Response.json({
        requiresConfirmation: true,
        text: agentResult.text,
        plan: agentResult.plan,
        summary: agentResult.summary,
        ...(agentResult.searchResults ? { searchResults: agentResult.searchResults } : {}),
      });
    }

    return Response.json({
      text: agentResult.text,
      actions: agentResult.actions,
      ...(agentResult.storeChanged ? { store: agentResult.store } : {}),
      ...(agentResult.searchResults ? { searchResults: agentResult.searchResults } : {}),
    });
  }

  const isOverview = mode === "collection-overview";
  const result = await generateContent({
    model: analysisModel(),
    systemInstruction: isOverview ? OVERVIEW_SYSTEM_INSTRUCTION : GAPS_SYSTEM_INSTRUCTION,
    contents: [{ role: "user", text: prompt }],
    maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
    responseSchema: isOverview ? OVERVIEW_SCHEMA : GAPS_SCHEMA,
  });

  if (!result.ok) return errorResponse(result);

  try {
    const parsed = JSON.parse(result.data);
    return Response.json({ result: parsed });
  } catch (err) {
    return errorResponse({
      ok: false,
      reason: "malformed-response",
      detail: err instanceof Error ? err.message : "model output wasn't valid JSON",
    });
  }
}
