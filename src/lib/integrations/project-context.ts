import { mintRecordId, sha256Hex } from "./credentials";
import { UNSAFE_KEEP_LINES } from "./text";
import type { ContextSource, ProjectContextRecord, WorkspaceNoteRecord } from "./records";

/**
 * Saved project context — what continuity across AI clients rests on.
 *
 * ## Only what someone asked Hubble to keep
 *
 * Hubble's workspace brief (a purpose and a focus line) is device-local by
 * design and never reaches a server, so an AI client connected through the
 * account has no structured place for "where this project stands". This is
 * that place, and its rules are narrow:
 *
 *   - It holds exactly what a person or an authorized client explicitly
 *     saved: a goal, a current summary, confirmed decisions, outstanding
 *     tasks, the saved tabs that matter, and notes. Hubble generates none of
 *     it, and a conversation is never saved by being had.
 *   - Every entry records where it came from (`source`), so a reader can
 *     tell what was saved — and by which client — from what it infers.
 *   - Writes are additive. A client can set the goal and summary, add
 *     decisions and tasks, mark tasks done or open, and link tabs. It cannot
 *     delete a decision, a task or a note; the person can, in Hubble.
 *
 * ## Versioned
 *
 * `schemaVersion` is 1. `revision` increases on every write and is the
 * optimistic-concurrency token: a write naming an `expectedRevision` that is
 * no longer current is refused rather than merged over someone else's.
 */

export const CONTEXT_LIMITS = {
  goal: 500,
  summary: 4000,
  decision: 500,
  decisions: 50,
  task: 300,
  tasks: 100,
  resourceTabIds: 50,
  addPerWrite: 20,
  noteTitle: 120,
  noteBody: 8000,
} as const;

const UNSAFE = UNSAFE_KEEP_LINES;

/** Strips invisible and control characters (keeping newlines and tabs), trims, and bounds. */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(UNSAFE, "").replace(/\r\n?/g, "\n").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export type ProjectContextPatch = {
  goal?: string;
  summary?: string;
  addDecisions?: readonly string[];
  addTasks?: readonly string[];
  completeTaskIds?: readonly string[];
  reopenTaskIds?: readonly string[];
  linkTabIds?: readonly string[];
};

export type PatchProblem =
  | "empty_patch"
  | "too_many_items"
  | "decisions_full"
  | "tasks_full"
  | "resources_full"
  | "unknown_task"
  | "unknown_tab";

export const PATCH_PROBLEM_MESSAGES: Record<PatchProblem, string> = {
  empty_patch: "Nothing to save: give a goal, a summary, decisions, tasks or tabs to link.",
  too_many_items: `At most ${CONTEXT_LIMITS.addPerWrite} items of each kind per call.`,
  decisions_full: `This project already has ${CONTEXT_LIMITS.decisions} decisions. The person can remove old ones in Hubble.`,
  tasks_full: `This project already has ${CONTEXT_LIMITS.tasks} tasks. Mark finished ones done, or ask the person to tidy them in Hubble.`,
  resources_full: `A project context can link at most ${CONTEXT_LIMITS.resourceTabIds} tabs.`,
  unknown_task: "A task id does not belong to this project's context.",
  unknown_tab: "A tab id does not belong to this workspace.",
};

export function emptyContext(userId: string, workspaceId: string, now: number, source: ContextSource): ProjectContextRecord {
  return {
    schemaVersion: 1,
    userId,
    workspaceId,
    revision: 0,
    decisions: [],
    tasks: [],
    resourceTabIds: [],
    createdAt: now,
    updatedAt: now,
    updatedBy: source,
  };
}

/**
 * Applies a patch to a context, or says why it cannot. Pure: the caller
 * stores the result with the revision it read.
 */
