import { getChunksForWorkspace } from "./db";
import type { IndexedChunkRecord, RetrievedChunk } from "./types";

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SIMILARITY = 0.5;

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
  const topK = opts?.topK ?? DEFAULT_TOP_K;
  const minSimilarity = opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const chunks = await getChunksForWorkspace(workspaceId);
  const scored = chunks
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(chunk.embedding, queryEmbedding) }))
    .filter((c) => c.score >= minSimilarity);

  return dedupeByTab(scored, topK);
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
