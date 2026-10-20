import { conversationKeyOf } from "@/lib/providers/registry";
import { sourceKey } from "@/lib/resources/url";
import type { WorkspaceStore } from "@/lib/workspace/types";

/** One project that already holds a conversation. */
export type SavedConversationPlace = {
  workspaceId: string;
  /** The item's id in that project. */
  tabId: string;
  /** The item's title there — the person may have renamed it. */
  title: string;
  /** Its text is saved (a capture), rather than only its address (added as a tab). */
  hasText: boolean;
};

export const SAVED_LOOKUP_LIMIT = 20;

/**
 * Where the one conversation `url` names is already saved: every project
 * holding a source for that conversation — the same provider and
 * conversation id (`sourceKey`), the rule a save itself uses — newest first.
 *
 * `undefined` when the address names no conversation (an app's home page, a
 * new chat with no id yet): there is nothing to look up, and nothing about
 * the app as a whole is ever answered. An empty list means this conversation
 * is in no project, whatever else from the same app is.
 */
export function findSavedConversation(store: Pick<WorkspaceStore, "workspaces">, url: string): SavedConversationPlace[] | undefined {
  if (!conversationKeyOf(url)) return undefined;
  const key = sourceKey(url);
  const found: { place: SavedConversationPlace; at: number }[] = [];
  for (const workspace of store.workspaces) {
    const tab = workspace.tabs.find((entry) => entry.resource?.kind === "conversation" && sourceKey(entry.url) === key);
    if (!tab?.resource) continue;
    found.push({
      place: { workspaceId: workspace.id, tabId: tab.id, title: (tab.title?.trim() || tab.url).slice(0, 200), hasText: tab.resource.status === "ready" },
      at: tab.resource.updatedAt,
    });
  }
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, SAVED_LOOKUP_LIMIT)
    .map((entry) => entry.place);
}
