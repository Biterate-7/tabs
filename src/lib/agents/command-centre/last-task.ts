import { scopedKey } from "@/lib/storage/namespace";
import { TASK_STATE_LABEL, taskNeedsAttention, taskOutcomeFacts } from "@/lib/agents/activity/outcome";
import type { TaskOutcome, TaskState } from "@/lib/agents/activity/outcome";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * Each workspace's latest agent task, as it last stood (Stage 3) — what a
 * person coming back to a workspace is shown first: which agent worked on
 * what, how it ended, what changed, and whether anything still needs them.
 *
 * Not a history: one record per workspace, replaced as the task moves on.
 * The runtime's sessions and agent history remain the record of the work;
 * this keeps the last answer to "where did I leave off?" in the browser, so it
 * is there the moment the workspace opens — before any runtime is reached,
 * and when none can be (hosted, signed out, a restarted local runtime).
 *
 * Local only, never synced, scoped to the account like the workspaces it
 * belongs to. It holds the person's own instruction (one bounded line) and
 * counts — no file contents, no paths beyond what the outcome's facts say
 * (none), no reply text.
 */
export type LastTask = {
  workspaceId: string;
  sessionId: string;
  provider: AgentProviderId;
  projectId?: string;
  state: TaskState;
  headline: string;
  task?: string;
  /** "+17 −6", "Tests passed" — the outcome's facts when it was recorded. */
  facts: readonly string[];
  /** Something still asks for the person: an approval, a failure, a failed check. */
  attention: boolean;
  at: number;
};

const KEY = "tabdump:agent-last-task:v1";
const MAX_WORKSPACES = 50;
const STATES = Object.keys(TASK_STATE_LABEL) as TaskState[];

function revive(value: unknown): LastTask | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof record[key] === "string" && (record[key] as string).length > 0 && (record[key] as string).length <= max ? (record[key] as string) : undefined);
  const workspaceId = text("workspaceId", 200);
  const sessionId = text("sessionId", 200);
  const provider = text("provider", 120);
  const headline = text("headline", 300);
  if (!workspaceId || !sessionId || !provider || !headline) return null;
  if (typeof record.state !== "string" || !STATES.includes(record.state as TaskState)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  const facts = Array.isArray(record.facts) ? record.facts.filter((fact): fact is string => typeof fact === "string" && fact.length <= 80).slice(0, 6) : [];
  const task = text("task", 300);
  const projectId = text("projectId", 200);
  return {
    workspaceId,
    sessionId,
    provider: provider as AgentProviderId,
    ...(projectId ? { projectId } : {}),
    state: record.state as TaskState,
    headline,
    ...(task ? { task } : {}),
    facts,
    attention: record.attention === true,
    at: record.at,
  };
}

/** The stored records as written — a stable value for `useSyncExternalStore`. Never throws. */
export function lastTasksSnapshot(): string | null {
  try {
    return window.localStorage.getItem(scopedKey(KEY));
  } catch {
    return null;
  }
}

function parseAll(raw: string | null): LastTask[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; tasks?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return [];
    return parsed.tasks.map(revive).filter((task): task is LastTask => task !== null);
  } catch {
    return [];
  }
}

function readAll(): LastTask[] {
  return parseAll(lastTasksSnapshot());
}

const listeners = new Set<() => void>();

/** The workspace's last task in a snapshot, or `undefined`. */
export function lastTaskIn(snapshot: string | null, workspaceId: string | undefined): LastTask | undefined {
  if (!workspaceId) return undefined;
  return parseAll(snapshot).find((task) => task.workspaceId === workspaceId);
}

/** The workspace's last task, or `undefined`. Never throws. */
export function lastTaskFor(workspaceId: string | undefined): LastTask | undefined {
  if (!workspaceId || typeof window === "undefined") return undefined;
  return lastTaskIn(lastTasksSnapshot(), workspaceId);
}

/** Builds the record from an outcome. `undefined` for a session with no task yet — there is nothing to come back to. */
export function lastTaskOf(input: {
  workspaceId: string;
  sessionId: string;
  provider: AgentProviderId;
  projectId?: string;
  outcome: TaskOutcome;
  checksAvailable?: boolean;
}): LastTask | undefined {
  const { outcome } = input;
  if (outcome.state === "ready" || !outcome.task || outcome.at === 0) return undefined;
  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    provider: input.provider,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    state: outcome.state,
    headline: outcome.headline,
    task: outcome.task,
    facts: taskOutcomeFacts(outcome, { checksAvailable: input.checksAvailable ?? false }),
    attention: taskNeedsAttention(outcome),
    at: outcome.at,
  };
}

/** Same task, same words: nothing to write. */
function sameTask(a: LastTask, b: LastTask): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Keeps the workspace's last task. An older task never replaces a newer one,
 * so a session reopened later cannot overwrite what happened since.
 */
export function rememberLastTask(task: LastTask): void {
  try {
    const all = readAll();
    const existing = all.find((entry) => entry.workspaceId === task.workspaceId);
    if (existing && (existing.at > task.at || sameTask(existing, task))) return;
    const next = [task, ...all.filter((entry) => entry.workspaceId !== task.workspaceId)].slice(0, MAX_WORKSPACES);
    window.localStorage.setItem(scopedKey(KEY), JSON.stringify({ version: 1, tasks: next }));
    for (const listener of listeners) listener();
  } catch {
    // Storage full or blocked: the workspace simply won't remember.
  }
}

/** Forgets a workspace's last task — when the workspace is deleted. */
export function forgetLastTask(workspaceId: string): void {
  try {
    const all = readAll();
    if (!all.some((entry) => entry.workspaceId === workspaceId)) return;
    window.localStorage.setItem(scopedKey(KEY), JSON.stringify({ version: 1, tasks: all.filter((entry) => entry.workspaceId !== workspaceId) }));
    for (const listener of listeners) listener();
  } catch {
    // As above.
  }
}

export function subscribeLastTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "Done", "Needs you" — or, for a task last seen in progress, "Last seen working": Hubble cannot vouch that it still is. */
export function lastTaskStateLabel(task: Pick<LastTask, "state">): string {
  if (task.state === "working") return "Last seen working";
  if (task.state === "needs_you") return "Was waiting for you";
  return TASK_STATE_LABEL[task.state];
}
