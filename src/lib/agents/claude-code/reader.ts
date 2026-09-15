import "server-only";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidSessionId, resolveReadStart } from "./cursor";
import { countCreatedTasks } from "./normalizer";
import { parseTranscriptLine } from "./parser";
import { CLAUDE_LIMITS, mapClaudeStatus } from "./types";
import type { CursorState } from "./cursor";
import type {
  ClaudeDiscoveredSession,
  ClaudeParsedRecord,
  ClaudeSessionRegistryEntry,
  ClaudeTranscriptCursor,
} from "./types";

/**
 * The only module in this feature that touches a filesystem, and the only one
 * that may.
 *
 * Everything it does is a read. There is no write path, no process, no shell,
 * no git, and — most importantly — no use of `messagingSocketPath`.
 *
 * ## Why messagingSocketPath is ignored
 *
 * Each live session's registry entry carries a named pipe
 * (`\\.\pipe\LOCAL\cc-msg-…`) that a peer can use to *talk to* the running
 * session. Reading it would turn TabDump from an observer into a controller:
 * anything that could reach TabDump's state could then drive a coding agent
 * with filesystem access on the user's machine. The field is dropped in
 * `toRegistryEntry` below and appears in no type in this directory, so no
 * later code can reach it by accident.
 *
 * ## Why no path comes from the client
 *
 * Session ids are validated as UUIDs before they are ever joined onto a
 * directory, and transcripts are located by scanning the known projects root
 * for `<sessionId>.jsonl`. The browser never names a file, and a forged
 * cursor cannot introduce one.
 */

/**
 * Where Claude Code keeps its state.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own override, honoured here so a
 * self-hosted TabDump running as a different user, or on a machine with a
 * relocated config, can still observe the right directory. Read per call
 * rather than captured at module load, so it is never baked in.
 */
function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".claude");
}

/** Whether a local Claude Code installation is visible at all. */
export async function isClaudeCodeAvailable(): Promise<boolean> {
  try {
    const stats = await stat(/*turbopackIgnore: true*/ join(claudeHome(), "projects"));
    return stats.isDirectory();
  } catch {
    // Absent on a hosted deployment, and absent on a machine that has never
    // run Claude Code. Both are ordinary states, not errors.
    return false;
  }
}

/**
 * Reduces a raw registry file to the allowlisted entry.
 *
 * `messagingSocketPath`, `pid`, `procStart`, `pidDomain` and `peerFeatures`
 * are all deliberately dropped here — this is the choke point where a session
 * stops being a process one could interact with and becomes a record one can
 * only read about.
 */
function toRegistryEntry(raw: unknown): ClaudeSessionRegistryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  if (!isValidSessionId(record.sessionId)) return null;
  if (typeof record.cwd !== "string" || !record.cwd) return null;

  const entry: ClaudeSessionRegistryEntry = { sessionId: record.sessionId, cwd: record.cwd };

  if (typeof record.status === "string") entry.status = record.status;
  if (typeof record.name === "string" && record.name) entry.name = record.name;
  if (typeof record.version === "string") entry.version = record.version;
  if (typeof record.startedAt === "number" && Number.isFinite(record.startedAt)) {
    entry.startedAt = record.startedAt;
  }
  if (typeof record.statusUpdatedAt === "number" && Number.isFinite(record.statusUpdatedAt)) {
    entry.statusUpdatedAt = record.statusUpdatedAt;
  }

  return entry;
}

/**
 * Every live session in `~/.claude/sessions/`.
 *
 * One malformed or half-written file is skipped rather than failing the
 * sweep: the directory is written by a running process, so reading it
 * mid-write is expected.
 */
export async function readSessionRegistry(): Promise<ClaudeSessionRegistryEntry[]> {
  let files: string[];
  try {
    files = await readdir(/*turbopackIgnore: true*/ join(claudeHome(), "sessions"));
  } catch {
    return [];
  }

  const entries: ClaudeSessionRegistryEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    if (entries.length >= CLAUDE_LIMITS.maxSessions) break;

    try {
      const raw = await readFile(/*turbopackIgnore: true*/ join(claudeHome(), "sessions", file), "utf8");
      const entry = toRegistryEntry(JSON.parse(raw));
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }

  return entries;
}

/**
 * Locates a session's transcript and its lifecycle sidecar by scanning the
 * projects root.
 *
 * Scanning rather than deriving the directory from `cwd` is deliberate. The
 * directory name is the absolute path with `:`, `\`, `/` and `.` all replaced
 * by `-`, which is lossy and therefore not reliably reversible — and
 * re-deriving it would mean building a path out of a value that ultimately
 * came from a file. Searching for a UUID-validated filename cannot produce a
 * path outside the root no matter what any input says.
 */
