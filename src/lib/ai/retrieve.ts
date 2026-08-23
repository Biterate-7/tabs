import { getChunksForWorkspace } from "./db";
import type { IndexedChunkRecord, RetrievedChunk } from "./types";
import type { SemanticHint } from "@/lib/search/types";

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SIMILARITY = 0.5;
/** How many workspace-scoped chunk fetches run at once for a global search — plenty for the handful of workspaces a real user has, without firing them all as one giant unbounded Promise.all. */
const WORKSPACE_FETCH_CONCURRENCY = 6;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Keeps only each tab's single highest-scoring chunk, in descending score order. */
function dedupeByTab<T extends { tabId: string; score: number }>(chunks: T[], limit: number): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const chunk of [...chunks].sort((a, b) => b.score - a.score)) {
    if (seen.has(chunk.tabId)) continue;
    seen.add(chunk.tabId);
    result.push(chunk);
    if (result.length >= limit) break;
  }
  return result;
}

/** Shared by both retrieveRelevantChunks and its multi-workspace sibling below — scoring/thresholding/dedup is identical either way, only which chunks feed in differs. */
function scoreAndDedupe(chunks: IndexedChunkRecord[], queryEmbedding: number[], topK: number, minSimilarity: number): RetrievedChunk[] {
  const scored = chunks
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(chunk.embedding, queryEmbedding) }))
    .filter((c) => c.score >= minSimilarity);
  return dedupeByTab(scored, topK);
}

/**
 * In-browser cosine-similarity search over one workspace's indexed chunks.
 * A linear scan is plenty fast at the hundreds-to-low-thousands of tabs a
 * TabDump workspace realistically holds — no vector DB needed.
 */
export async function retrieveRelevantChunks(
  workspaceId: string,
  queryEmbedding: number[],
  opts?: { topK?: number; minSimilarity?: number }
): Promise<RetrievedChunk[]> {
  const chunks = await getChunksForWorkspace(workspaceId);
  return scoreAndDedupe(chunks, queryEmbedding, opts?.topK ?? DEFAULT_TOP_K, opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY);
}

/**
 * Same idea as retrieveRelevantChunks, but across every given workspace at
 * once — this is what makes Ask Tabs' global "find anything" search
 * semantic rather than just keyword: the same per-workspace IndexedDB
 * index (populated by useAiIndexing as the user visits workspaces) is
 * simply queried for each workspace id and merged, so a tab only shows up
 * here if it was actually indexed. No second index or vector store is
 * introduced — this is a query-time fan-out over the existing one.
 */
export async function retrieveRelevantChunksAcrossWorkspaces(
  workspaceIds: string[],
  queryEmbedding: number[],
  opts?: { topK?: number; minSimilarity?: number }
): Promise<RetrievedChunk[]> {
  const topK = opts?.topK ?? DEFAULT_TOP_K;
  const minSimilarity = opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const allChunks: IndexedChunkRecord[] = [];
  for (let i = 0; i < workspaceIds.length; i += WORKSPACE_FETCH_CONCURRENCY) {
    const batch = workspaceIds.slice(i, i + WORKSPACE_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map((id) => getChunksForWorkspace(id)));
    for (const chunks of results) allChunks.push(...chunks);
  }

  return scoreAndDedupe(allChunks, queryEmbedding, topK, minSimilarity);
}

/**
 * Strips a retrieved chunk down to the only shape that's ever safe to send
 * onward to the server/Gemini: no embedding vector, no chunk text — just
 * "this tab is this relevant." See src/lib/search/types.ts.
 */
export function toSemanticHints(chunks: RetrievedChunk[]): SemanticHint[] {
  return chunks.map((c) => ({ tabId: c.tabId, workspaceId: c.workspaceId, score: c.score }));
}

/**
 * Non-similarity sampling used by collection analysis, which has no query
 * to rank against — just "give me the best available chunk per tab in this
 * category," preferring a tab's body chunk (richer) over its summary.
 */
export async function sampleChunksForTabs(
  workspaceId: string,
  tabIds: string[],
  limit: number
): Promise<IndexedChunkRecord[]> {
  const allowed = new Set(tabIds);
  const chunks = (await getChunksForWorkspace(workspaceId)).filter((c) => allowed.has(c.tabId));

  const byTab = new Map<string, IndexedChunkRecord>();
  for (const chunk of chunks) {
    const existing = byTab.get(chunk.tabId);
    if (!existing || (chunk.kind === "body" && existing.kind !== "body")) {
      byTab.set(chunk.tabId, chunk);
    }
  }

  return Array.from(byTab.values()).slice(0, limit);
}
