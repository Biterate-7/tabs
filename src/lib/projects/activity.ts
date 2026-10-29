import { scopedKey } from "@/lib/storage/namespace";
import { RESOURCE_ORIGINS } from "@/lib/resources/types";
import type { ResourceOrigin } from "@/lib/resources/types";

/**
 * What happened in a project, in order — the project's own history:
 *
 *     Today
 *       10:42  Saved a conversation from Claude
 *       10:38  You added 3 sources from Chrome
 *     Yesterday
 *              You created History IA
 *
 * ## What it records, and what it never does
 *
 * Events carry a kind, a time, a count, where things came from and — for a
 * conversation — which AI app. No title, no address, no text. A screen that
 * wants an item's name looks it up by id from the project at render time,
 * so a removed item does not linger in the log by name.
 *
 * ## Older records
 *
 * Earlier versions of Hubble ran AI agents and recorded their tasks here
 * ("task", "agent_switched", "context_selected"). Those records are still
 * read and kept on every write, so nobody's history is destroyed by an
 * upgrade, and Settings → Data can export or delete them. Nothing creates
 * them any more and no screen shows them.
 *
 * Local only, account-scoped, never synced and never sent.
 */

export type ProjectEventKind =
  | "project_created"
  | "sources_added"
  | "source_ready"
  | "source_failed"
  | "sources_removed"
  | "conversation_saved"
  | "conversation_updated"
  | "note_added"
  | "memory_reused"
  /** The person picked the project up again from Smart Resume (lib/intelligence/resume.ts). */
  | "project_resumed";

/** Kinds written by the removed agent features: read and kept, never created. */
export type LegacyProjectEventKind = "context_selected" | "task" | "agent_switched";

export type ProjectEvent = {
  id: string;
  workspaceId: string;
  kind: ProjectEventKind | LegacyProjectEventKind;
  at: number;
  /** Items added or removed. */
  count?: number;
  origin?: ResourceOrigin;
  /** The item an event is about, by id only. */
  tabId?: string;
  /** The AI app a conversation came from or context went to (or, on a legacy record, the agent). */
  provider?: string;
  /** Legacy agent records only. */
  fromProvider?: string;
  sessionId?: string;
  state?: string;
  headline?: string;
  task?: string;
  context?: string;
};

const LEGACY_KINDS: readonly LegacyProjectEventKind[] = ["context_selected", "task", "agent_switched"];

export function isLegacyProjectEvent(event: Pick<ProjectEvent, "kind">): boolean {
  return (LEGACY_KINDS as readonly string[]).includes(event.kind);
}

const KEY = "tabdump:project-activity:v1";
export const MAX_PROJECT_EVENTS = 1000;
export const MAX_EVENTS_PER_PROJECT = 200;
const KINDS: readonly string[] = [
  "project_created",
  "sources_added",
  "source_ready",
  "source_failed",
  "sources_removed",
  "conversation_saved",
  "conversation_updated",
  "note_added",
  "memory_reused",
  "project_resumed",
  ...LEGACY_KINDS,
];
const STATES: readonly string[] = ["ready", "working", "needs_you", "done", "failed", "stopped"];
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
  if (typeof record.kind !== "string" || !KINDS.includes(record.kind)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  const event: ProjectEvent = { id, workspaceId, kind: record.kind as ProjectEvent["kind"], at: record.at };
  if (typeof record.count === "number" && Number.isInteger(record.count) && record.count >= 0) event.count = record.count;
  if (RESOURCE_ORIGINS.includes(record.origin as ResourceOrigin)) event.origin = record.origin as ResourceOrigin;
  const tabId = text(record.tabId, 200);
  if (tabId) event.tabId = tabId;
  for (const field of ["provider", "fromProvider"] as const) {
    if (typeof record[field] === "string" && PROVIDER.test(record[field] as string)) event[field] = record[field] as string;
  }
  const sessionId = text(record.sessionId, 200);
  if (sessionId) event.sessionId = sessionId;
  if (typeof record.state === "string" && STATES.includes(record.state)) event.state = record.state;
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

export function recordProjectEvent(event: Omit<ProjectEvent, "id" | "at" | "kind"> & { kind: ProjectEventKind; at?: number }): void {
  const at = event.at ?? Date.now();
  const record = revive({ ...event, at, id: nextId(at) });
  if (!record) return;
  write([...parseProjectActivity(projectActivitySnapshot()), record]);
}

/** One project's history, newest first — what a screen shows (never the legacy agent records). */
export function projectEventsIn(raw: string | null, workspaceId: string | undefined): ProjectEvent[] {
  if (!workspaceId) return [];
  return parseProjectActivity(raw)
    .filter((event) => event.workspaceId === workspaceId && !isLegacyProjectEvent(event))
    .sort((a, b) => b.at - a.at);
}

/** Every record left by the removed agent features, for Settings → Data (export or delete). */
export function legacyProjectEvents(raw: string | null = projectActivitySnapshot()): ProjectEvent[] {
  return parseProjectActivity(raw).filter(isLegacyProjectEvent);
}

/** Deletes the legacy agent records, keeping every current one. */
export function forgetLegacyProjectEvents(): number {
  const all = parseProjectActivity(projectActivitySnapshot());
  const kept = all.filter((event) => !isLegacyProjectEvent(event));
  if (kept.length !== all.length) write(kept);
  return all.length - kept.length;
}

/** Forgotten with its project. */
export function forgetProjectActivity(workspaceId: string): void {
  const all = parseProjectActivity(projectActivitySnapshot());
  if (!all.some((event) => event.workspaceId === workspaceId)) return;
  write(all.filter((event) => event.workspaceId !== workspaceId));
}
