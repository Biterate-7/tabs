import { isClaudeTaskStatus } from "./types";
import type { ClaudeParsedRecord, ClaudeTaskEvent, ClaudeToolUse } from "./types";

/**
 * Pure parsing of Claude Code transcript lines.
 *
 * No filesystem, no React, no storage, no wording decisions — this layer only
 * turns a line of JSONL into the small allowlisted record in ./types.ts.
 *
 * The governing rule is **allowlist, never denylist**. A transcript line is
 * assumed sensitive by default: it carries prompts, `thinking` blocks and
 * `toolUseResult` payloads inline, as ordinary content rather than as an edge
 * case. So nothing is copied out of a record except the specific fields named
 * below, and there is no code path that forwards an unrecognised field. A
 * denylist would have to be updated every time Claude Code adds one.
 */

/**
 * Structured input keys that hold a filesystem path, per tool.
 *
 * Read from structured input rather than scraped from text, so a path is only
 * ever taken from a field that is definitionally a path.
 */
const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"] as const;

/** Tools whose `description` is a human-written summary safe to surface. */
const DESCRIBED_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);

/**
 * Parses one line.
 *
 * Returns null for anything unusable — blank lines, malformed JSON, records
 * with no `type`. A single bad line must never abort a poll: transcripts are
 * written live, and a torn or half-flushed line is an expected occurrence
 * rather than corruption.
 */
export function parseTranscriptLine(line: string): ClaudeParsedRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type !== "string" || !record.type) return null;

  const parsed: ClaudeParsedRecord = { type: record.type, tools: [], tasks: [] };

  if (typeof record.uuid === "string" && record.uuid) parsed.uuid = record.uuid;
  if (typeof record.gitBranch === "string" && record.gitBranch) {
    parsed.gitBranch = record.gitBranch;
  }

  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp !== undefined) parsed.timestamp = timestamp;

  // Only `assistant` records carry tool invocations. Every other type —
  // user, system, attachment, file-history-delta, atis-latch, custom-title,
  // queue-operation, last-prompt, bridge-session, file-history-snapshot, and
  // whatever a future version adds — is recognised as a record and then
  // contributes nothing, which is exactly the desired handling of an unknown
  // type: ignored, not fatal.
  if (record.type === "assistant") {
    parsed.tools = extractToolUses(record.message);
    parsed.tasks = extractTaskEvents(record.message);
  }

  return parsed;
}

/**
 * The two tools whose structured input describes a unit of work.
 *
 * An allowlist of exactly two names, and the reason it is a list rather than a
 * pattern is that a pattern would match `spawn_task` and `dismiss_task` — the
 * first of which carries a raw `prompt`. Nothing is read from any tool not
 * named here.
 */
const TASK_CREATE_TOOL = "TaskCreate";
const TASK_UPDATE_TOOL = "TaskUpdate";

/**
 * Pulls task-list activity out of an assistant message.
 *
 * Walks the same `tool_use` blocks `extractToolUses` does, and reads exactly
 * four keys across two tools: `subject` and `description` from TaskCreate,
 * `taskId` and `status` from TaskUpdate. Every other key of those tools, and
 * every other tool, contributes nothing.
 */
function extractTaskEvents(message: unknown): ClaudeTaskEvent[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];

  const events: ClaudeTaskEvent[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_use") continue;
    if (typeof block.name !== "string") continue;
    if (block.name !== TASK_CREATE_TOOL && block.name !== TASK_UPDATE_TOOL) continue;

    const input = block.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const fields = input as Record<string, unknown>;

    if (block.name === TASK_CREATE_TOOL) {
      const subject = fields.subject;
      // No subject, no work item. A task with no name is not something that
      // can be shown, and there is no second field to fall back to.
      if (typeof subject !== "string" || !subject.trim()) continue;

      const event: ClaudeTaskEvent = { kind: "create", subject: subject.trim() };
      const description = fields.description;
      if (typeof description === "string" && description.trim()) {
        event.description = description.trim();
      }
      events.push(event);
      continue;
    }

    const taskId = fields.taskId;
    if (typeof taskId !== "string" || !taskId.trim()) continue;
    // An unrecognised status means no status change, so the event is not
    // worth carrying — the same rule the session status mapping follows.
    if (!isClaudeTaskStatus(fields.status)) continue;

    events.push({ kind: "update", taskId: taskId.trim(), status: fields.status });
  }

  return events;
}

/**
 * Claude Code writes ISO-8601 strings. Epoch numbers are accepted too, since
 * the registry uses them and a future transcript might.
 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Pulls `tool_use` blocks out of an assistant message, ignoring `text` and `thinking`. */
function extractToolUses(message: unknown): ClaudeToolUse[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];

  const tools: ClaudeToolUse[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    // `thinking` and `text` blocks are skipped by this condition, and there
    // is no branch anywhere below that would read them.
    if (block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || !block.id) continue;
    if (typeof block.name !== "string" || !block.name) continue;

    tools.push(extractOneTool(block.id, block.name, block.input));
  }

  return tools;
}

function extractOneTool(id: string, name: string, input: unknown): ClaudeToolUse {
  const tool: ClaudeToolUse = { id, name };
  if (!input || typeof input !== "object" || Array.isArray(input)) return tool;

  const fields = input as Record<string, unknown>;

  // Paths come only from these structured keys. `Edit` also carries
  // `old_string`/`new_string` and `Write` carries `content` — those are file
  // contents and are never read. Nothing is ever scraped from prose: a path
  // that looks like a path inside a model's text is not evidence that a file
  // was touched.
  //
  // Every allowlisted key present contributes, rather than stopping at the
  // first, so a tool that structurally names two files yields two.
  const paths: string[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() && !paths.includes(value)) {
      paths.push(value);
    }
  }

  if (paths.length > 0) {
    tool.filePaths = paths;
    const base = basename(paths[0]);
    if (base) tool.fileName = base;
  }

  // Shell tools: the human-written description only. `command` is never read,
  // which is the single most important omission in this file.
  if (DESCRIBED_TOOLS.has(name)) {
    const description = fields.description;
    if (typeof description === "string" && description.trim()) {
      tool.description = description.trim();
    }
  }

  // A URL, for exact-match tab linking. Validated as http(s) so a `file://`
  // or `data:` URL cannot travel as one.
  const url = fields.url;
  if (typeof url === "string" && isHttpUrl(url)) tool.url = url;

  return tool;
}

/**
 * Last path segment, for either separator.
 *
 * Deliberately string-only: `node:path` is not importable here (the security
 * guard forbids it), and platform-correct resolution is not needed to take
 * the final segment of a path Claude Code already wrote out in full.
 */
export function basename(filePath: string): string {
  const cleaned = filePath.replace(/[\\/]+$/, "");
  const index = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return index === -1 ? cleaned : cleaned.slice(index + 1);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Splits a chunk of transcript into complete lines.
 *
 * Returns the lines that are definitely complete plus the byte length that
 * was consumed, so the caller can advance a cursor to a position it knows sits
 * immediately after a newline. A trailing partial line — Claude Code mid-write
 * — contributes nothing and is left to be re-read whole on the next poll.
 */
export function splitCompleteLines(chunk: string): { lines: string[]; consumed: number } {
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], consumed: 0 };

  const complete = chunk.slice(0, lastNewline + 1);
  return { lines: complete.split("\n").filter((line) => line.length > 0), consumed: complete.length };
}
