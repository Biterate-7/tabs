/**
 * What conversation intelligence is doing, in a form Hubble can show and a
 * person (or a support session) can read: a bounded log of structured events
 * and one live status snapshot.
 *
 * ## Never conversation text
 *
 * Events carry counts, durations, ids (`<project>:<item>`), short codes and
 * the messages of errors Hubble's own code raised — never a title, a message
 * or a quote. `data` values are numbers, booleans or short strings, and every
 * string is cut to a bound, so a careless caller can't turn the log into a
 * copy of someone's conversations.
 *
 * Warnings and errors also go to the console (`[hubble:intelligence]`), so a
 * failure is never only in memory. Info events stay in the log unless
 * `localStorage["hubble:debug-intelligence"] = "1"`.
 *
 * Runs in the page and in the embedding worker (which has its own log and
 * console); nothing here touches the DOM.
 */

export type IntelligenceEventKind = "store" | "content" | "backfill" | "extraction" | "embedding" | "model" | "search" | "reconstruct";
export type IntelligenceLevel = "info" | "warn" | "error";

export type IntelligenceEvent = {
  at: number;
  level: IntelligenceLevel;
  kind: IntelligenceEventKind;
  /** Short and stable, e.g. "run-complete", "cache-read-failed". */
  event: string;
  message?: string;
  data?: Record<string, number | boolean | string>;
};

const LOG_LIMIT = 300;
const STRING_LIMIT = 160;
const MESSAGE_LIMIT = 400;

const events: IntelligenceEvent[] = [];
const listeners = new Set<() => void>();

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function debugOn(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("hubble:debug-intelligence") === "1";
  } catch {
    return false;
  }
}

/** The error's own words, bounded — for a failure record or an event. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : typeof error === "string" ? error : "Unknown error";
  return bounded(text || "Unknown error", MESSAGE_LIMIT);
}

export function logIntelligence(input: Omit<IntelligenceEvent, "at"> & { at?: number }): IntelligenceEvent {
  const data: Record<string, number | boolean | string> | undefined = input.data
    ? Object.fromEntries(
        Object.entries(input.data)
          .filter(([, value]) => typeof value === "number" || typeof value === "boolean" || typeof value === "string")
          .map(([key, value]) => [key, typeof value === "string" ? bounded(value, STRING_LIMIT) : typeof value === "number" && !Number.isFinite(value) ? 0 : value])
      )
    : undefined;
  const event: IntelligenceEvent = {
    at: input.at ?? Date.now(),
    level: input.level,
    kind: input.kind,
    event: bounded(input.event, 60),
    ...(input.message ? { message: bounded(input.message, MESSAGE_LIMIT) } : {}),
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  };
  events.push(event);
  if (events.length > LOG_LIMIT) events.splice(0, events.length - LOG_LIMIT);
  if (event.level !== "info" || debugOn()) {
    const write = event.level === "error" ? console.error : event.level === "warn" ? console.warn : console.info;
    write(`[hubble:intelligence] ${event.kind}/${event.event}${event.message ? `: ${event.message}` : ""}`, event.data ?? "");
  }
  notify();
  return event;
}

/** Newest last. */
export function intelligenceEvents(): readonly IntelligenceEvent[] {
  return events;
}

// ── Live status ────────────────────────────────────────────────────────────

/** idle: every vector is current, so the model isn't loaded until a question needs it. */
export type ModelState = "not-requested" | "idle" | "loading" | "ready" | "unavailable";

export type IntelligenceStatus = {
  /** A processing run is going on now. */
  running: boolean;
  /** The last run's report (this session's, or the one stored by the last session). */
  report?: unknown;
  /** Where the on-device model stands; `reason` says why it isn't ready. */
  model: { state: ModelState; reason?: string; source?: string; loadMs?: number };
  /** Whether derived data survives a restart here, and the last storage error. */
  storage: { persistent: boolean; lastError?: string };
  /** Bumped on every event, so a subscriber re-reads. */
  revision: number;
};

let status: IntelligenceStatus = { running: false, model: { state: "not-requested" }, storage: { persistent: true }, revision: 0 };

function notify() {
  status = { ...status, revision: status.revision + 1 };
  for (const listener of listeners) listener();
}

export function updateIntelligenceStatus(change: Partial<Omit<IntelligenceStatus, "revision">>): void {
  status = { ...status, ...change };
  notify();
}

export function intelligenceStatus(): IntelligenceStatus {
  return status;
}

export function subscribeIntelligence(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests. */
export function resetIntelligenceDiagnosticsForTests(): void {
  events.length = 0;
  status = { running: false, model: { state: "not-requested" }, storage: { persistent: true }, revision: 0 };
}

// Readable from DevTools / a QA rig: `hubbleIntelligence.events()`, `hubbleIntelligence.status()`.
if (typeof globalThis !== "undefined" && !(globalThis as { hubbleIntelligence?: unknown }).hubbleIntelligence) {
  (globalThis as { hubbleIntelligence?: unknown }).hubbleIntelligence = { events: intelligenceEvents, status: intelligenceStatus };
}
