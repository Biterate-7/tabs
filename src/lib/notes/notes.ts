import { isAiProviderId } from "@/lib/providers/registry";
import { isSafeOpenUrl } from "@/lib/browser/protocol";
import type { AiProviderId } from "@/lib/providers/registry";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

/**
 * Project notes: knowledge with no web address of its own.
 *
 * A saved page, PDF, video or AI conversation with an address is a source
 * (a `Tab` carrying a `resource` — lib/resources). Everything else a person
 * keeps in a project lives here:
 *
 *   note          something they wrote
 *   excerpt       a passage they kept from somewhere (a page, an AI answer)
 *   conversation  an AI conversation pasted or imported without its address
 *
 * ## What is stored where
 *
 * The record on the workspace is small — a title, where it came from, when,
 * a content fingerprint and a size. The body (text, or a conversation's
 * turns) lives in the same on-device content store as a source's text
 * (lib/resources/content-store.ts), keyed by the note's id, read only when
 * something needs it. A note is local to this device like a source's text:
 * account sync carries projects and their saved pages, not these.
 *
 * Every record is re-read field by field on load (`readProjectNotes`):
 * storage outlives the code that wrote it.
 */

export type NoteKind = "note" | "excerpt" | "conversation";

export const NOTE_KINDS: readonly NoteKind[] = ["note", "excerpt", "conversation"] as const;

/** How a note arrived: written in Hubble, pasted, from a file, or saved from a page by Hubble for Chrome. */
export type NoteOrigin = "manual" | "paste" | "import" | "capture";

export const NOTE_ORIGINS: readonly NoteOrigin[] = ["manual", "paste", "import", "capture"] as const;

export type ProjectNote = {
  id: string;
  kind: NoteKind;
  title: string;
  /** The AI app it came from — a pasted conversation, an excerpt of an AI answer. */
  provider?: AiProviderId;
  /** Where an excerpt was taken from, when that is known (http(s) only). */
  sourceUrl?: string;
  origin: NoteOrigin;
  createdAt: number;
  updatedAt: number;
  /** Over the body (lib/conversations/hash.ts): a second paste of the same text is recognised. */
  contentHash: string;
  /** Characters in the body. */
  chars: number;
  /** Turns, for a conversation that could be split into them. */
  turns?: number;
  /** The person's own words for finding it again. */
  tags?: string[];
};

export const NOTE_LIMITS = {
  notesPerProject: 2_000,
  title: 300,
  tags: 12,
  tag: 40,
  /** A note's body: long enough for a pasted conversation. */
  bodyChars: 2_000_000,
} as const;

const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_LIMITS.tag);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= NOTE_LIMITS.tags) break;
  }
  return out;
}

/** One stored note, re-read; `undefined` when it is not one. */
export function readProjectNote(raw: unknown): ProjectNote | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" && source.id.length > 0 && source.id.length <= 200 ? source.id : undefined;
  const kind = NOTE_KINDS.includes(source.kind as NoteKind) ? (source.kind as NoteKind) : undefined;
  const origin = NOTE_ORIGINS.includes(source.origin as NoteOrigin) ? (source.origin as NoteOrigin) : undefined;
  const title = typeof source.title === "string" ? source.title.trim().slice(0, NOTE_LIMITS.title) : "";
  const createdAt = time(source.createdAt);
  const contentHash = typeof source.contentHash === "string" && /^[0-9a-f]{16}$/.test(source.contentHash) ? source.contentHash : undefined;
  const chars = count(source.chars);
  if (!id || !kind || !origin || !title || createdAt === undefined || !contentHash || chars === undefined) return undefined;
  const note: ProjectNote = { id, kind, title, origin, createdAt, updatedAt: time(source.updatedAt) ?? createdAt, contentHash, chars };
  if (isAiProviderId(source.provider)) note.provider = source.provider;
  if (typeof source.sourceUrl === "string" && source.sourceUrl.length <= 4000 && isSafeOpenUrl(source.sourceUrl)) note.sourceUrl = source.sourceUrl;
  const turns = count(source.turns);
  if (turns !== undefined && turns > 0) note.turns = turns;
  const tags = cleanTags(source.tags);
  if (tags.length > 0) note.tags = tags;
  return note;
}

/** A workspace's notes, re-read: malformed ones dropped, duplicates by id kept once, bounded. */
export function readProjectNotes(raw: unknown): ProjectNote[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ProjectNote[] = [];
  for (const entry of raw) {
    const note = readProjectNote(entry);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    out.push(note);
    if (out.length >= NOTE_LIMITS.notesPerProject) break;
  }
  return out;
}

export function projectNotes(workspace: Pick<Workspace, "notes">): ProjectNote[] {
  return workspace.notes ?? [];
}

function withNotes(store: WorkspaceStore, workspaceId: string, update: (notes: ProjectNote[]) => ProjectNote[] | null, now: number): WorkspaceStore {
  let changed = false;
  const workspaces = store.workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    const next = update(workspace.notes ?? []);
    if (!next) return workspace;
    changed = true;
    const copy: Workspace = { ...workspace, updatedAt: now };
    if (next.length > 0) copy.notes = next;
    else delete copy.notes;
    return copy;
  });
  return changed ? { ...store, workspaces } : store;
}

/** The store with `note` added to a project (newest last). Unchanged when the project is gone or full. */
export function addProjectNote(store: WorkspaceStore, workspaceId: string, note: ProjectNote, now: number): WorkspaceStore {
  return withNotes(store, workspaceId, (notes) => (notes.length >= NOTE_LIMITS.notesPerProject || notes.some((entry) => entry.id === note.id) ? null : [...notes, note]), now);
}

/** The store with one note changed by `patch` — its title, tags, or a new body's fingerprint. */
export function updateProjectNote(
  store: WorkspaceStore,
  workspaceId: string,
  noteId: string,
  patch: Partial<Pick<ProjectNote, "title" | "tags" | "contentHash" | "chars" | "turns">>,
  now: number
): WorkspaceStore {
  return withNotes(
    store,
    workspaceId,
    (notes) => {
      if (!notes.some((note) => note.id === noteId)) return null;
      return notes.map((note) => (note.id === noteId ? { ...note, ...patch, updatedAt: now } : note));
    },
    now
  );
}

/** The store without these notes. Their bodies are forgotten by the caller (content follows its item). */
export function removeProjectNotes(store: WorkspaceStore, workspaceId: string, noteIds: readonly string[], now: number): WorkspaceStore {
  const ids = new Set(noteIds);
  return withNotes(store, workspaceId, (notes) => (notes.some((note) => ids.has(note.id)) ? notes.filter((note) => !ids.has(note.id)) : null), now);
}

/** A note with the same body already in the project — what a second paste of the same text finds. */
export function findNoteByHash(workspace: Pick<Workspace, "notes">, hash: string): ProjectNote | undefined {
  return (workspace.notes ?? []).find((note) => note.contentHash === hash);
}
