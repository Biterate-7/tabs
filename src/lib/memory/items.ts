import { providerOfUrl } from "@/lib/providers/registry";
import type { AiProviderId } from "@/lib/providers/registry";
import type { NoteFile, NoteKind, NoteOrigin, ProjectNote } from "@/lib/notes/notes";
import type { ConversationCaptureMethod, ResourceKind, ResourceOrigin, ResourceStatus } from "@/lib/resources/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * One project's knowledge, as one list — what the Knowledge Centre shows,
 * what search returns, and what a person picks from to reuse context.
 *
 * Not a third model: a view over the two records that already hold it — a
 * source (a \`Tab\` with a \`resource\`, for anything with an address) and a
 * project note (lib/notes, for anything without). \`ref\` says which, and
 * every action goes back to that record.
 *
 * Provenance travels with every item and is never filled in: an item with no
 * provider has none, a link Hubble could not read says \`hasText: false\`.
 */

export type KnowledgeItemType = "conversation" | "webpage" | "pdf" | "video" | "document" | "link" | "note" | "excerpt";

export type KnowledgeItemRef = { kind: "source"; tabId: string } | { kind: "note"; noteId: string };

export type KnowledgeItem = {
  ref: KnowledgeItemRef;
  /** The record's id: a tab id or a note id. */
  id: string;
  workspaceId: string;
  type: KnowledgeItemType;
  title: string;
  /** The original address — a source's own, or where an excerpt came from. */
  url?: string;
  domain?: string;
  /** The AI app it came from, when it came from one. */
  provider?: AiProviderId;
  /** When it entered this project. */
  addedAt: number;
  updatedAt: number;
  /** Whether Hubble holds its text (and so can search and quote it). */
  hasText: boolean;
  status: ResourceStatus;
  origin: ResourceOrigin | NoteOrigin;
  /** How a conversation's text arrived. */
  capture?: ConversationCaptureMethod;
  turns?: number;
  chars?: number;
  tags?: readonly string[];
  /** The person's own note on a saved page. */
  userNote?: string;
  /** Why there is no text, in Hubble's words. */
  problem?: string;
  /** An uploaded file's own name (its item has no address). */
  fileName?: string;
  /** An uploaded file's PDF page count. */
  pages?: number;
};

export const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeItemType, string> = {
  conversation: "AI conversation",
  webpage: "Web page",
  pdf: "PDF",
  video: "Video",
  document: "Document",
  link: "Link",
  note: "Note",
  excerpt: "Excerpt",
};

/** A project note's kind in words. */
export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  note: "Note",
  excerpt: "Excerpt",
  conversation: "AI conversation",
  file: "File",
};

function typeOfKind(kind: ResourceKind): KnowledgeItemType {
  if (kind === "youtube" || kind === "video") return "video";
  if (kind === "unknown") return "link";
  return kind;
}

export function itemOfSource(workspaceId: string, tab: Tab): KnowledgeItem | undefined {
  const resource = tab.resource;
  if (!resource) return undefined;
  const provider = resource.meta?.provider ?? (resource.kind === "conversation" ? providerOfUrl(tab.url) : undefined);
  return {
    ref: { kind: "source", tabId: tab.id },
    id: tab.id,
    workspaceId,
    type: typeOfKind(resource.kind),
    title: tab.title?.trim() || tab.domain,
    url: tab.url,
    domain: tab.domain,
    ...(provider ? { provider } : {}),
    addedAt: resource.addedAt,
    updatedAt: resource.updatedAt,
    hasText: resource.status === "ready" && (resource.content?.chars ?? 0) > 0,
    status: resource.status,
    origin: resource.origin,
    ...(resource.meta?.capture ? { capture: resource.meta.capture } : {}),
    ...(resource.content?.turns ? { turns: resource.content.turns } : {}),
    ...(resource.content ? { chars: resource.content.chars } : {}),
    ...(tab.notes ? { userNote: tab.notes } : {}),
    ...(resource.status !== "ready" && resource.error ? { problem: resource.error.message } : {}),
  };
}

/**
 * A saved tab that is not a source (from a tab dump or an import): known by
 * its title, address and the person's note only — Hubble holds no text for
 * it, and says so. It can still be named and linked in reused context.
 */
export function itemOfSavedTab(workspaceId: string, tab: Tab): KnowledgeItem {
  return {
    ref: { kind: "source", tabId: tab.id },
    id: tab.id,
    workspaceId,
    type: "link",
    title: tab.title?.trim() || tab.domain,
    url: tab.url,
    domain: tab.domain,
    addedAt: tab.createdAt ?? 0,
    updatedAt: tab.updatedAt ?? tab.createdAt ?? 0,
    hasText: false,
    status: "partial",
    origin: "import",
    ...(tab.notes ? { userNote: tab.notes } : {}),
  };
}

/** An uploaded file: a PDF or a document, read like a source and listed with them. */
function itemOfFile(workspaceId: string, note: ProjectNote, file: NoteFile): KnowledgeItem {
  return {
    ref: { kind: "note", noteId: note.id },
    id: note.id,
    workspaceId,
    type: file.format === "pdf" ? "pdf" : "document",
    title: note.title,
    addedAt: note.createdAt,
    updatedAt: note.updatedAt,
    hasText: file.status === "ready" && note.chars > 0,
    // A file being read is "processing", as a source is: the same counts and words everywhere.
    status: file.status,
    origin: "upload",
    chars: note.chars,
    fileName: file.name,
    ...(file.pages ? { pages: file.pages } : {}),
    ...(note.tags ? { tags: note.tags } : {}),
    ...(file.status !== "ready" && file.error ? { problem: file.error.message } : {}),
  };
}

export function itemOfNote(workspaceId: string, note: ProjectNote): KnowledgeItem {
  if (note.kind === "file" && note.file) return itemOfFile(workspaceId, note, note.file);
  let domain: string | undefined;
  if (note.sourceUrl) {
    try {
      domain = new URL(note.sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      domain = undefined;
    }
  }
  return {
    ref: { kind: "note", noteId: note.id },
    id: note.id,
    workspaceId,
    type: note.kind === "conversation" ? "conversation" : note.kind === "excerpt" ? "excerpt" : "note",
    title: note.title,
    ...(note.sourceUrl ? { url: note.sourceUrl } : {}),
    ...(domain ? { domain } : {}),
    ...(note.provider ? { provider: note.provider } : {}),
    addedAt: note.createdAt,
    updatedAt: note.updatedAt,
    hasText: note.chars > 0,
    status: "ready",
    origin: note.origin,
    ...(note.kind === "conversation" ? { capture: note.origin === "import" ? "export" : note.origin === "capture" ? "page" : "paste" } : {}),
    ...(note.turns ? { turns: note.turns } : {}),
    chars: note.chars,
    ...(note.tags ? { tags: note.tags } : {}),
  };
}

/** Every item of one project, newest first — items added together keep the order they were added in. Saved tabs that are not sources stay in the project's tab view. */
export function knowledgeItemsOf(workspace: Pick<Workspace, "id" | "tabs" | "notes">): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  for (const tab of workspace.tabs) {
    const item = itemOfSource(workspace.id, tab);
    if (item) items.push(item);
  }
  for (const note of workspace.notes ?? []) items.push(itemOfNote(workspace.id, note));
  return items.sort((a, b) => b.addedAt - a.addedAt);
}

export function findKnowledgeItem(workspace: Pick<Workspace, "id" | "tabs" | "notes">, ref: KnowledgeItemRef): KnowledgeItem | undefined {
  if (ref.kind === "note") {
    const note = workspace.notes?.find((entry) => entry.id === ref.noteId);
    return note ? itemOfNote(workspace.id, note) : undefined;
  }
  const tab = workspace.tabs.find((entry) => entry.id === ref.tabId);
  return tab ? (itemOfSource(workspace.id, tab) ?? itemOfSavedTab(workspace.id, tab)) : undefined;
}

export function sameRef(a: KnowledgeItemRef, b: KnowledgeItemRef): boolean {
  return a.kind === b.kind && (a.kind === "note" ? a.noteId === (b as { noteId: string }).noteId : a.tabId === (b as { tabId: string }).tabId);
}

export function refKey(ref: KnowledgeItemRef): string {
  return ref.kind === "note" ? `n:${ref.noteId}` : `s:${ref.tabId}`;
}

/** Counts by kind of knowledge, for a project's header and empty states. */
export function knowledgeCounts(items: readonly KnowledgeItem[]) {
  const counts = { total: items.length, conversations: 0, sources: 0, notes: 0, withoutText: 0, providers: new Set<AiProviderId>() };
  for (const item of items) {
    if (item.type === "conversation") counts.conversations += 1;
    else if (item.type === "note" || item.type === "excerpt") counts.notes += 1;
    else counts.sources += 1;
    if (!item.hasText) counts.withoutText += 1;
    if (item.provider) counts.providers.add(item.provider);
  }
  return counts;
}
