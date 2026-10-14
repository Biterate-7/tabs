import { searchTerms } from "./search";
import type { Collection } from "@/lib/collections/types";
import type { Tab } from "@/lib/tabs/types";
import type { ResourceContent } from "./types";

/**
 * Which of a project's sources a selection reaches, and in what order of
 * relevance to a request.
 *
 * 1. **Selection.** The whole project, or specific sources and collections.
 *    A source the person did not select is never included, whatever its
 *    relevance.
 * 2. **Ranking.** With a request, sources whose title or text mention its
 *    words come first; otherwise the most recently added.
 *
 * Pure: the caller loads the project's contents from the content store.
 */

export type SourceSelection = {
  /** `undefined`: the whole project. */
  tabIds?: readonly string[];
  collectionIds?: readonly string[];
};

/** The project's sources a selection reaches, in the project's order. */
export function selectedSources(
  tabs: readonly Tab[],
  selection: SourceSelection | null | undefined,
  collections: readonly Pick<Collection, "id" | "tabIds">[] = []
): Tab[] {
  const sources = tabs.filter((tab) => tab.resource);
  if (!selection || (!selection.tabIds && !selection.collectionIds)) return sources;
  const wanted = new Set(selection.tabIds ?? []);
  for (const collection of collections) if (selection.collectionIds?.includes(collection.id)) collection.tabIds.forEach((id) => wanted.add(id));
  return sources.filter((tab) => wanted.has(tab.id));
}

function relevance(tab: Tab, content: ResourceContent | undefined, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const title = (tab.title ?? "").toLowerCase();
  const body = [content?.text ?? "", ...(content?.pages ?? []), ...(content?.transcript ?? []).map((line) => line.text)].join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 5;
    let at = body.indexOf(term);
    let hits = 0;
    while (at !== -1 && hits < 20) {
      hits += 1;
      at = body.indexOf(term, at + term.length);
    }
    score += hits;
  }
  return score;
}

export function rankSources(sources: readonly Tab[], contents: ReadonlyMap<string, ResourceContent>, instruction?: string): Tab[] {
  const terms = instruction ? searchTerms(instruction) : [];
  return sources
    .map((tab, index) => ({ tab, index, score: relevance(tab, contents.get(tab.id), terms), added: tab.resource?.addedAt ?? 0 }))
    .sort((a, b) => b.score - a.score || b.added - a.added || a.index - b.index)
    .map((entry) => entry.tab);
}
