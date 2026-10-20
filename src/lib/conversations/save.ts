import { boundContent, summarizeContent } from "@/lib/resources/content-store";
import { sourceKey } from "@/lib/resources/url";
import { buildTabsFromBrowserImport } from "@/lib/tabs/browser-import";
import { markDuplicates } from "@/lib/tabs/duplicates";
import { addProjectNote, findNoteByHash } from "@/lib/notes/notes";
import { contentHash } from "./hash";
import type { ConversationInput } from "./types";
import type { ProjectNote } from "@/lib/notes/notes";
import type { ResourceContent, ResourceOrigin, TabResource } from "@/lib/resources/types";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

/**
 * The one way an AI conversation is saved into a project — from the open
 * page, an export file or a paste.
 *
 * ## Where it goes
 *
 *   with its address     a source: a \`Tab\` whose \`resource\` is a
 *                        \`conversation\`, keyed by that address like every
 *                        other source in the project
 *   without one          a project note of kind \`conversation\` (lib/notes)
 *
 * ## Saving the same conversation again
 *
 *   unchanged   same address and the same text (by fingerprint): nothing is
 *               written, and the person is told it was already saved
 *   kept        same address, but this capture has fewer turns than the
 *               saved copy — a long thread the page had not fully loaded, or
 *               part of it pasted. The longer saved copy is never replaced
 *               by a shorter one; nothing is written, and the person is told
 *   updated     same address, different text — it grew, or was edited: the
 *               saved copy is replaced in place, keeping the item's id, its
 *               title (which the person may have renamed), notes,
 *               collections and graph links
 *   added       new to this project
 *
 * "The same conversation" is the same provider and conversation id
 * (`sourceKey`, from lib/providers/registry's `conversationKeyOf`) — never
 * the same provider, site or title. Two chats from ChatGPT are two items;
 * one chat reached at chat.openai.com and chatgpt.com, or with `?model=…`,
 * is one.
 *
 * Projects are separate: the same conversation saved into two projects is
 * two items, each only in its own project.
 *
 * Planning is pure. The caller writes \`content\` to the content store first
 * and applies the plan only once that has succeeded — so a project never
 * claims a conversation whose text it could not keep.
 */

export type ConversationSave =
  | {
      target: "source";
      outcome: "added" | "updated" | "unchanged" | "kept";
      workspaceId: string;
      /** The item: the tab id, existing or new. */
      id: string;
      tab: Tab;
      content: ResourceContent;
    }
  | {
      target: "note";
      outcome: "added" | "unchanged";
      workspaceId: string;
      id: string;
      note: ProjectNote;
      content: ResourceContent;
    };

const ORIGIN_OF_METHOD: Record<ConversationInput["method"], ResourceOrigin> = {
  page: "extension",
  export: "import",
  paste: "manual",
};

function contentOf(input: ConversationInput, kind: ResourceContent["kind"], now: number): ResourceContent {
  return boundContent({
    kind,
    ...(input.turns.length > 0 ? { turns: input.turns } : {}),
    ...(input.turns.length === 0 && input.text ? { text: input.text } : {}),
    extractedAt: now,
  });
}

function resourceFor(input: ConversationInput, content: ResourceContent, hash: string, now: number, previous?: TabResource): TabResource {
  return {
    kind: "conversation",
    origin: previous?.origin ?? ORIGIN_OF_METHOD[input.method],
    status: "ready",
    addedAt: previous?.addedAt ?? now,
    updatedAt: now,
    meta: {
      provider: input.provider,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      turnCount: content.turns?.length ?? 0,
      contentHash: hash,
      capture: input.method,
      ...(input.createdAt !== undefined ? { conversationCreatedAt: input.createdAt } : {}),
      ...(input.updatedAt !== undefined ? { conversationUpdatedAt: input.updatedAt } : {}),
    },
    content: summarizeContent(content),
  };
}

