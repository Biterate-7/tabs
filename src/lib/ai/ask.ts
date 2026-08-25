import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";
import { embedTexts } from "./embed-client";
import { retrieveRelevantChunks, retrieveRelevantChunksAcrossWorkspaces, toSemanticHints } from "./retrieve";
import { formatApiError } from "./types";
import type { AskMessage, AskSource, OrganizationPlan, PerformedActionView, PlannedActionView, SearchResult } from "./types";
import type { SemanticHint } from "@/lib/search/types";
import type { SemanticClusterHint } from "@/lib/organize/types";
import type { BrowserContextSnapshot } from "@/lib/browser/protocol";

const MAX_HISTORY_MESSAGES = 6;
/** How many cross-workspace semantic candidates to hand the agent's search_tabs as a hint — generous relative to retrieveRelevantChunks' single-workspace default, since this is auxiliary signal the server's hybrid ranker combines with keyword/metadata matches, not the sole source of results. */
const SEMANTIC_HINTS_TOP_K = 30;
export const NOT_ENOUGH_INFO_MESSAGE = "I couldn't find enough information in your saved tabs to answer that.";

export type AskResult =
  | { ok: true; text: string; sources: AskSource[]; searchResults?: SearchResult[]; actions?: PerformedActionView[] }
  | { ok: true; requiresConfirmation: true; text: string; plan: PlannedActionView[]; summary: string; searchResults?: SearchResult[] }
  | { ok: true; organizePlan: OrganizationPlan; text: string }
  | { ok: false; error: string };

export type ApplyPlanResult = { ok: true; text: string; actions?: PerformedActionView[] } | { ok: false; error: string };

function toSource(tab: Tab | undefined, fallback: { tabId: string; title: string; url: string }): AskSource {
  return {
    tabId: fallback.tabId,
    title: tab?.title?.trim() || fallback.title,
    url: tab?.url ?? fallback.url,
    domain: tab?.domain ?? new URL(fallback.url).hostname,
    category: tab?.category,
  };
}

/**
 * Answers `question` grounded in `workspaceId`'s indexed chunks. Retrieval
 * happens first and entirely client-side; if nothing relevant is indexed,
 * this returns the fixed "not enough information" message without ever
 * calling Gemini (spec Step 14, and a free cost-control win).
 *
 * That retrieval starts from a query embedding, which needs its own network
 * round trip (see embed-client.ts) and can itself fail. Plain grounded Q&A
 * (`store` unset) has no other way to work, so that failure is fatal there,
 * same as always. But most of what agent mode (`store` set) does — listing/
 * renaming/moving workspaces, browser control, etc. — needs no embedding at
 * all; only search_tabs' semantic ranking benefits from one. So there, a
 * failed embedding degrades retrieval to keyword/metadata-only (via
 * `semanticSearchDegraded` in the request to /api/ai/ask, which the agent is
 * told about explicitly) instead of blocking the request outright.
 */
