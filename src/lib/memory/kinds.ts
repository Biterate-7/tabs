import type { KnowledgeItem } from "@/lib/memory/items";

/**
 * The four kinds of thing a project holds, as the interface groups them —
 * the graph's encodings, the Library's tabs, Home's lists and every glyph
 * draw from this one classification, so a thing is never a "file" in one
 * place and a "source" in another.
 *
 *   conversation  an AI conversation, saved from a page, an export or a paste
 *   source        anything with an address: a web page, a PDF link, a video
 *   file          something uploaded from this device (its item has no address)
 *   note          the person's own note, or an excerpt they kept
 *
 * Derived from the item, never stored.
 */
export type ItemKind = "conversation" | "source" | "file" | "note";

export const ITEM_KINDS: readonly ItemKind[] = ["conversation", "source", "file", "note"] as const;

export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  conversation: "AI conversation",
  source: "Source",
  file: "File",
  note: "Note",
};

export const ITEM_KIND_PLURAL: Record<ItemKind, string> = {
  conversation: "Conversations",
  source: "Sources",
  file: "Files",
  note: "Notes",
};

export function itemKind(item: Pick<KnowledgeItem, "type" | "fileName" | "ref">): ItemKind {
  if (item.type === "conversation") return "conversation";
  if (item.type === "note" || item.type === "excerpt") return "note";
  // An uploaded file is a project note with a file name; a PDF with an address is a source.
  if (item.ref.kind === "note" && item.fileName) return "file";
  return "source";
}

/**
 * When the person last did something with an item: added it, or — for a
 * note they edited — changed it. Anything with an address (a page, a
 * conversation) gets a newer `updatedAt` whenever Hubble re-reads it in the
 * background, which nobody did, so for those only the time it was added
 * counts. (A conversation saved again is recorded as its own project event.)
 */
export function itemActivityAt(item: Pick<KnowledgeItem, "ref" | "addedAt" | "updatedAt">): number {
  return item.ref.kind === "note" ? Math.max(item.addedAt, item.updatedAt) : item.addedAt;
}
