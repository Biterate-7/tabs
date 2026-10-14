import { boundContent, summarizeContent } from "@/lib/resources/content-store";
import { contentHash } from "@/lib/conversations/hash";
import { cleanBody, cleanLine, titleFromText } from "@/lib/conversations/clean";
import { isSafeOpenUrl } from "@/lib/browser/protocol";
import { cleanTags, findNoteByHash, NOTE_LIMITS } from "./notes";
import type { NoteKind, NoteOrigin, ProjectNote } from "./notes";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ResourceContent } from "@/lib/resources/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * A note or excerpt as the person wrote or pasted it, ready to save: the
 * record for the project, and the body for the content store.
 *
 * Refused with a reason when there is nothing to keep, and recognised (not
 * duplicated) when the same text is already a note in this project.
 */

export type NoteDraft = {
  kind: Exclude<NoteKind, "conversation">;
  title?: string;
  text: string;
  provider?: AiProviderId;
  sourceUrl?: string;
  origin: NoteOrigin;
  tags?: readonly string[];
};

export type ComposedNote =
  | { ok: true; duplicate: false; note: ProjectNote; content: ResourceContent }
  | { ok: true; duplicate: true; note: ProjectNote }
  | { ok: false; reason: "empty" | "too-long" };

export function composeNote(workspace: Pick<Workspace, "notes">, draft: NoteDraft, now: number, newId: () => string): ComposedNote {
  if (typeof draft.text === "string" && draft.text.length > NOTE_LIMITS.bodyChars) return { ok: false, reason: "too-long" };
  const text = cleanBody(draft.text, NOTE_LIMITS.bodyChars);
  if (!text) return { ok: false, reason: "empty" };
  const hash = contentHash({ text });
  const duplicate = findNoteByHash(workspace, hash);
  if (duplicate) return { ok: true, duplicate: true, note: duplicate };
  const content = boundContent({ kind: "note", text, extractedAt: now });
  const tags = cleanTags(draft.tags ?? []);
  const note: ProjectNote = {
    id: newId(),
    kind: draft.kind,
    title: cleanLine(draft.title ?? "") || titleFromText(text, draft.kind === "excerpt" ? "Excerpt" : "Note"),
    origin: draft.origin,
    createdAt: now,
    updatedAt: now,
    contentHash: hash,
    chars: summarizeContent(content).chars,
    ...(draft.provider ? { provider: draft.provider } : {}),
    ...(draft.sourceUrl && isSafeOpenUrl(draft.sourceUrl) ? { sourceUrl: draft.sourceUrl } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
  return { ok: true, duplicate: false, note, content };
}
