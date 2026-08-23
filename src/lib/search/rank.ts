import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import type { BrowserTabInfo } from "@/lib/browser/protocol";
import type { MatchReason, SearchResult, SemanticHint } from "./types";

/**
 * Named, tunable weights for the hybrid ranker — the single place search
 * relevance is decided, instead of magic numbers scattered through the
 * action layer. Signals are additive (a tab matching on both title AND
 * semantics outranks one matching on just one), but `matchReason` reports
 * only the single most literal reason a tab qualified at all, in priority
 * order: an exact/substring keyword hit is more certain than "the model
 * thinks this is related," so keyword-family reasons always win over
 * "semantic" when both are present.
 */
export const SEARCH_WEIGHTS = {
  titleExact: 6,
  titleSubstring: 4,
  groupExact: 3.75,
  groupSubstring: 3.25,
  urlOrDomain: 3,
  workspaceName: 2.5,
  /** Multiplied by the semantic hint's cosine similarity (already thresholded upstream — see retrieveRelevantChunksAcrossWorkspaces). */
  semantic: 3,
};

/** How many candidates rankTabs() returns by default — "retrieve top 20." Callers (search_tabs) may pass their own limit. */
export const DEFAULT_SEARCH_LIMIT = 20;

function resolveGroup(tab: Tab, workspace: Workspace) {
  if (!tab.groupId) return undefined;
  return (workspace.groups ?? []).find((g) => g.id === tab.groupId);
}

/**
 * Ranking priority (AGENTS.md section 17): exact title > title substring >
 * exact group name > group substring > domain/URL > workspace name >
 * semantic similarity. `matchReason` follows the same priority via the
 * `??=` chain below — the first (most literal/certain) signal that actually
 * matched wins, even though `score` itself is additive across every signal
 * that matched.
 */
function scoreTab(
  tab: Tab,
  workspace: Workspace,
  query: string,
  semanticScore: number
): { score: number; matchReason: MatchReason; group?: { groupId: string; groupName: string } } {
  const q = query.trim().toLowerCase();
  let score = 0;
  let matchReason: MatchReason | null = null;
  const group = resolveGroup(tab, workspace);

  if (q) {
    const title = (tab.title?.trim() || tab.domain).toLowerCase();
    if (title === q) {
      score += SEARCH_WEIGHTS.titleExact;
      matchReason = "title";
    } else if (title.includes(q)) {
      score += SEARCH_WEIGHTS.titleSubstring;
      matchReason = "title";
    }

    if (group) {
      const groupName = group.name.trim().toLowerCase();
      if (groupName === q) {
        score += SEARCH_WEIGHTS.groupExact;
        matchReason ??= "group";
      } else if (groupName.includes(q)) {
        score += SEARCH_WEIGHTS.groupSubstring;
        matchReason ??= "group";
      }
    }

    if (tab.domain.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q)) {
      score += SEARCH_WEIGHTS.urlOrDomain;
      matchReason ??= "url";
    }

    if (workspace.name.toLowerCase().includes(q)) {
      score += SEARCH_WEIGHTS.workspaceName;
      matchReason ??= "workspace";
    }
  }

  if (semanticScore > 0) {
    score += semanticScore * SEARCH_WEIGHTS.semantic;
    matchReason ??= "semantic";
  }

  return { score, matchReason: matchReason ?? "keyword", ...(group ? { group: { groupId: group.id, groupName: group.name } } : {}) };
}

/**
 * The hybrid ranker: combines keyword/substring matching (title, URL,
 * domain, workspace name) computed fresh from the given workspaces with an
 * optional precomputed semantic signal (`semanticHints` — see
 * src/lib/ai/retrieve.ts's retrieveRelevantChunksAcrossWorkspaces, which is
 * where embeddings actually live; this function never touches IndexedDB or
 * a raw vector). Only tabs present in `workspaces` can ever appear in the
 * result — there is no path here to reach data outside what was given.
 */
export function rankTabs(params: {
  workspaces: Workspace[];
  query: string;
  semanticHints?: SemanticHint[];
  limit?: number;
}): SearchResult[] {
  const hintByTab = new Map((params.semanticHints ?? []).map((h) => [h.tabId, h.score]));
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;

  const results: SearchResult[] = [];
  for (const workspace of params.workspaces) {
    for (const tab of workspace.tabs) {
      const semanticScore = hintByTab.get(tab.id) ?? 0;
      const { score, matchReason, group } = scoreTab(tab, workspace, params.query, semanticScore);
      if (score <= 0) continue;

      results.push({
        source: "tabdump",
        tabId: tab.id,
        title: tab.title?.trim() || tab.domain,
        url: tab.url,
        domain: tab.domain,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        ...(group ? { groupId: group.groupId, groupName: group.groupName } : {}),
        score,
        matchReason,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Keyword-only scoring for one live browser tab — the browser-tab
 * counterpart to scoreTab() above, deliberately reusing the same
 * SEARCH_WEIGHTS constants (Step 3: "do NOT duplicate ranking logic") but
 * dropping the signals that don't apply to a tab that was never saved: no
 * workspace/group name to match, and no semantic hint (embeddings only ever
 * exist for indexed TabDump chunks — see src/lib/ai/retrieve.ts).
 */
function scoreBrowserTab(tab: BrowserTabInfo, query: string): { score: number; matchReason: MatchReason } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const title = (tab.title?.trim() || tab.url).toLowerCase();
  if (title === q) return { score: SEARCH_WEIGHTS.titleExact, matchReason: "title" };
  if (title.includes(q)) return { score: SEARCH_WEIGHTS.titleSubstring, matchReason: "title" };

  let domain = "";
  try {
    domain = new URL(tab.url).hostname.toLowerCase();
  } catch {
    // A browser tab can legitimately have a non-http URL (chrome://, about:)
    // that new URL() may or may not parse cleanly — fall back to the raw URL.
  }
  if ((domain && domain.includes(q)) || tab.url.toLowerCase().includes(q)) {
    return { score: SEARCH_WEIGHTS.urlOrDomain, matchReason: "url" };
  }

  return null;
}

/**
 * Ranks the user's actual open browser tabs (see
 * src/lib/browser/protocol.ts's BrowserContextSnapshot) against a query,
 * mirroring rankTabs' shape exactly so callers (search_tabs) can merge and
 * re-sort both lists together. Every result carries `source: "browser"` —
 * see SearchResultSource — and never a workspaceId/workspaceName, since a
 * live browser tab isn't necessarily saved anywhere in TabDump.
 */
export function rankBrowserTabs(params: { tabs: BrowserTabInfo[]; query: string; limit?: number }): SearchResult[] {
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
  const results: SearchResult[] = [];

  for (const tab of params.tabs) {
    const scored = scoreBrowserTab(tab, params.query);
    if (!scored || scored.score <= 0) continue;

    let domain = tab.url;
    try {
      domain = new URL(tab.url).hostname;
    } catch {
      // Same non-http fallback as scoreBrowserTab above.
    }

    results.push({
      source: "browser",
      tabId: `browser:${tab.tabId}`,
      title: tab.title?.trim() || domain,
      url: tab.url,
      domain,
      browserTabId: tab.tabId,
      browserWindowId: tab.windowId,
      score: scored.score,
      matchReason: scored.matchReason,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
