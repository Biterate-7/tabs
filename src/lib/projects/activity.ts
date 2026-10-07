import { scopedKey } from "@/lib/storage/namespace";
import { RESOURCE_ORIGINS } from "@/lib/resources/types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { LastTask } from "@/lib/agents/command-centre/last-task";
import type { ResourceOrigin } from "@/lib/resources/types";
import type { TaskState } from "@/lib/agents/activity/outcome";

/**
 * What happened in a project, in order (Hubble 2.0) — the project's own
 * history, beside the agent activity timeline each session keeps:
 *
 *     Today
 *       10:42  Claude analyzed 8 sources           (a task)
 *       10:38  You added 3 sources from Chrome
 *       10:31  Gemini identified 4 evidence gaps   (a task)
 *     Yesterday
 *              You created History IA
 *
 * ## What it records, and what it never does
 *
 * Source events carry a kind, a time, a count and where they came from — no
 * title, no address, no extracted text. A screen that wants a source's name
 * looks it up by id from the project at render time, so a removed source
 * does not linger in the log by name.
 *
 * A task carries what the return loop (`last-task.ts`) already keeps for a
 * project on this device: the agent, the outcome's headline and the
 * person's one-line instruction — so the project can show its last few
 * pieces of work, not only the latest. Bounded per project and in all.
 *
 * Local only, account-scoped, never synced and never sent.
 */

export type ProjectEventKind =
  | "project_created"
  | "sources_added"
  | "source_ready"
  | "source_failed"
  | "sources_removed"
  | "context_selected"
  | "task"
  | "agent_switched";

export type ProjectEvent = {
  id: string;
  workspaceId: string;
  kind: ProjectEventKind;
  at: number;
  /** Sources added or removed, or selected for context. */
  count?: number;
  origin?: ResourceOrigin;
  /** The source an event is about, by id only. */
  tabId?: string;
  /** A task, or the agent switched to. */
  provider?: AgentProviderId;
  /** The agent switched from. */
  fromProvider?: AgentProviderId;
  sessionId?: string;
  state?: TaskState;
  headline?: string;
  task?: string;
  /** "8 sources · project brief" — what the task was given, counted. */
  context?: string;
};

const KEY = "tabdump:project-activity:v1";
export const MAX_PROJECT_EVENTS = 1000;
export const MAX_EVENTS_PER_PROJECT = 200;
const KINDS: readonly ProjectEventKind[] = ["project_created", "sources_added", "source_ready", "source_failed", "sources_removed", "context_selected", "task", "agent_switched"];
const STATES: readonly TaskState[] = ["ready", "working", "needs_you", "done", "failed", "stopped"];
const PROVIDER = /^[a-z][a-z0-9-]{0,40}(:[a-z0-9][a-z0-9-]{0,63})?$/;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : undefined;
}

function revive(value: unknown): ProjectEvent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = text(record.id, 120);
  const workspaceId = text(record.workspaceId, 200);
  if (!id || !workspaceId) return null;
  if (!KINDS.includes(record.kind as ProjectEventKind)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  const event: ProjectEvent = { id, workspaceId, kind: record.kind as ProjectEventKind, at: record.at };
  if (typeof record.count === "number" && Number.isInteger(record.count) && record.count >= 0) event.count = record.count;
  if (RESOURCE_ORIGINS.includes(record.origin as ResourceOrigin)) event.origin = record.origin as ResourceOrigin;
  const tabId = text(record.tabId, 200);
  if (tabId) event.tabId = tabId;
  for (const field of ["provider", "fromProvider"] as const) {
    if (typeof record[field] === "string" && PROVIDER.test(record[field] as string)) event[field] = record[field] as AgentProviderId;
  }
  const sessionId = text(record.sessionId, 200);
  if (sessionId) event.sessionId = sessionId;
  if (STATES.includes(record.state as TaskState)) event.state = record.state as TaskState;
  const headline = text(record.headline, 300);
  const task = text(record.task, 300);
  const context = text(record.context, 120);
  if (headline) event.headline = headline;
  if (task) event.task = task;
  if (context) event.context = context;
  return event;
}

export function projectActivitySnapshot(): string | null {
  try {
    return window.localStorage.getItem(scopedKey(KEY));
  } catch {
    return null;
  }
}

export function parseProjectActivity(raw: string | null): ProjectEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; events?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.events)) return [];
    return parsed.events.map(revive).filter((event): event is ProjectEvent => event !== null);
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

export function subscribeProjectActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function write(events: ProjectEvent[]): void {
  try {
    // Per project first, so one busy project can never push another's history out.
    const perProject = new Map<string, number>();
    const kept: ProjectEvent[] = [];
    for (const event of [...events].sort((a, b) => b.at - a.at)) {
      const count = perProject.get(event.workspaceId) ?? 0;
      if (count >= MAX_EVENTS_PER_PROJECT) continue;
      perProject.set(event.workspaceId, count + 1);
      kept.push(event);
      if (kept.length >= MAX_PROJECT_EVENTS) break;
    }
    window.localStorage.setItem(scopedKey(KEY), JSON.stringify({ version: 1, events: kept.reverse() }));
    for (const listener of listeners) listener();
  } catch {
    // Storage full or unavailable: the project works without its history line.
  }
}

let counter = 0;
function nextId(at: number): string {
  counter = (counter + 1) % 1_000_000;
  return `pe-${at.toString(36)}-${counter.toString(36)}`;
}

export function recordProjectEvent(event: Omit<ProjectEvent, "id" | "at"> & { at?: number }): void {
  const at = event.at ?? Date.now();
  const record = revive({ ...event, at, id: nextId(at) });
  if (!record) return;
  write([...parseProjectActivity(projectActivitySnapshot()), record]);
}

/**
 * A task's latest state, one entry per session: updated in place as the task
 * moves from working to done, so the history shows the outcome, not every step.
 */
export function recordProjectTask(task: LastTask, context?: string): void {
  const all = parseProjectActivity(projectActivitySnapshot());
  const existing = all.find((event) => event.kind === "task" && event.sessionId === task.sessionId && event.workspaceId === task.workspaceId);
  const record = revive({
    id: existing?.id ?? nextId(task.at),
    workspaceId: task.workspaceId,
    kind: "task",
    at: task.at,
    provider: task.provider,
    sessionId: task.sessionId,
    state: task.state,
    headline: task.headline,
    ...(task.task ? { task: task.task } : {}),
    ...(context ?? existing?.context ? { context: context ?? existing?.context } : {}),
  });
  if (!record) return;
  if (existing && JSON.stringify(existing) === JSON.stringify(record)) return;
  // A task never moves back in time: an older report of the same session is ignored.
  if (existing && existing.at > record.at) return;
  write([...all.filter((event) => event !== existing), record]);
}

export function projectEventsIn(raw: string | null, workspaceId: string | undefined): ProjectEvent[] {
  if (!workspaceId) return [];
  return parseProjectActivity(raw)
    .filter((event) => event.workspaceId === workspaceId)
    .sort((a, b) => b.at - a.at);
}

/** Forgotten with its project. */
export function forgetProjectActivity(workspaceId: string): void {
  const all = parseProjectActivity(projectActivitySnapshot());
  if (!all.some((event) => event.workspaceId === workspaceId)) return;
  write(all.filter((event) => event.workspaceId !== workspaceId));
}
