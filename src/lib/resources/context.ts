import { SNAPSHOT_LIMITS } from "@/lib/agents/session-context/snapshot";
import { searchTerms } from "./search";
import type { SessionSource } from "@/lib/agents/session-context/snapshot";
import type { Collection } from "@/lib/collections/types";
import type { Tab } from "@/lib/tabs/types";
import type { ResourceContent } from "./types";

/**
 * Which sources' content a session carries — the context budget.
 *
 *     project sources ──► the session's selection ──► ranked for the task ──► budget ──► session
 *
 * 1. **Selection.** A session that was given the whole project may read every
 *    source; one given specific sources or collections reads only those. A
 *    source the person did not select is never sent, whatever its relevance.
 * 2. **Ranking.** With a task instruction, sources whose title or text
 *    mention its words come first; otherwise the most recently added. So a
 *    100-source project sends the sources that matter to *this* task, not the
 *    first fifty by accident.
 * 3. **Budget.** Content is cut to `SNAPSHOT_LIMITS` (per source and in all)
 *    and the snapshot reader re-applies the same bounds. A source left out
 *    is still listed to the agent by title and address, and the agent is
 *    told its text was not loaded.
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

export function sessionSources(input: {
  tabs: readonly Tab[];
  selection?: SourceSelection | null;
  collections?: readonly Pick<Collection, "id" | "tabIds">[];
  contents: ReadonlyMap<string, ResourceContent>;
  instruction?: string;
}): SessionSource[] {
  const ready = selectedSources(input.tabs, input.selection, input.collections).filter((tab) => tab.resource?.status === "ready" && input.contents.has(tab.id));
  const out: SessionSource[] = [];
  let left: number = SNAPSHOT_LIMITS.sourceChars;
  for (const tab of rankSources(ready, input.contents, input.instruction)) {
    if (out.length >= SNAPSHOT_LIMITS.sources || left <= 0) break;
    const content = input.contents.get(tab.id)!;
    let each = Math.min(SNAPSHOT_LIMITS.sourceCharsEach, left);
    const start = each;
    const source: SessionSource = { tabId: tab.id, kind: content.kind };
    let cut = content.truncated === true;
    if (content.text) {
      source.text = content.text.slice(0, each);
      cut ||= source.text.length < content.text.length;
      each -= source.text.length;
    }
    if (content.pages) {
      const pages: string[] = [];
      for (const page of content.pages) {
        if (each <= 0) {
          cut = true;
          break;
        }
        const piece = page.slice(0, each);
        pages.push(piece);
        cut ||= piece.length < page.length;
        each -= piece.length;
      }
      source.pages = pages;
    }
    if (content.transcript) {
      const lines: { start?: number; text: string }[] = [];
      for (const line of content.transcript) {
        if (each <= 0) {
          cut = true;
          break;
        }
        const piece = line.text.slice(0, each);
        lines.push({ ...(line.start !== undefined ? { start: line.start } : {}), text: piece });
        each -= piece.length;
      }
      source.transcript = lines;
    }
    if (cut) source.truncated = true;
    left -= start - each;
    out.push(source);
  }
  return out;
}
