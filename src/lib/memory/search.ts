import { searchProject, searchTerms } from "@/lib/resources/search";
import { itemOfNote, itemOfSource } from "./items";
import type { KnowledgeItem, KnowledgeItemRef, KnowledgeItemType } from "./items";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ResourceContent } from "@/lib/resources/types";
import type { SearchLocation } from "@/lib/resources/search";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * Finding something saved earlier, in one project or across all of them —
 * whichever AI app it came from.
 *
 * Built on the project search (lib/resources/search.ts), run once per
 * project with only that project's items and content, then merged: the
 * isolation each project's search has is kept, and a hit always names the
 * project it belongs to. Nothing is embedded or sent anywhere; this is term
 * matching on this device.
 *
 * Results are one per item — its best match, and how many other places in it
 * matched — so a long conversation that mentions a word forty times is one
 * result, not forty.
 */

export type KnowledgeHit = {
  workspaceId: string;
  ref: KnowledgeItemRef;
  /** Absent for a saved tab that is not a source: it is found by its title, address and notes only. */
  item?: KnowledgeItem;
  tab?: Tab;
  location: SearchLocation;
  snippet: string;
  score: number;
  /** Other matching places in the same item. */
  more: number;
};

export type KnowledgeSearchInput = {
  query: string;
  workspaces: readonly Pick<Workspace, "id" | "tabs" | "notes">[];
  /** Content per project, by item id. A project missing here is searched by its titles alone. */
  contents: ReadonlyMap<string, ReadonlyMap<string, ResourceContent>>;
  /** Only this project. Absent: every project given. */
  workspaceId?: string;
  /** Only items from these AI apps. */
  providers?: readonly AiProviderId[];
  /** Only these kinds of item. */
  types?: readonly KnowledgeItemType[];
  limit?: number;
};

const DEFAULT_LIMIT = 40;

export function searchKnowledge(input: KnowledgeSearchInput): KnowledgeHit[] {
  if (searchTerms(input.query).length === 0) return [];
  const best = new Map<string, KnowledgeHit>();
  const providers = input.providers && input.providers.length > 0 ? new Set(input.providers) : undefined;
  const types = input.types && input.types.length > 0 ? new Set(input.types) : undefined;

  for (const workspace of input.workspaces) {
    if (input.workspaceId && workspace.id !== input.workspaceId) continue;
    const contents = input.contents.get(workspace.id) ?? new Map<string, ResourceContent>();
    const tabsById = new Map(workspace.tabs.map((tab) => [tab.id, tab]));
    const notesById = new Map((workspace.notes ?? []).map((note) => [note.id, note]));
    const hits = searchProject({ query: input.query, tabs: workspace.tabs, contents, notes: workspace.notes ?? [], limit: 200 });

    for (const hit of hits) {
      let ref: KnowledgeItemRef;
      let item: KnowledgeItem | undefined;
      let tab: Tab | undefined;
      if (hit.type === "note") {
        const note = notesById.get(hit.noteId);
        if (!note) continue;
        ref = { kind: "note", noteId: note.id };
        item = itemOfNote(workspace.id, note);
      } else {
        tab = tabsById.get(hit.tabId);
        if (!tab) continue;
        ref = { kind: "source", tabId: tab.id };
        item = itemOfSource(workspace.id, tab);
      }
      if (providers && (!item?.provider || !providers.has(item.provider))) continue;
      if (types && !types.has(item?.type ?? "link")) continue;
      const key = `${workspace.id}|${ref.kind === "note" ? ref.noteId : ref.tabId}`;
      const current = best.get(key);
      if (!current) {
        best.set(key, { workspaceId: workspace.id, ref, ...(item ? { item } : {}), ...(tab && !item ? { tab } : {}), location: hit.location, snippet: hit.snippet, score: hit.score, more: 0 });
      } else if (hit.score > current.score) {
        best.set(key, { ...current, location: hit.location, snippet: hit.snippet, score: hit.score, more: current.more + 1 });
      } else {
        current.more += 1;
      }
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score || (b.item?.updatedAt ?? 0) - (a.item?.updatedAt ?? 0)).slice(0, input.limit ?? DEFAULT_LIMIT);
}
