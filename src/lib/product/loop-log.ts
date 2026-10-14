import { scopedKey } from "@/lib/storage/namespace";
import type { AiProviderId } from "@/lib/providers/registry";

/**
 * The local loop log: which steps of Hubble's loop — capture → connect →
 * find → reuse — a person reached, and when. It exists to answer one
 * question about Hubble's first users: *does what they save come back to
 * help them later?*
 *
 * ## What it never holds
 *
 * Content. No conversation, prompt, URL, title, project name, and no id that
 * could be joined to one. A record is a milestone kind, a time, and — where
 * it says something — the AI app involved ("claude"). It is written to this
 * browser's storage only: nothing in Hubble sends it anywhere. A person can
 * read their own summary (`hubbleLoopSummary()` in the console) and choose
 * to share it.
 */

export type LoopMilestone =
  | "workspace_created"
  | "workspace_revisited"
  | "project_created"
  | "project_returned"
  // Capture
  | "resource_added"
  | "resource_ready"
  | "resource_failed"
  | "conversation_captured"
  | "conversation_imported"
  | "note_added"
  // Find
  | "search_used"
  // Reuse
  | "memory_copied"
  | "memory_inserted";

export const LOOP_MILESTONES: readonly LoopMilestone[] = [
  "workspace_created",
  "workspace_revisited",
  "project_created",
  "project_returned",
  "resource_added",
  "resource_ready",
  "resource_failed",
  "conversation_captured",
  "conversation_imported",
  "note_added",
  "search_used",
  "memory_copied",
  "memory_inserted",
];

export type LoopRecord = {
  kind: LoopMilestone;
  at: number;
  /** The AI app a capture came from or reuse went to. */
  provider?: AiProviderId;
};

const KEY = "tabdump:loop-log:v1";
/** Enough for weeks of real use; the oldest go first. */
export const MAX_LOOP_RECORDS = 500;
/** A return is counted once per workspace visit, not per render: at least this long since the last one. */
export const REVISIT_GAP_MS = 30 * 60_000;
/** How many already-counted milestones are remembered, for `once`. */
const MAX_SEEN_KEYS = 300;

const PROVIDERS: readonly string[] = ["chatgpt", "claude", "gemini", "perplexity"];

function revive(value: unknown): LoopRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || !(LOOP_MILESTONES as readonly string[]).includes(record.kind)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  return {
    kind: record.kind as LoopMilestone,
    at: record.at,
    ...(typeof record.provider === "string" && PROVIDERS.includes(record.provider) ? { provider: record.provider as AiProviderId } : {}),
  };
}

type Stored = { records: LoopRecord[]; seen: string[] };

function readStored(): Stored {
  try {
    const raw = window.localStorage.getItem(scopedKey(KEY));
    if (!raw) return { records: [], seen: [] };
    const parsed = JSON.parse(raw) as { version?: unknown; records?: unknown; seen?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return { records: [], seen: [] };
    return {
      records: parsed.records.map(revive).filter((record): record is LoopRecord => record !== null),
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((key): key is string => typeof key === "string" && /^[0-9a-z]{1,16}$/.test(key)) : [],
    };
  } catch {
    return { records: [], seen: [] };
  }
}

function writeStored(stored: Stored): void {
  try {
    window.localStorage.setItem(scopedKey(KEY), JSON.stringify({ version: 1, records: stored.records.slice(-MAX_LOOP_RECORDS), seen: stored.seen.slice(-MAX_SEEN_KEYS) }));
  } catch {
    // Storage full or blocked: the log is a convenience, never a reason to fail.
  }
}

/** Never throws: an unreadable log is an empty one. */
export function readLoopLog(): LoopRecord[] {
  return readStored().records;
}

/**
 * A one-way digest of a dedupe key ("project_returned" + a project and a day),
 * so the log can tell a milestone was already counted without keeping any id.
 */
function digest(key: string): string {
  let hash = 5381;
  for (let index = 0; index < key.length; index++) hash = ((hash << 5) + hash + key.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

/**
 * Records one milestone. Only the fields above are kept — anything else a
 * caller passes is dropped, so content cannot ride along by accident.
 */
export function recordLoopMilestone(
  kind: LoopMilestone,
  detail: { provider?: AiProviderId; once?: string } = {},
  now: number = Date.now()
): void {
  const record = revive({ kind, at: now, ...(detail.provider ? { provider: detail.provider } : {}) });
  if (!record) return;
  const stored = readStored();
  // `once`: a milestone that a re-render, a re-read or a reload must not count twice (a return to a project).
  const key = detail.once ? digest(`${kind}:${detail.once}`) : undefined;
  if (key && stored.seen.includes(key)) return;
  writeStored({ records: [...stored.records, record], seen: key ? [...stored.seen, key] : stored.seen });
}

/** `workspace_revisited`, at most once per `REVISIT_GAP_MS` — opening a workspace again later is the signal, not every switch. */
export function recordWorkspaceVisit(now: number = Date.now()): void {
  const last = [...readLoopLog()].reverse().find((record) => record.kind === "workspace_revisited");
  if (last && now - last.at < REVISIT_GAP_MS) return;
  recordLoopMilestone("workspace_revisited", {}, now);
}

export type LoopSummary = {
  counts: Record<LoopMilestone, number>;
  /** Saves (captures, imports, sources, notes) followed by a reuse — saved knowledge that came back. */
  reusesAfterCapture: number;
  /** AI apps conversations were saved from, and context was reused in. */
  capturedFrom: readonly AiProviderId[];
  reusedIn: readonly AiProviderId[];
  firstAt?: number;
  lastAt?: number;
};

const SAVES: readonly LoopMilestone[] = ["conversation_captured", "conversation_imported", "resource_added", "note_added"];
const REUSES: readonly LoopMilestone[] = ["memory_copied", "memory_inserted"];

/** What the log says about the loop: how much of what was saved came back. */
export function loopSummary(records: readonly LoopRecord[] = readLoopLog()): LoopSummary {
  const counts = Object.fromEntries(LOOP_MILESTONES.map((kind) => [kind, 0])) as Record<LoopMilestone, number>;
  const capturedFrom = new Set<AiProviderId>();
  const reusedIn = new Set<AiProviderId>();
  let reusesAfterCapture = 0;
  let saved = false;
  for (const record of records) {
    counts[record.kind] += 1;
    if ((record.kind === "conversation_captured" || record.kind === "conversation_imported") && record.provider) capturedFrom.add(record.provider);
    if (REUSES.includes(record.kind) && record.provider) reusedIn.add(record.provider);
    if (SAVES.includes(record.kind)) saved = true;
    if (REUSES.includes(record.kind) && saved) {
      reusesAfterCapture += 1;
      saved = false;
    }
  }
  return {
    counts,
    reusesAfterCapture,
    capturedFrom: [...capturedFrom].sort(),
    reusedIn: [...reusedIn].sort(),
    ...(records.length > 0 ? { firstAt: records[0]!.at, lastAt: records[records.length - 1]!.at } : {}),
  };
}

/** Lets a person read their own summary from the console. Installed once by the app shell; sends nothing. */
export function exposeLoopSummary(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { hubbleLoopSummary?: () => LoopSummary }).hubbleLoopSummary = () => loopSummary();
}