export async function askQuestion(params: {
  workspaceId: string;
  tabs: Tab[];
  question: string;
  history: AskMessage[];
  onDelta?: (deltaText: string) => void;
  signal?: AbortSignal;
  /**
   * When given, the request goes through the tool-calling "agent" endpoint
   * instead of the plain streaming "chat" one — Gemini can then act on
   * TabDump (create/rename workspaces and groups, move tabs) via the
   * server-side action layer, scoped to exactly this snapshot. Omit this to
   * get the original grounded-Q&A-only behavior unchanged.
   */
  store?: WorkspaceStore;
  /**
   * Called with the action layer's resulting store when a write action
   * actually changed something — the caller is responsible for persisting
   * it (this module never touches localStorage itself). `description` is
   * the same natural-language text the assistant message shows, handed
   * back here too so the caller can label an undo entry for this exact
   * mutation without re-deriving it.
   */
  onStoreUpdate?: (store: WorkspaceStore, description?: string) => void;
  /**
   * The previous turn's search_tabs results, if any — passed straight
   * through to the agent so it can resolve a follow-up like "move those
   * into Physics IA" without re-searching. Only meaningful with `store`
   * set; ignored on the plain "chat" path.
   */
  recentSearchResults?: SearchResult[];
  /** Live browser tabs/windows snapshot (see src/lib/browser/context.ts) — omitted when the extension isn't connected. Only meaningful with `store` set. */
  browserContext?: BrowserContextSnapshot;
  /** Precomputed tab-to-tab semantic grouping for propose_auto_organize (see src/lib/ai/cluster.ts) — only meaningful with `store` set. Omit when the caller didn't bother computing it (e.g. the question doesn't look like an Auto-Organize request — see src/lib/organize/intent.ts). */
  semanticClusters?: SemanticClusterHint[];
}): Promise<AskResult> {
  const { workspaceId, tabs, question, history, onDelta, signal, store, onStoreUpdate, recentSearchResults, browserContext, semanticClusters } = params;

  const embedResult = await embedTexts([question]);
  // Plain grounded Q&A (`store` unset) has no fallback path — semantic
  // retrieval against the query embedding IS the entire feature there, so an
  // embedding failure is a hard failure, same as before this change. Agent
  // mode (`store` set) is different: most of what it does — list/rename/move/
  // browser-control actions — needs no embedding at all, only search_tabs'
  // semantic ranking benefits from one. So there, a failed embedding degrades
  // retrieval/semanticHints to empty rather than blocking the request; the
  // agent is told explicitly (see semanticSearchDegraded below) so it stays
  // honest about the degradation instead of silently presenting keyword-only
  // matches as complete semantic results.
  if (!embedResult.ok && !store) return { ok: false, error: embedResult.error };
  const queryEmbedding = embedResult.ok ? embedResult.embeddings[0] : null;

  const chunks = queryEmbedding ? await retrieveRelevantChunks(workspaceId, queryEmbedding) : [];
  if (chunks.length === 0 && !store) {
    return { ok: true, text: NOT_ENOUGH_INFO_MESSAGE, sources: [] };
  }

  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const context = chunks.map((c) => {
    const tab = tabById.get(c.tabId);
    return { tabId: c.tabId, title: tab?.title?.trim() || c.title, url: c.url, text: c.text };
  });
  const sources = chunks.map((c) => toSource(tabById.get(c.tabId), c));

  const trimmedHistory = history
    .filter((m) => !m.pending)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", text: m.text }));

  if (store) {
    // Semantic hints for search_tabs need to span every workspace (global
    // search), not just the current one context/sources are grounded in
    // above — so this is a separate retrieval, reusing the SAME query
    // embedding (no extra embedding call). Best-effort: IndexedDB being
    // briefly unavailable shouldn't fail the whole request, just fall back
    // to keyword/metadata-only search server-side. When queryEmbedding is
    // null (the embed call itself failed — see above), there's nothing to
    // rank with, so this is skipped entirely rather than attempted.
    let semanticHints: SemanticHint[] = [];
    if (queryEmbedding) {
      try {
        const allChunks = await retrieveRelevantChunksAcrossWorkspaces(
          store.workspaces.map((w) => w.id),
          queryEmbedding,
          { topK: SEMANTIC_HINTS_TOP_K }
        );
        semanticHints = toSemanticHints(allChunks);
      } catch {
        semanticHints = [];
      }
    }
    // Told to the agent (see AGENT_SYSTEM_INSTRUCTION's semantic-degradation
    // preamble in the route handler) so it stays honest about search_tabs
    // only matching by keyword/metadata right now, instead of silently
    // presenting a keyword-only result as if it were a full semantic match —
    // requirement 3 of the fix: never fabricate a semantic result.
    const semanticSearchDegraded = !embedResult.ok;

    let agentResponse: Response;
    try {
      agentResponse = await fetch("/api/ai/ask", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "agent",
          question,
          history: trimmedHistory,
          context,
          store,
          semanticHints,
          recentSearchResults: recentSearchResults ?? [],
          ...(browserContext ? { browserContext } : {}),
          ...(semanticClusters && semanticClusters.length > 0 ? { semanticClusters } : {}),
          ...(semanticSearchDegraded ? { semanticSearchDegraded: true } : {}),
        }),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : undefined;
      return { ok: false, error: detail ? `Couldn't reach the AI service. (${detail})` : "Couldn't reach the AI service." };
    }

    if (!agentResponse.ok) {
      const data = await agentResponse.json().catch(() => null);
      return { ok: false, error: formatApiError(data, agentResponse.status) };
    }

    const data = (await agentResponse.json()) as {
      text: string;
      store?: WorkspaceStore;
      requiresConfirmation?: boolean;
      plan?: PlannedActionView[];
      summary?: string;
      searchResults?: SearchResult[];
      actions?: PerformedActionView[];
      organizePlan?: OrganizationPlan;
    };

    if (data.organizePlan) {
      return { ok: true, organizePlan: data.organizePlan, text: data.text };
    }

    if (data.requiresConfirmation) {
      return {
        ok: true,
        requiresConfirmation: true,
        text: data.text,
        plan: data.plan ?? [],
        summary: data.summary ?? "",
        ...(data.searchResults ? { searchResults: data.searchResults } : {}),
      };
    }

    if (data.store) onStoreUpdate?.(data.store, data.text);
    return {
      ok: true,
      text: data.text,
      sources,
      ...(data.searchResults ? { searchResults: data.searchResults } : {}),
      ...(data.actions && data.actions.length > 0 ? { actions: data.actions } : {}),
    };
  }

  let response: Response;
  try {
    response = await fetch("/api/ai/ask", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chat", question, history: trimmedHistory, context }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : undefined;
    return { ok: false, error: detail ? `Couldn't reach the AI service. (${detail})` : "Couldn't reach the AI service." };
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { ok: false, error: formatApiError(data, response.status) };
  }

  if (!response.body) {
    const text = await response.text();
    return { ok: true, text, sources };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const delta = decoder.decode(value, { stream: true });
      text += delta;
      onDelta?.(delta);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : "the connection was interrupted.";
    if (text) {
      // The connection dropped mid-stream, but the model had already said
      // something — keep it visible rather than throwing it away.
      return { ok: true, text: `${text}\n\n_(response cut off: ${detail})_`, sources };
    }
    return { ok: false, error: `Couldn't reach the AI service. (${detail})` };
  }

  return { ok: true, text, sources };
}