export function planConversationSave(
  store: WorkspaceStore,
  workspaceId: string,
  input: ConversationInput,
  now: number,
  newId: () => string
): ConversationSave | undefined {
  const workspace = store.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return undefined;
  const hash = contentHash(input);

  const key = input.url ? sourceKey(input.url) : undefined;
  if (input.url && key) {
    const content = contentOf(input, "conversation", now);
    // A saved source wins over a plain tab with the same address, as in every ingestion.
    const matches = workspace.tabs.filter((tab) => sourceKey(tab.url) === key);
    const existing = matches.find((tab) => tab.resource) ?? matches[0];
    if (existing) {
      if (existing.resource?.kind === "conversation" && existing.resource.status === "ready" && existing.resource.meta?.contentHash === hash) {
        return { target: "source", outcome: "unchanged", workspaceId, id: existing.id, tab: existing, content };
      }
      const savedTurns = existing.resource?.kind === "conversation" && existing.resource.status === "ready" ? (existing.resource.meta?.turnCount ?? 0) : 0;
      if (input.turns.length > 0 && input.turns.length < savedTurns) {
        return { target: "source", outcome: "kept", workspaceId, id: existing.id, tab: existing, content };
      }
      const tab: Tab = {
        ...existing,
        // A title the person gave it stays; a tab that only showed its address gets the conversation's.
        title: existing.title?.trim() && existing.title !== existing.url && existing.title !== existing.domain ? existing.title : input.title,
        resource: resourceFor(input, content, hash, now, existing.resource),
        updatedAt: now,
      };
      return { target: "source", outcome: existing.resource ? "updated" : "added", workspaceId, id: existing.id, tab, content };
    }
    const [built] = buildTabsFromBrowserImport([{ url: input.url, title: input.title }]);
    if (built) {
      const tab: Tab = { ...built, resource: resourceFor(input, content, hash, now) };
      return { target: "source", outcome: "added", workspaceId, id: tab.id, tab, content };
    }
  }

  const content = contentOf(input, "note", now);
  const duplicate = findNoteByHash(workspace, hash);
  if (duplicate) return { target: "note", outcome: "unchanged", workspaceId, id: duplicate.id, note: duplicate, content };
  const id = newId();
  const chars = summarizeContent(content).chars;
  const note: ProjectNote = {
    id,
    kind: "conversation",
    title: input.title,
    provider: input.provider,
    origin: input.method === "page" ? "capture" : input.method === "export" ? "import" : "paste",
    createdAt: now,
    updatedAt: now,
    contentHash: hash,
    chars,
    ...(content.turns && content.turns.length > 0 ? { turns: content.turns.length } : {}),
  };
  return { target: "note", outcome: "added", workspaceId, id, note, content };
}

/**
 * The store with a planned save applied, against the store as it is now. An
 * unchanged save, or one whose project has gone, changes nothing — and so
 * does a new item for a conversation that another save added to the project
 * while this one was writing its text (two clicks, or Chrome and Hubble
 * Desktop at once): the project keeps one copy, never two.
 */
export function applyConversationSave(store: WorkspaceStore, plan: ConversationSave, now: number): WorkspaceStore {
  if (plan.outcome === "unchanged" || plan.outcome === "kept") return store;
  if (plan.target === "note") return addProjectNote(store, plan.workspaceId, plan.note, now);
  let changed = false;
  const key = sourceKey(plan.tab.url);
  const workspaces = store.workspaces.map((workspace) => {
    if (workspace.id !== plan.workspaceId) return workspace;
    const present = workspace.tabs.some((tab) => tab.id === plan.id);
    if (!present && key && workspace.tabs.some((tab) => tab.resource?.kind === "conversation" && sourceKey(tab.url) === key)) return workspace;
    changed = true;
    const tabs = present ? workspace.tabs.map((tab) => (tab.id === plan.id ? plan.tab : tab)) : [...workspace.tabs, plan.tab];
    return { ...workspace, tabs: markDuplicates(tabs), updatedAt: now };
  });
  return changed ? { ...store, workspaces } : store;
}
