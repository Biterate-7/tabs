import { getChunksForWorkspace } from "./db";
import type { IndexedChunkRecord } from "./types";
import type { SemanticClusterHint } from "@/lib/organize/types";

/** How similar two tabs' embeddings need to be to join the same cluster — deliberately higher than search's relevance threshold (retrieve.ts's DEFAULT_MIN_SIMILARITY 0.5), since this decides "these belong in the same workspace," a much stronger claim than "this is somewhat relevant to a query." */
const SIMILARITY_THRESHOLD = 0.72;
/** Performance cap for very large libraries — AGENTS.md section 17. Clustering is O(n·k); this bounds worst case even if a library has thousands of tabs. */
const MAX_TABS_FOR_CLUSTERING = 800;

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

/** Keeps each tab's single richest chunk (a body chunk over a summary one) — mirrors src/lib/ai/retrieve.ts's dedupeByTab. */
function dedupeByTab(chunks: IndexedChunkRecord[]): IndexedChunkRecord[] {
  const byTab = new Map<string, IndexedChunkRecord>();
  for (const chunk of chunks) {
    const existing = byTab.get(chunk.tabId);
    if (!existing || (chunk.kind === "body" && existing.kind !== "body")) byTab.set(chunk.tabId, chunk);
  }
  return [...byTab.values()];
}

/**
 * Computes a tab-to-tab semantic grouping signal for Auto-Organize, entirely
 * client-side, from whatever's already indexed in the browser's IndexedDB
 * (the same per-workspace chunk index src/lib/ai/retrieve.ts's global search
 * queries — see AGENTS.md section 3's "reuse the existing semantic
 * search/embedding infrastructure"). Greedy single-pass clustering: for each
 * tab, compare its embedding against every existing cluster's centroid
 * (fixed as the first tab that started it — a lightweight approximation,
 * not a running mean) and join the best match above SIMILARITY_THRESHOLD,
 * else start a new cluster.
 *
 * Only opaque per-request cluster keys ever leave this function (see
 * SemanticClusterHint) — no embedding vector is ever returned, let alone
 * sent to the server (AGENTS.md section 17). A tab that never joins another
 * (a singleton cluster) carries no clustering signal and is simply omitted,
 * since src/lib/organize/cluster.ts can't do anything useful with a
 * "cluster" of one.
 */
export async function computeSemanticClusterHints(workspaceIds: string[]): Promise<SemanticClusterHint[]> {
  const allChunks: IndexedChunkRecord[] = [];
  for (const id of workspaceIds) {
    try {
      allChunks.push(...(await getChunksForWorkspace(id)));
    } catch {
      // Best-effort — IndexedDB being briefly unavailable shouldn't block
      // clustering from working off whatever else was indexed.
    }
  }

  const deduped = dedupeByTab(allChunks).slice(0, MAX_TABS_FOR_CLUSTERING);
  if (deduped.length === 0) return [];

  const clusters: { centroid: number[]; tabIds: string[] }[] = [];

  for (const chunk of deduped) {
    let bestIndex = -1;
    let bestScore = 0;
    clusters.forEach((cluster, i) => {
      const score = cosineSimilarity(cluster.centroid, chunk.embedding);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });

    if (bestIndex >= 0 && bestScore >= SIMILARITY_THRESHOLD) {
      clusters[bestIndex].tabIds.push(chunk.tabId);
    } else {
      clusters.push({ centroid: chunk.embedding, tabIds: [chunk.tabId] });
    }
  }

  const hints: SemanticClusterHint[] = [];
  clusters.forEach((cluster, i) => {
    if (cluster.tabIds.length < 2) return;
    const clusterKey = `sem-${i}`;
    for (const tabId of cluster.tabIds) hints.push({ tabId, clusterKey });
  });
  return hints;
}