/**
 * Executes a plan the user has approved (see AskResult's requiresConfirmation
 * variant above). `plan` here is only ever the exact steps the agent
 * proposed and the user saw rendered — never edited client-side — but the
 * server treats it as untrusted input regardless and revalidates every step
 * from scratch against `store` before touching anything. Deliberately
 * separate from askQuestion(): applying needs no embeddings retrieval, no
 * Gemini call, and no conversation history — it's just "run these specific
 * actions for real now."
 */
export async function applyPlan(params: {
  plan: PlannedActionView[];
  store: WorkspaceStore;
  /** See askQuestion's onStoreUpdate — same shape, same purpose (labeling an undo entry). */
  onStoreUpdate?: (store: WorkspaceStore, description?: string) => void;
  signal?: AbortSignal;
  /** Refetched fresh right before applying (see askQuestion's) — a browser write action re-checks the extension/tab state at apply time too, not just at preview time. */
  browserContext?: BrowserContextSnapshot;
}): Promise<ApplyPlanResult> {
  const { plan, store, onStoreUpdate, signal, browserContext } = params;

  let response: Response;
  try {
    response = await fetch("/api/ai/ask", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "agent-apply",
        plan: plan.map(({ name, args }) => ({ name, args })),
        store,
        ...(browserContext ? { browserContext } : {}),
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : undefined;
    return { ok: false, error: detail ? `Couldn't reach the AI service. (${detail})` : "Couldn't reach the AI service." };
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { ok: false, error: formatApiError(data, response.status) };
  }

  const data = (await response.json()) as { text: string; store?: WorkspaceStore; actions?: PerformedActionView[] };
  if (data.store) onStoreUpdate?.(data.store, data.text);
  return { ok: true, text: data.text, ...(data.actions && data.actions.length > 0 ? { actions: data.actions } : {}) };
}

/**
 * Executes an approved OrganizationPlan (see AskResult's `organizePlan`
 * variant above) — the Auto-Organize counterpart to applyPlan(). Same
 * "never trust a stale preview" contract: the server revalidates the whole
 * plan against the current store before touching anything (see
 * src/lib/organize/apply.ts). Separate from applyPlan() because an
 * OrganizationPlan isn't a flat `{name,args}[]` — see the "agent-organize-apply"
 * mode's own doc in the route handler.
 */
export async function applyOrganizationPlan(params: {
  organizationPlan: OrganizationPlan;
  store: WorkspaceStore;
  /** See askQuestion's onStoreUpdate — same shape, same purpose (labeling an undo entry). */
  onStoreUpdate?: (store: WorkspaceStore, description?: string) => void;
  signal?: AbortSignal;
  browserContext?: BrowserContextSnapshot;
}): Promise<ApplyPlanResult> {
  const { organizationPlan, store, onStoreUpdate, signal, browserContext } = params;

  let response: Response;
  try {
    response = await fetch("/api/ai/ask", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "agent-organize-apply",
        organizationPlan,
        store,
        ...(browserContext ? { browserContext } : {}),
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : undefined;
    return { ok: false, error: detail ? `Couldn't reach the AI service. (${detail})` : "Couldn't reach the AI service." };
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { ok: false, error: formatApiError(data, response.status) };
  }

  const data = (await response.json()) as { text: string; store?: WorkspaceStore; actions?: PerformedActionView[] };
  if (data.store) onStoreUpdate?.(data.store, data.text);
  return { ok: true, text: data.text, ...(data.actions && data.actions.length > 0 ? { actions: data.actions } : {}) };
}