export function applyContextPatch(
  current: ProjectContextRecord,
  patch: ProjectContextPatch,
  input: { workspaceTabIds: ReadonlySet<string>; source: ContextSource; now: number }
): { ok: true; record: ProjectContextRecord; changed: string[] } | { ok: false; problem: PatchProblem } {
  const goal = cleanText(patch.goal, CONTEXT_LIMITS.goal);
  const summary = cleanText(patch.summary, CONTEXT_LIMITS.summary);
  const decisions = (patch.addDecisions ?? []).map((text) => cleanText(text, CONTEXT_LIMITS.decision)).filter((t): t is string => !!t);
  const tasks = (patch.addTasks ?? []).map((text) => cleanText(text, CONTEXT_LIMITS.task)).filter((t): t is string => !!t);
  const complete = [...new Set(patch.completeTaskIds ?? [])];
  const reopen = [...new Set(patch.reopenTaskIds ?? [])];
  const link = [...new Set(patch.linkTabIds ?? [])];

  if (!goal && !summary && decisions.length === 0 && tasks.length === 0 && complete.length === 0 && reopen.length === 0 && link.length === 0) {
    return { ok: false, problem: "empty_patch" };
  }
  const lists = [patch.addDecisions, patch.addTasks, patch.completeTaskIds, patch.reopenTaskIds, patch.linkTabIds];
  if (lists.some((list) => (list?.length ?? 0) > CONTEXT_LIMITS.addPerWrite)) return { ok: false, problem: "too_many_items" };

  const known = new Set(current.tasks.map((task) => task.id));
  if (![...complete, ...reopen].every((id) => known.has(id))) return { ok: false, problem: "unknown_task" };
  if (!link.every((id) => input.workspaceTabIds.has(id))) return { ok: false, problem: "unknown_tab" };

  // Exact repeats are not added twice — a retried call saves once.
  const existingDecisions = new Set(current.decisions.map((d) => d.text));
  const newDecisions = [...new Set(decisions)].filter((text) => !existingDecisions.has(text));
  const openTexts = new Set(current.tasks.filter((t) => t.status === "open").map((t) => t.text));
  const newTasks = [...new Set(tasks)].filter((text) => !openTexts.has(text));
  const linked = new Set(current.resourceTabIds);
  const newLinks = link.filter((id) => !linked.has(id));

  if (current.decisions.length + newDecisions.length > CONTEXT_LIMITS.decisions) return { ok: false, problem: "decisions_full" };
  if (current.tasks.length + newTasks.length > CONTEXT_LIMITS.tasks) return { ok: false, problem: "tasks_full" };
  if (current.resourceTabIds.length + newLinks.length > CONTEXT_LIMITS.resourceTabIds) return { ok: false, problem: "resources_full" };

  const changed: string[] = [];
  const next: ProjectContextRecord = structuredClone(current);
  if (goal && goal !== current.goal) {
    next.goal = goal;
    changed.push("goal");
  }
  if (summary && summary !== current.summary) {
    next.summary = summary;
    changed.push("summary");
  }
  for (const text of newDecisions) next.decisions.push({ id: mintRecordId("dec"), text, at: input.now, source: input.source });
  if (newDecisions.length > 0) changed.push("decisions");
  for (const text of newTasks) {
    next.tasks.push({ id: mintRecordId("task"), text, status: "open", createdAt: input.now, updatedAt: input.now, source: input.source });
  }
  if (newTasks.length > 0) changed.push("tasks");
  for (const task of next.tasks) {
    const status = complete.includes(task.id) ? "done" : reopen.includes(task.id) ? "open" : task.status;
    if (status !== task.status) {
      task.status = status;
      task.updatedAt = input.now;
      if (!changed.includes("tasks")) changed.push("tasks");
    }
  }
  if (newLinks.length > 0) {
    next.resourceTabIds.push(...newLinks);
    changed.push("resources");
  }

  next.revision = current.revision + (changed.length > 0 ? 1 : 0);
  if (changed.length > 0) {
    next.updatedAt = input.now;
    next.updatedBy = input.source;
  }
  return { ok: true, record: next, changed };
}

export function noteContentHash(input: { workspaceId: string; collectionId?: string; title: string; body: string }): string {
  return sha256Hex(JSON.stringify(["hubble-note/1", input.workspaceId, input.collectionId ?? null, input.title, input.body]));
}

export function buildNote(input: {
  userId: string;
  workspaceId: string;
  collectionId?: string;
  title: string;
  body: string;
  source: ContextSource;
  now: number;
}): WorkspaceNoteRecord {
  return {
    id: mintRecordId("note"),
    userId: input.userId,
    workspaceId: input.workspaceId,
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    title: input.title,
    body: input.body,
    contentHash: noteContentHash(input),
    createdAt: input.now,
    source: input.source,
  };
}
