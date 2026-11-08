import { contentHash } from "@/lib/conversations/hash";
import { knowledgeItemsOf, refKey } from "@/lib/memory/items";
import { conversationRefOf } from "@/lib/providers/registry";
import { sourceKey } from "@/lib/resources/url";
import type { KnowledgeItem } from "@/lib/memory/items";
import type { ConversationTurn, ResourceContent } from "@/lib/resources/types";
import type { Workspace } from "@/lib/workspace/types";
import type { ConversationMessage, ConversationRecord, MessageContentType } from "./types";

/**
 * Every saved AI conversation, in one canonical shape — built from the
 * records Hubble already keeps, never stored a second time.
 *
 *   a conversation with an address   Tab.resource (kind "conversation") + its turns
 *   one saved without                ProjectNote (kind "conversation") + its turns or text
 *
 * The same conversation saved into two projects is two records with one
 * `identity`; the index treats them as one conversation, never as two that
 * happen to agree.
 */

export type ProjectContentMap = ReadonlyMap<string, ReadonlyMap<string, ResourceContent>>;

const FENCE = /^\s*(```|~~~)\s*([A-Za-z0-9_+#.-]*)/;
const UNAVAILABLE: { pattern: RegExp; label: string }[] = [
  { pattern: /\[(?:image|picture|photo|screenshot)[^\]]*\]|!\[[^\]]*\]\([^)]*\)/i, label: "image" },
  { pattern: /\[(?:file|attachment|uploaded file|document)[^\]]*\]/i, label: "attachment" },
  { pattern: /\[(?:chart|graph|canvas|artifact)[^\]]*\]/i, label: "generated content" },
];

/** What a message is made of, read from its text: code fences, formulas, tables, lists, links. */
export function messageShape(text: string): Pick<ConversationMessage, "contentTypes" | "codeLanguages" | "unavailable"> {
  const types = new Set<MessageContentType>();
  const languages = new Set<string>();
  let inFence = false;
  let prose = false;
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line);
    if (fence) {
      if (!inFence) {
        types.add("code");
        if (fence[2]) languages.add(fence[2].toLowerCase());
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) types.add("table");
    else if (/^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)) types.add("list");
    else if (line.trim()) prose = true;
    if (/\$\$[^$]+\$\$|(?<![\\$\w])\$[^$\n]{2,}\$(?!\w)|\\\(|\\\[/.test(line)) types.add("math");
    if (/https?:\/\/\S+/.test(line)) types.add("link");
  }
  if (prose || types.size === 0) types.add("text");
  const unavailable = UNAVAILABLE.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label);
  return {
    contentTypes: [...types].sort(),
    ...(languages.size > 0 ? { codeLanguages: [...languages].sort() } : {}),
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
}

export function messagesOf(recordId: string, turns: readonly ConversationTurn[]): ConversationMessage[] {
  return turns.map((turn, index) => ({
    id: `${recordId}#${index}`,
    index,
    role: turn.role,
    text: turn.text,
    ...(turn.at !== undefined ? { at: turn.at } : {}),
    hash: contentHash({ text: turn.text }),
    ...messageShape(turn.text),
  }));
}

function recordOf(workspace: Pick<Workspace, "id" | "tabs" | "notes">, item: KnowledgeItem, content: ResourceContent | undefined): ConversationRecord {
  const id = `${workspace.id}:${refKey(item.ref)}`;
  const tab = item.ref.kind === "source" ? workspace.tabs.find((entry) => entry.id === (item.ref as { tabId: string }).tabId) : undefined;
  const note = item.ref.kind === "note" ? workspace.notes?.find((entry) => entry.id === (item.ref as { noteId: string }).noteId) : undefined;
  const meta = tab?.resource?.meta;
  const hash = meta?.contentHash ?? note?.contentHash;
  const identity = (item.url ? sourceKey(item.url) : undefined) ?? `note:${hash ?? id}`;
  const turns = content?.turns ?? [];
  const text = turns.length === 0 ? content?.text : undefined;
  const ingestion = item.hasText ? "ready" : item.status === "failed" ? "unreadable" : "needs-text";
  const externalId = meta?.conversationId ?? (item.url ? conversationRefOf(item.url)?.conversationId : undefined);
  return {
    id,
    identity,
    workspaceId: workspace.id,
    ref: item.ref,
    ...(item.provider ? { provider: item.provider } : {}),
    ...(externalId ? { externalId } : {}),
    title: item.title,
    ...(item.url ? { url: item.url } : {}),
    createdAt: meta?.conversationCreatedAt ?? item.addedAt,
    updatedAt: Math.max(meta?.conversationUpdatedAt ?? 0, item.updatedAt),
    syncedAt: item.updatedAt,
    ingestion,
    ...(item.problem ? { problem: item.problem } : {}),
    ...(hash ? { contentHash: hash } : {}),
    ...(item.capture ? { capture: item.capture } : {}),
    messages: messagesOf(id, turns),
    ...(text ? { text } : {}),
    ...(content?.truncated ? { truncated: true } : {}),
  };
}

/**
 * The conversations of the given projects. A project whose content has not
 * loaded yet still lists its conversations — with no messages — so a count
 * never jumps, and `ingestion` says whether text is expected.
 */
export function conversationRecordsOf(workspaces: readonly Pick<Workspace, "id" | "tabs" | "notes">[], contents: ProjectContentMap): ConversationRecord[] {
  const records: ConversationRecord[] = [];
  for (const workspace of workspaces) {
    const projectContents = contents.get(workspace.id);
    for (const item of knowledgeItemsOf(workspace)) {
      if (item.type !== "conversation") continue;
      records.push(recordOf(workspace, item, projectContents?.get(item.id)));
    }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
}

const fingerprints = new WeakMap<ConversationRecord, string>();

/**
 * What an analysis of this record was made from: its title and every
 * message's role and text (by hash). Two records with the same fingerprint
 * give the same extraction, so a cached one is reused only on a match —
 * never on the stored summary's word that nothing changed.
 */
export function recordFingerprint(record: Pick<ConversationRecord, "title" | "messages" | "text">): string {
  const known = fingerprints.get(record as ConversationRecord);
  if (known) return known;
  const parts = [record.title, ...record.messages.map((message) => `${message.role}:${message.hash}`)];
  if (record.text) parts.push(`text:${contentHash({ text: record.text })}`);
  const value = contentHash({ text: parts.join("") });
  fingerprints.set(record as ConversationRecord, value);
  return value;
}

/** The record's key in the device's stores: the same `<account>|<project>|<item>` the content store uses. */
export function storageItemId(record: Pick<ConversationRecord, "ref">): string {
  return record.ref.kind === "source" ? record.ref.tabId : record.ref.noteId;
}

export type MessageChange = { appended: number; edited: number[]; removed: number };

/**
 * What changed between two saves of one conversation, by message hash:
 * messages added at the end, messages whose text changed in place, and
 * messages that are gone. Order is the page's order; nothing is reordered.
 */
export function diffMessages(before: readonly Pick<ConversationMessage, "hash">[], after: readonly Pick<ConversationMessage, "hash">[]): MessageChange {
  const shared = Math.min(before.length, after.length);
  const edited: number[] = [];
  for (let index = 0; index < shared; index++) if (before[index]!.hash !== after[index]!.hash) edited.push(index);
  return { appended: Math.max(0, after.length - before.length), edited, removed: Math.max(0, before.length - after.length) };
}
