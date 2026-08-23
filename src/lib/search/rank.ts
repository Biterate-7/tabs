import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
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
  urlOrDomain: 3,
  workspaceName: 2.5,
  /** Multiplied by the semantic hint's cosine similarity (already thresholded upstream — see retrieveRelevantChunksAcrossWorkspaces). */
  semantic: 3,
};

/** How many candidates rankTabs() returns by default — "retrieve top 20." Callers (search_tabs) may pass their own limit. */
export const DEFAULT_SEARCH_LIMIT = 20;

function scoreTab(
  tab: Tab,
  workspace: Workspace,
  query: string,
  semanticScore: number
): { score: number; matchReason: MatchReason } {
  const q = query.trim().toLowerCase();
  let score = 0;
  let matchReason: MatchReason | null = null;

  if (q) {
    const title = (tab.title?.trim() || tab.domain).toLowerCase();
    if (title === q) {
      score += SEARCH_WEIGHTS.titleExact;
      matchReason = "title";
    } else if (title.includes(q)) {
      score += SEARCH_WEIGHTS.titleSubstring;
      matchReason = "title";
    }

    if (tab.domain.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q)) {
      score += SEARCH_WEIGHTS.urlOrDomain;
      matchReason ??= "url";
    }

    if (workspace.name.toLowerCase().includes(q)) {
      score += SEARCH_WEIGHTS.workspaceName;
      matchReason ??= "workspace";
    }

    // Tabs have no group assignment in this version of TabDump (groups are
    // workspace-level containers created via create_group, but no action
    // yet puts a tab *in* one) — so there's no per-tab group name to match
    // against, and SearchResult.groupId/groupName below stay unset rather
    // than faking a value. Wire this up once tab→group assignment exists.
  }

  if (semanticScore > 0) {
    score += semanticScore * SEARCH_WEIGHTS.semantic;
    matchReason ??= "semantic";
  }

  return { score, matchReason: matchReason ?? "keyword" };
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
      const { score, matchReason } = scoreTab(tab, workspace, params.query, semanticScore);
      if (score <= 0) continue;

      results.push({
        tabId: tab.id,
        title: tab.title?.trim() || tab.domain,
        url: tab.url,
        domain: tab.domain,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        score,
        matchReason,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
