import { scopedKey } from "@/lib/storage/namespace";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The local loop log (Stage 3): which milestones of the work loop —
 * project → context → delegate → supervise → review → return — a person
 * reached, and when. It exists to answer one question about Hubble's first
 * users: *do they complete meaningful work through it?*
 *
 * ## What it never holds
 *
 * Content. No prompt, file, path, URL, tab, workspace or project name, and no
 * id that could be joined to one. A record is a milestone kind, a time, and —
 * where it says something — the agent's provider id ("gemini") and an
 * approval's answer. It is written to this browser's storage only: nothing in
 * Hubble sends it anywhere. A person can read their own summary
 * (`hubbleLoopSummary()` in the console) and choose to share it.
 */

export type LoopMilestone =
  | "workspace_created"
  | "workspace_revisited"
  | "project_connected"
  | "context_changed"
  | "session_started"
  | "task_submitted"
  | "approval_requested"
  | "approval_answered"
  | "task_completed"
  | "task_failed"
  | "handoff_started"
  | "result_reviewed"
  | "check_run";

export const LOOP_MILESTONES: readonly LoopMilestone[] = [
  "workspace_created",
  "workspace_revisited",
  "project_connected",
  "context_changed",
  "session_started",
  "task_submitted",
  "approval_requested",
  "approval_answered",
  "task_completed",
  "task_failed",
  "handoff_started",
  "result_reviewed",
  "check_run",
];

export type LoopRecord = {
  kind: LoopMilestone;
  at: number;
  provider?: AgentProviderId;
  /** On `approval_answered` only. */
  approved?: boolean;
};

const KEY = "tabdump:loop-log:v1";
/** Enough for weeks of real use; the oldest go first. */
export const MAX_LOOP_RECORDS = 500;
/** A return is counted once per workspace visit, not per render: at least this long since the last one. */
export const REVISIT_GAP_MS = 30 * 60_000;
/** How many already-counted milestones are remembered, for `once`. */
const MAX_SEEN_KEYS = 300;

const PROVIDER = /^[a-z][a-z0-9-]{0,40}(:[a-z0-9][a-z0-9-]{0,63})?$/;

function revive(value: unknown): LoopRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || !(LOOP_MILESTONES as readonly string[]).includes(record.kind)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  return {
    kind: record.kind as LoopMilestone,
    at: record.at,
    ...(typeof record.provider === "string" && PROVIDER.test(record.provider) ? { provider: record.provider as AgentProviderId } : {}),
    ...(typeof record.approved === "boolean" ? { approved: record.approved } : {}),
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
 * A one-way digest of a dedupe key ("task_completed" + a session's position),
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
  detail: { provider?: AgentProviderId; approved?: boolean; once?: string } = {},
  now: number = Date.now()
): void {
  const record = revive({ kind, at: now, ...(detail.provider ? { provider: detail.provider } : {}), ...(detail.approved !== undefined ? { approved: detail.approved } : {}) });
  if (!record) return;
  const stored = readStored();
  // `once`: a milestone that a re-render, a re-read or a reload must not count twice (a task finishing).
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
  /** Approvals answered "approve", of all answered. */
  approvalsApproved: number;
  /** Tasks that were submitted and later had a result reviewed (or a check run) before the next task. */
  tasksReviewed: number;
  /** Distinct agents used to start sessions. */
  agents: readonly AgentProviderId[];
  firstAt?: number;
  lastAt?: number;
};

/** What the log says about the loop: how much work went all the way round. */
export function loopSummary(records: readonly LoopRecord[] = readLoopLog()): LoopSummary {
  const counts = Object.fromEntries(LOOP_MILESTONES.map((kind) => [kind, 0])) as Record<LoopMilestone, number>;
  const agents = new Set<AgentProviderId>();
  let approvalsApproved = 0;
  let tasksReviewed = 0;
  let open = false;
  for (const record of records) {
    counts[record.kind] += 1;
    if (record.kind === "session_started" && record.provider) agents.add(record.provider);
    if (record.kind === "approval_answered" && record.approved) approvalsApproved += 1;
    if (record.kind === "task_submitted") open = true;
    if ((record.kind === "result_reviewed" || record.kind === "check_run") && open) {
      tasksReviewed += 1;
      open = false;
    }
  }
  return {
    counts,
    approvalsApproved,
    tasksReviewed,
    agents: [...agents].sort(),
    ...(records.length > 0 ? { firstAt: records[0]!.at, lastAt: records[records.length - 1]!.at } : {}),
  };
}

/** Lets a person read their own summary from the console. Installed once by the app shell; sends nothing. */
export function exposeLoopSummary(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { hubbleLoopSummary?: () => LoopSummary }).hubbleLoopSummary = () => loopSummary();
}
