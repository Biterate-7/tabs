/**
 * Shared vocabulary for global search — deliberately dependency-free (no
 * import from lib/ai or lib/actions) so both sides can depend on it without
 * a layering inversion: lib/ai/retrieve.ts (client, produces SemanticHints)
 * and lib/actions/* (server, consumes them to build SearchResults).
 */

export type MatchReason = "title" | "url" | "workspace" | "group" | "semantic" | "keyword";

/**
 * Where one SearchResult came from — a saved TabDump tab, or the user's
 * actual currently-open browser tab (see rankBrowserTabs in rank.ts, and
 * ActionRunContext.browserContext). Optional (rather than required) on
 * SearchResult itself specifically so every pre-existing literal/fixture in
 * this codebase (tests, recentSearchResults round-trips) keeps typechecking
 * unchanged — an absent `source` has always meant, and still means,
 * "tabdump." New results (rankTabs/rankBrowserTabs) always set it explicitly.
 */
export type SearchResultSource = "tabdump" | "browser";

/**
 * One tab's relevance to a search query — either a saved TabDump tab or a
 * live open browser tab (see `source`). Never carries embedding vectors —
 * this is the only shape of search data that ever reaches Gemini or the UI.
 * `workspaceId`/`workspaceName` only ever apply to `source: "tabdump"`;
 * `browserTabId`/`browserWindowId` only ever apply to `source: "browser"`.
 */
export type SearchResult = {
  source?: SearchResultSource;
  tabId: string;
  title: string;
  url: string;
  domain: string;
  workspaceId?: string;
  workspaceName?: string;
  groupId?: string;
  groupName?: string;
  /** The browser's own numeric tab id — only set for `source: "browser"`. */
  browserTabId?: number;
  /** The browser window this tab lives in — only set for `source: "browser"`. */
  browserWindowId?: number;
  score: number;
  matchReason: MatchReason;
};

/**
 * A precomputed semantic-similarity signal for one tab, relative to
 * whatever query text it was scored against — the ONLY form embeddings
 * ever take once they leave the browser's IndexedDB. `score` is a cosine
 * similarity in [-1, 1] (in practice ~[0, 1] for the embedding model in
 * use); never the underlying vector itself.
 */
export type SemanticHint = {
  tabId: string;
  workspaceId: string;
  score: number;
};
