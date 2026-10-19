import { extractFile } from "./extract";
import { cleanFileName, titleFromFileName } from "./formats";
import type { FileFormat } from "./formats";
import type { NoteFile, ProjectNote } from "@/lib/notes/notes";
import type { ResourceContent, ResourceContentSummary, ResourceError } from "@/lib/resources/types";

/**
 * An uploaded file as project knowledge: a project note of kind "file"
 * (lib/notes) whose body is the text Hubble read from it.
 *
 *     choose files ─► check ─► keep the original ─► add the note (Reading…)
 *                                    │                     │
 *                                    └── read it here ─────┴─► Ready · 12 pages
 *                                                              Saved · no text (a scan)
 *                                                              Couldn't read · why
 *
 * The original is written before the note exists, and the text before the
 * note says "ready" — so a project never lists a file it can't open, or
 * claims text it does not hold. A reading interrupted by a reload is picked
 * up again from the kept original (a bounded number of times).
 *
 * Pure apart from the injected store: tested without IndexedDB.
 */

/** Readings started automatically before a file is said to have failed. */
export const MAX_FILE_READS = 3;

export const FILE_NOTE_ERRORS = {
  missing: { code: "interrupted", message: "The original file isn't on this device any more. Upload it again.", retryable: false },
  interrupted: { code: "interrupted", message: "Reading was interrupted several times. Try again.", retryable: true },
  storage: { code: "interrupted", message: "Hubble read this file but couldn't save its text on this device. Try again.", retryable: true },
} as const satisfies Record<string, ResourceError>;

export function composeFileNote(input: { id: string; name: string; format: FileFormat; size: number; hash: string; now: number }): ProjectNote {
  return {
    id: input.id,
    kind: "file",
    title: titleFromFileName(input.name),
    origin: "upload",
    createdAt: input.now,
    updatedAt: input.now,
    contentHash: input.hash,
    chars: 0,
    file: { name: cleanFileName(input.name), format: input.format, size: input.size, status: "processing", attempts: 1 },
  };
}

/** The claim that Hubble is reading a file now — counted when it starts, so a file that crashes the page runs out of attempts. */
export function startFileRead(file: NoteFile): NoteFile {
  const next: NoteFile = { ...file, status: "processing", attempts: (file.attempts ?? 0) + 1 };
  delete next.error;
  return next;
}

/** A file read once more, from the start of its attempts: what "Read again" does. */
export function restartFileRead(file: NoteFile): NoteFile {
  return startFileRead({ ...file, attempts: 0 });
}

export function failFileRead(file: NoteFile, error: ResourceError): NoteFile {
  return { ...file, status: "failed", error };
}

/** Whether a file is waiting to be read (a reading that a reload cut short). */
export function fileNeedsRead(note: ProjectNote): boolean {
  return note.kind === "file" && note.file?.status === "processing";
}

/** Whether "Read again" could change anything. */
export function canRereadFile(file: NoteFile | undefined): boolean {
  return file?.status === "failed" && file.error?.retryable === true;
}

export type FileReadDeps = {
  putContent: (workspaceId: string, itemId: string, content: ResourceContent) => Promise<ResourceContentSummary>;
  now: () => number;
};

/** What a finished reading changes on the note. */
export type FileReadResult = { file: NoteFile; chars: number };

/** Reads a file's bytes and stores its text, then says what the note should claim. Content first, then the claim. */
export async function readFileNote(workspaceId: string, note: ProjectNote, bytes: Uint8Array, deps: FileReadDeps): Promise<FileReadResult> {
  const file = note.file!;
  const base: NoteFile = { ...file };
  delete base.error;
  delete base.truncated;
  const result = await extractFile(bytes, file.format, deps.now());
  if (result.status === "ready") {
    let summary: ResourceContentSummary;
    try {
      summary = await deps.putContent(workspaceId, note.id, result.content);
    } catch {
      return { file: failFileRead(base, FILE_NOTE_ERRORS.storage), chars: 0 };
    }
    return {
      file: { ...base, status: "ready", ...(result.pageCount ? { pages: result.pageCount } : {}), ...(summary.truncated ? { truncated: true } : {}) },
      chars: summary.chars,
    };
  }
  return {
    file: { ...base, status: result.status, error: result.error, ...(result.status === "partial" && result.pageCount ? { pages: result.pageCount } : {}) },
    chars: 0,
  };
}
