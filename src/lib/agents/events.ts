import { createId } from "@/lib/id";
import { findRun } from "./runs";
import { MAX_EVENTS_PER_RUN, agentFailure, normalizeSummary } from "./types";
import type { AgentEvent, AgentEventKind, AgentFailure, AgentState } from "./types";

/**
 * A run's activity log.
 *
 * Bounded in three directions on purpose: how many events a run may keep
 * (MAX_EVENTS_PER_RUN), how long one summary may be (MAX_SUMMARY_LENGTH,
 * applied by normalizeSummary), and what an event may say at all (a closed
 * set of kinds plus a plain string). There is nowhere here to put a prompt, a
 * tool result, a shell command or a model's reasoning, and that absence is
 * the design — a provider reduces its records to a safe summary before
 * calling this, and the domain has no field that would accept the raw thing.
 */

export type AppendRunEventInput = {
  runId: string;
  kind: AgentEventKind;
  summary: string;
  /** Provider-stable id of the source record, used to make appends idempotent. */
  sourceId?: string;
  timestamp: number;
};

export type AppendRunEventResult =
  | { ok: true; state: AgentState; event: AgentEvent; appended: boolean }
  | AgentFailure;

/**
 * Appends one event to a run.
 *
 * Deliberately permitted on a terminal run. The event that records a run
 * ending is itself appended after the status change, and a log is a record of
 * what happened rather than a live control surface — refusing writes to a
 * finished run's history would make the completion event unrepresentable.
 *
 * When `sourceId` is supplied and an event with that id already exists on
 * this run, nothing is appended and `appended: false` comes back with the
 * event that was already there. This is what lets a poller re-read the same
 * source records without duplicating history.
 */
export function appendRunEvent(state: AgentState, input: AppendRunEventInput): AppendRunEventResult {
  if (!findRun(state, input.runId)) return agentFailure("run-not-found");

  const summary = normalizeSummary(input.summary);
  if (!summary) return agentFailure("invalid-input");
  if (!Number.isFinite(input.timestamp)) return agentFailure("invalid-input");

  const sourceId = input.sourceId?.trim();
  if (sourceId) {
    const already = state.events.find(
      (event) => event.runId === input.runId && event.sourceId === sourceId
    );
    if (already) return { ok: true, state, event: already, appended: false };
  }

  const event: AgentEvent = {
    id: createId(),
    runId: input.runId,
    timestamp: input.timestamp,
    kind: input.kind,
    summary,
  };
  if (sourceId) event.sourceId = sourceId;

  return {
    ok: true,
    state: { ...state, events: capRunEvents([...state.events, event], input.runId) },
    event,
    appended: true,
  };
}

/**
 * Trims one run's events down to MAX_EVENTS_PER_RUN, keeping the newest.
 *
 * Ordered by timestamp, with insertion order breaking ties, so that a
 * provider delivering slightly out-of-order timestamps still drops genuinely
 * old events rather than whichever happened to arrive first. Events belonging
 * to other runs are returned untouched and in their original positions.
 */
function capRunEvents(events: AgentEvent[], runId: string): AgentEvent[] {
  const indices: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].runId === runId) indices.push(i);
  }
  if (indices.length <= MAX_EVENTS_PER_RUN) return events;

  const doomed = new Set(
    indices
      .slice()
      .sort((a, b) => events[a].timestamp - events[b].timestamp || a - b)
      .slice(0, indices.length - MAX_EVENTS_PER_RUN)
  );

  return events.filter((_, index) => !doomed.has(index));
}

/**
 * Every event for a run, oldest first, defensively re-capped.
 *
 * The cap is applied on read as well as on write because persisted state is
 * not necessarily state this build wrote — a file hand-edited, restored from
 * a backup, or written by an older build with a larger cap would otherwise
 * hand an unbounded array straight to a consumer.
 */
export function selectRunEvents(state: AgentState, runId: string): AgentEvent[] {
  const mine = state.events.filter((event) => event.runId === runId);
  mine.sort((a, b) => a.timestamp - b.timestamp);
  return mine.length > MAX_EVENTS_PER_RUN ? mine.slice(mine.length - MAX_EVENTS_PER_RUN) : mine;
}

/** The most recent event for a run, or undefined if it has none. */
export function selectLatestRunEvent(state: AgentState, runId: string): AgentEvent | undefined {
  const events = selectRunEvents(state, runId);
  return events[events.length - 1];
}

/** Drops every event belonging to a run, leaving the run itself in place. */
export function clearRunEvents(state: AgentState, runId: string): AgentState {
  const kept = state.events.filter((event) => event.runId !== runId);
  return kept.length === state.events.length ? state : { ...state, events: kept };
}
