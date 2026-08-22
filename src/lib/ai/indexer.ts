import type { Tab } from "@/lib/tabs/types";
import { buildChunks, tabSignature } from "./chunk";
import { extractContentForUrls } from "./extract-client";
import { embedTexts } from "./embed-client";
import { chunkKey, getChunksForWorkspace, putChunks, deleteChunksForTabs, isIndexedDbAvailable } from "./db";
import type { IndexedChunkRecord } from "./types";

const TABS_PER_EMBED_ROUND = 20; // up to 2 chunks/tab, well under the /api/ai/embed 100-text cap

export type IndexProgress = { indexed: number; total: number };

/**
 * Indexes `tabs` for `workspaceId`. A tab is only (re)fetched and
 * (re)embedded when its tabSignature() (title/url/category) differs from
 * what's already stored — once page content has been fetched for a tab, it
 * is reused indefinitely until that tab itself changes, so re-running this
 * over an unchanged workspace does no network work at all.
 */
export async function indexWorkspace(
  workspaceId: string,
  tabs: Tab[],
  onProgress?: (progress: IndexProgress) => void
): Promise<void> {
  if (!isIndexedDbAvailable() || tabs.length === 0) return;

  const existing = await getChunksForWorkspace(workspaceId);
  const existingSignatureByTab = new Map(existing.map((r) => [r.tabId, r.tabSignature]));

  const currentTabIds = new Set(tabs.map((t) => t.id));
  const staleTabIds = Array.from(new Set(existing.map((r) => r.tabId).filter((id) => !currentTabIds.has(id))));
  if (staleTabIds.length > 0) await deleteChunksForTabs(workspaceId, staleTabIds);

  const candidates = tabs.filter((tab) => existingSignatureByTab.get(tab.id) !== tabSignature(tab));
  if (candidates.length === 0) return;

  const extracted = await extractContentForUrls(candidates.map((t) => t.url));

  let indexed = 0;
  onProgress?.({ indexed, total: candidates.length });

  for (let i = 0; i < candidates.length; i += TABS_PER_EMBED_ROUND) {
    const batch = candidates.slice(i, i + TABS_PER_EMBED_ROUND);
    const chunksByTab = batch.map((tab) => {
      const content = extracted.get(tab.url);
      const extractedForChunk = content?.ok ? { description: content.description, text: content.text } : undefined;
      return { tab, chunks: buildChunks(tab, extractedForChunk) };
    });
    const allTexts = chunksByTab.flatMap(({ chunks }) => chunks.map((c) => c.text));

    const embedResult = await embedTexts(allTexts);
    if (!embedResult.ok) {
      // Leave this batch unindexed — it's retried on the next indexing pass
      // (its tabSignature still won't match, since nothing was stored).
      continue;
    }

    let cursor = 0;
    const now = Date.now();
    const records: IndexedChunkRecord[] = [];
    for (const { tab, chunks } of chunksByTab) {
      const signature = tabSignature(tab);
      for (const chunk of chunks) {
        records.push({
          key: chunkKey(workspaceId, tab.id, chunk.kind),
          workspaceId,
          tabId: tab.id,
          kind: chunk.kind,
          text: chunk.text,
          embedding: embedResult.embeddings[cursor],
          tabSignature: signature,
          title: tab.title ?? tab.domain,
          url: tab.url,
          indexedAt: now,
        });
        cursor += 1;
      }
    }

    await putChunks(records);
    indexed += batch.length;
    onProgress?.({ indexed, total: candidates.length });
  }
}
