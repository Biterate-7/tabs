import type { ClaudeTranscriptCursor } from "./types";

/**
 * The opaque continuation token the browser carries between polls.
 *
 * The client's entire vocabulary for "where was I" is this one string. It
 * says *continue from here*, never *read this file*: there is no path in it,
 * and there is no code path that would accept one. The server re-derives
 * every filesystem location from a session id it has itself validated as a
 * UUID, so a tampered cursor cannot name a file — the worst a forged one can
 * do is ask for a wrong offset within a transcript the server already chose
 * to expose.
 *
 * It is encoded rather than encrypted. Encryption would imply the contents
 * are secret; they are not, they are just not the client's business to
 * construct. What matters is that they are re-validated on the way in, which
 * `decodeCursor` does unconditionally.
 */

const CURSOR_VERSION = 1;

/** Claude Code session ids are UUIDs. Anything else is refused before it can reach a path join. */
const SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Ceiling on how many sessions a cursor may track, so a forged one cannot fan out work. */
const MAX_CURSOR_ENTRIES = 64;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export type CursorState = ClaudeTranscriptCursor[];

export function encodeCursor(entries: CursorState): string {
  const payload = {
    v: CURSOR_VERSION,
    e: entries.slice(0, MAX_CURSOR_ENTRIES).map((entry) => ({
      s: entry.sessionId,
      o: entry.offset,
      z: entry.size,
      // Added after v1 shipped, and additive on purpose: a cursor written
      // before this field existed decodes with the ordinal defaulting to 0,
      // so an in-flight client is not forced to restart its whole sweep just
      // because work items arrived.
      t: entry.taskOrdinal,
    })),
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes a client-supplied cursor, discarding anything that fails validation.
 *
 * Never throws and never partially trusts: an entry with a non-UUID session
 * id, a negative offset or a non-finite size is dropped individually, so one
 * bad entry costs that session its position rather than costing the whole
 * poll its continuity. A cursor from a different version is ignored
 * wholesale, which degrades to "start fresh" rather than misreading offsets
 * against a layout that has changed.
 */
export function decodeCursor(value: unknown): CursorState {
  if (typeof value !== "string" || !value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") return [];
  const payload = parsed as Record<string, unknown>;
  if (payload.v !== CURSOR_VERSION) return [];
  if (!Array.isArray(payload.e)) return [];

  const entries: CursorState = [];
  for (const raw of payload.e.slice(0, MAX_CURSOR_ENTRIES)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;

    if (!isValidSessionId(entry.s)) continue;
    if (typeof entry.o !== "number" || !Number.isFinite(entry.o) || entry.o < 0) continue;
    if (typeof entry.z !== "number" || !Number.isFinite(entry.z) || entry.z < 0) continue;

    // An absent, negative or non-finite ordinal degrades to 0 rather than
    // dropping the entry: losing a session's read position over a bad counter
    // would cost far more than renumbering its tasks.
    const taskOrdinal =
      typeof entry.t === "number" && Number.isFinite(entry.t) && entry.t >= 0
        ? Math.floor(entry.t)
        : 0;

    entries.push({
      sessionId: entry.s,
      offset: Math.floor(entry.o),
      size: Math.floor(entry.z),
      taskOrdinal,
    });
  }

  return entries;
}

/**
 * Where to resume reading a transcript, given its current size.
 *
 * Handles the three things that can happen to an append-only file between
 * polls:
 *
 *  - **grown** — resume at the stored offset, which always sits immediately
 *    after a newline;
 *  - **unchanged** — resume at the stored offset and read nothing;
 *  - **shrunk or replaced** — the file is not the one the offset belongs to
 *    (rotation, deletion and recreation, a truncating write), so start over
 *    from the beginning rather than reading from a position that now means
 *    something else entirely.
 *
 * A session with no stored cursor starts near the END of its transcript
 * rather than at byte zero. Replaying a 17 MB backlog to announce work the
 * user watched happen hours ago would be slow and useless; observation
 * sensibly begins when TabDump starts observing. `initialTailBytes` gives
 * just enough recent history for a freshly attached session to show something.
 */
export function resolveReadStart(
  previous: ClaudeTranscriptCursor | undefined,
  currentSize: number,
  initialTailBytes: number
): { offset: number; reset: boolean; firstSight: boolean } {
  if (!previous) {
    const offset = Math.max(0, currentSize - initialTailBytes);
    return { offset, reset: false, firstSight: true };
  }

  if (currentSize < previous.offset) {
    return { offset: 0, reset: true, firstSight: false };
  }

  return { offset: previous.offset, reset: false, firstSight: false };
}