async function locateSession(
  sessionId: string
): Promise<{ transcript: string; released: string } | null> {
  if (!isValidSessionId(sessionId)) return null;

  const root = join(claudeHome(), "projects");
  let dirs: string[];
  try {
    dirs = await readdir(/*turbopackIgnore: true*/ root);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    const transcript = join(root, dir, `${sessionId}.jsonl`);
    try {
      const stats = await stat(/*turbopackIgnore: true*/ transcript);
      if (!stats.isFile()) continue;
      return { transcript, released: join(root, dir, `${sessionId}.desktop-released.json`) };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Whether Claude Code wrote an explicit end-of-life artifact for this session.
 *
 * The only `reason` ever observed is `"delete"`, meaning the user deleted the
 * session record in the desktop app. It is mapped to `"deleted"` and nothing
 * more is inferred from it — see ClaudeTerminalReason for why this is a
 * statement about the record rather than about how the work turned out.
 */
async function readTerminalSignal(releasedPath: string): Promise<"deleted" | undefined> {
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ releasedPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.reason === "string" ? "deleted" : undefined;
  } catch {
    return undefined;
  }
}

export type SessionReadResult = {
  session: ClaudeDiscoveredSession;
  records: ClaudeParsedRecord[];
  cursor: ClaudeTranscriptCursor;
};

/**
 * Reads whatever is new in one session's transcript.
 *
 * Bounded in every direction: at most `maxBytesPerPoll` bytes are read, and a
 * larger backlog is simply caught up over subsequent polls rather than pulled
 * in one go. A transcript on the survey machine reached 17.4 MB, so this cap
 * is the difference between a background poll and a stall.
 *
 * The returned cursor's offset always sits immediately after a newline. A
 * final partial line — Claude Code writing as this reads — advances nothing
 * and is re-read whole next time, so a record is never parsed in half and
 * never skipped.
 */
export async function readSessionActivity(
  entry: ClaudeSessionRegistryEntry,
  previous: ClaudeTranscriptCursor | undefined,
  now: number
): Promise<SessionReadResult> {
  const session: ClaudeDiscoveredSession = {
    externalId: entry.sessionId,
    projectPath: entry.cwd,
    lastObservedAt: entry.statusUpdatedAt ?? now,
  };

  // How many tasks this session had already created when the last poll
  // stopped. Every early return below carries it forward unchanged: a poll
  // that reads no records must not reset the count, or the next batch of
  // creations would be numbered from zero and collide with the existing ones.
  const carriedOrdinal = previous?.taskOrdinal ?? 0;

  const status = mapClaudeStatus(entry.status);
  if (status) session.status = status;
  if (entry.name) session.title = entry.name;

  const located = await locateSession(entry.sessionId);
  if (!located) {
    return {
      session,
      records: [],
      cursor: { sessionId: entry.sessionId, offset: 0, size: 0, taskOrdinal: carriedOrdinal },
    };
  }

  const terminal = await readTerminalSignal(located.released);
  if (terminal) session.terminal = terminal;

  let size = 0;
  try {
    size = (await stat(/*turbopackIgnore: true*/ located.transcript)).size;
  } catch {
    return {
      session,
      records: [],
      cursor: { sessionId: entry.sessionId, offset: 0, size: 0, taskOrdinal: carriedOrdinal },
    };
  }

  const start = resolveReadStart(previous, size, CLAUDE_LIMITS.initialTailBytes);
  const available = Math.max(0, size - start.offset);
  const length = Math.min(available, CLAUDE_LIMITS.maxBytesPerPoll);

  if (length === 0) {
    return {
      session,
      records: [],
      cursor: { sessionId: entry.sessionId, offset: start.offset, size, taskOrdinal: carriedOrdinal },
    };
  }

  const buffer = Buffer.alloc(length);
  let read = 0;
  try {
    const handle = await open(/*turbopackIgnore: true*/ located.transcript, "r");
    try {
      ({ bytesRead: read } = await handle.read(buffer, 0, length, start.offset));
    } finally {
      await handle.close();
    }
  } catch {
    return {
      session,
      records: [],
      cursor: { sessionId: entry.sessionId, offset: start.offset, size, taskOrdinal: carriedOrdinal },
    };
  }

  const chunk = buffer.subarray(0, read);

  // The newline search runs on BYTES, not on the decoded string: a character
  // offset would drift from a byte offset the moment a transcript contained
  // any multi-byte UTF-8, and the cursor would then resume mid-record.
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    // No complete line in the whole window. Either a single enormous record
    // or a mid-write tail; either way nothing is consumed and the same bytes
    // are reconsidered next poll.
    return {
      session,
      records: [],
      cursor: { sessionId: entry.sessionId, offset: start.offset, size, taskOrdinal: carriedOrdinal },
    };
  }

  const complete = chunk.subarray(0, lastNewline + 1).toString("utf8");
  const records: ClaudeParsedRecord[] = [];
  for (const line of complete.split("\n")) {
    if (!line) continue;
    const parsed = parseTranscriptLine(line);
    // A malformed line is skipped. One bad record must not cost the poll
    // every other record beside it.
    if (parsed) records.push(parsed);
  }

  // Skip the first (probably partial) line when starting mid-file on a
  // session seen for the first time — it was cut by the tail window, not by
  // Claude Code.
  if (start.firstSight && start.offset > 0 && records.length > 0) records.shift();

  return {
    session,
    records,
    cursor: {
      sessionId: entry.sessionId,
      offset: start.offset + lastNewline + 1,
      size,
      // Advanced by however many tasks these records created, so the next
      // poll numbers its own creations from the right place.
      taskOrdinal: carriedOrdinal + countCreatedTasks(records),
    },
  };
}

export type ObservationSweep = {
  available: boolean;
  results: SessionReadResult[];
};

/**
 * One full poll: every live session, with whatever each has added.
 *
 * The cursor state arrives already validated by `decodeCursor`; sessions it
 * mentions that no longer exist simply drop out, which is how a cursor stays
 * bounded over time.
 */
export async function sweepSessions(cursors: CursorState, now: number): Promise<ObservationSweep> {
  if (!(await isClaudeCodeAvailable())) return { available: false, results: [] };

  const byId = new Map(cursors.map((cursor) => [cursor.sessionId, cursor]));
  const entries = await readSessionRegistry();

  const results: SessionReadResult[] = [];
  for (const entry of entries) {
    results.push(await readSessionActivity(entry, byId.get(entry.sessionId), now));
  }

  return { available: true, results };
}
