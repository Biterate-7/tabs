import type { Tab } from "@/lib/tabs/types";
import { sampleChunksForTabs } from "./retrieve";
import type { AskSource, CollectionOverview, CollectionGaps } from "./types";

const MAX_CONTEXT_ITEMS = 40;

type ContextItem = { tabId: string; title: string; url: string; text: string };
type AnalysisResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function gatherContext(
  workspaceId: string,
  tabs: Tab[]
): Promise<{ context: ContextItem[]; tabById: Map<string, Tab> } | { error: string }> {
  if (tabs.length === 0) return { error: "This category has no tabs to analyze yet." };

  const chunks = await sampleChunksForTabs(workspaceId, tabs.map((t) => t.id), MAX_CONTEXT_ITEMS);
  if (chunks.length === 0) {
    return { error: "These tabs haven't finished indexing yet — try again in a moment." };
  }

  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const context = chunks.map((c) => ({
    tabId: c.tabId,
    title: tabById.get(c.tabId)?.title?.trim() || c.title,
    url: c.url,
    text: c.text,
  }));

  return { context, tabById };
}

async function callAnalysisApi(
  mode: "collection-overview" | "collection-gaps",
  question: string,
  context: ContextItem[]
): Promise<AnalysisResult<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetch("/api/ai/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, question, history: [], context }),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the AI service." };
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: (data && data.error) || `Request failed (${response.status}).` };
  if (!data || typeof data.result !== "object") return { ok: false, error: "Malformed response." };
  return { ok: true, data: data.result };
}

export async function analyzeCollection(
  workspaceId: string,
  categoryName: string,
  tabs: Tab[]
): Promise<AnalysisResult<CollectionOverview>> {
  const gathered = await gatherContext(workspaceId, tabs);
  if ("error" in gathered) return { ok: false, error: gathered.error };
  const { context, tabById } = gathered;

  const result = await callAnalysisApi(
    "collection-overview",
    `Summarize this "${categoryName}" collection.`,
    context
  );
  if (!result.ok) return result;

  const raw = result.data as {
    overview?: string;
    themes?: string[];
    importantResourceIndexes?: number[];
    keyInsights?: string[];
  };

  const importantResources: AskSource[] = (raw.importantResourceIndexes ?? [])
    .map((i) => context[i - 1])
    .filter((item): item is ContextItem => Boolean(item))
    .map((item) => {
      const tab = tabById.get(item.tabId);
      return {
        tabId: item.tabId,
        title: item.title,
        url: item.url,
        domain: tab?.domain ?? new URL(item.url).hostname,
        category: tab?.category,
      };
    });

  return {
    ok: true,
    data: {
      overview: raw.overview ?? "",
      themes: raw.themes ?? [],
      importantResources,
      keyInsights: raw.keyInsights ?? [],
    },
  };
}

export async function findCollectionGaps(
  workspaceId: string,
  categoryName: string,
  tabs: Tab[]
): Promise<AnalysisResult<CollectionGaps>> {
  const gathered = await gatherContext(workspaceId, tabs);
  if ("error" in gathered) return { ok: false, error: gathered.error };

  const result = await callAnalysisApi(
    "collection-gaps",
    `What might be missing from this "${categoryName}" collection?`,
    gathered.context
  );
  if (!result.ok) return result;

  const raw = result.data as { covered?: string[]; gaps?: string[] };
  return { ok: true, data: { covered: raw.covered ?? [], gaps: raw.gaps ?? [] } };
}
