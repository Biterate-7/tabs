/**
 * Shared vocabulary for global search — deliberately dependency-free (no
 * import from lib/ai or lib/actions) so both sides can depend on it without
 * a layering inversion: lib/ai/retrieve.ts (client, produces SemanticHints)
 * and lib/actions/* (server, consumes them to build SearchResults).
 */

export type MatchReason = "title" | "url" | "workspace" | "group" | "semantic" | "keyword";

/**
 * One saved tab's relevance to a search query. Never carries embedding
 * vectors — this is the only shape of search data that ever reaches
 * Gemini or the UI.
 */
export type SearchResult = {
  tabId: string;
  title: string;
  url: string;
  domain: string;
  workspaceId: string;
  workspaceName: string;
  groupId?: string;
  groupName?: string;
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
