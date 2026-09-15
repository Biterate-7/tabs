import { describe, expect, it } from "vitest";
import {
  appendRunEvent,
  clearRunEvents,
  selectLatestRunEvent,
  selectRunEvents,
} from "./events";
import { createAgent } from "./registry";
import { createRun, transitionRunStatus } from "./runs";
import { getRunActivity } from "./selectors";
import { MAX_EVENTS_PER_RUN, MAX_SUMMARY_LENGTH, emptyAgentState } from "./types";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;

function seededRun(workspaceId = "w1") {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "N" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  const run = createRun(agent.state, { agentId: agent.agent.id, workspaceId }, T0);
  if (!run.ok) throw new Error("fixture failed");
  return { state: run.state, runId: run.run.id, agentId: agent.agent.id };
}

function append(
  state: AgentState,
  runId: string,
  summary: string,
  timestamp: number,
  sourceId?: string
): AgentState {
  const result = appendRunEvent(state, { runId, kind: "activity", summary, timestamp, sourceId });
  if (!result.ok) throw new Error(`append failed: ${result.reason}`);
  return result.state;
}

describe("appendRunEvent", () => {
  it("appends an event to a run", () => {
    const { state, runId } = seededRun();
    const result = appendRunEvent(state, {
      runId,
      kind: "activity",
      summary: "Edited graph-canvas.tsx",
      timestamp: T0 + 1,
    });
    if (!result.ok) throw new Error("expected success");

    expect(result.appended).toBe(true);
    expect(result.event.summary).toBe("Edited graph-canvas.tsx");
    expect(result.event.kind).toBe("activity");
    expect(result.event.timestamp).toBe(T0 + 1);
  });

  it("rejects an unknown run", () => {
    const { state } = seededRun();

    expect(
      appendRunEvent(state, { runId: "ghost", kind: "activity", summary: "x", timestamp: T0 })
    ).toEqual({ ok: false, reason: "run-not-found" });
  });

  it("rejects a blank summary and a non-finite timestamp", () => {
    const { state, runId } = seededRun();

    expect(
      appendRunEvent(state, { runId, kind: "activity", summary: "   ", timestamp: T0 })
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      appendRunEvent(state, { runId, kind: "activity", summary: "x", timestamp: Number.NaN })
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("collapses whitespace so one event stays one line", () => {
    const { state, runId } = seededRun();
    const result = appendRunEvent(state, {
      runId,
      kind: "activity",
      summary: "  Edited\n\n  two   files  ",
      timestamp: T0,
    });
    if (!result.ok) throw new Error("expected success");

    expect(result.event.summary).toBe("Edited two files");
  });

  it("truncates an oversized summary to the documented bound", () => {
    const { state, runId } = seededRun();
    const result = appendRunEvent(state, {
      runId,
      kind: "activity",
      summary: "x".repeat(MAX_SUMMARY_LENGTH * 3),
      timestamp: T0,
    });
    if (!result.ok) throw new Error("expected success");

    expect(result.event.summary).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(result.event.summary.endsWith("…")).toBe(true);
  });

  it("is allowed on a terminal run, so the ending itself can be recorded", () => {
    const { state, runId } = seededRun();
    const done = transitionRunStatus(state, runId, "completed", T0 + 10);
    if (!done.ok) throw new Error("expected success");

    const result = appendRunEvent(done.state, {
      runId,
      kind: "ended",
      summary: "Run completed",
      timestamp: T0 + 10,
    });
    if (!result.ok) throw new Error("expected success");

    expect(result.appended).toBe(true);
    expect(selectRunEvents(result.state, runId)).toHaveLength(1);
  });
});

describe("source-id deduplication", () => {
  it("appends the same sourceId only once per run", () => {
    const { state, runId } = seededRun();
    const first = appendRunEvent(state, {
      runId,
      kind: "activity",
      summary: "Edited a.ts",
      sourceId: "toolu_1",
      timestamp: T0,
    });
    if (!first.ok) throw new Error("expected success");

    const second = appendRunEvent(first.state, {
      runId,
      kind: "activity",
      summary: "Edited a.ts",
      sourceId: "toolu_1",
      timestamp: T0 + 500,
    });
    if (!second.ok) throw new Error("expected success");

    expect(second.appended).toBe(false);
    expect(second.state).toBe(first.state);
    expect(second.event.id).toBe(first.event.id);
    expect(selectRunEvents(second.state, runId)).toHaveLength(1);
  });

  it("does not dedupe across different runs", () => {
    const { state, runId, agentId } = seededRun();
    const other = createRun(state, { agentId, workspaceId: "w1" }, T0);
    if (!other.ok) throw new Error("fixture failed");

    const a = append(other.state, runId, "Edited a.ts", T0, "toolu_1");
    const b = append(a, other.run.id, "Edited a.ts", T0, "toolu_1");

    expect(selectRunEvents(b, runId)).toHaveLength(1);
    expect(selectRunEvents(b, other.run.id)).toHaveLength(1);
  });

  it("appends every event when no sourceId is supplied", () => {
    const { state, runId } = seededRun();
    const a = append(state, runId, "Same text", T0);
    const b = append(a, runId, "Same text", T0 + 1);

    expect(selectRunEvents(b, runId)).toHaveLength(2);
  });
});

describe("retention", () => {
  it(`keeps at most ${MAX_EVENTS_PER_RUN} events, discarding the oldest`, () => {
    const { state, runId } = seededRun();
    let next = state;
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 50; i += 1) {
      next = append(next, runId, `Event ${i}`, T0 + i);
    }

    const events = selectRunEvents(next, runId);
    expect(events).toHaveLength(MAX_EVENTS_PER_RUN);
    expect(events[0].summary).toBe("Event 50");
    expect(events[events.length - 1].summary).toBe(`Event ${MAX_EVENTS_PER_RUN + 49}`);
  });

  it("caps each run independently", () => {
    const { state, runId, agentId } = seededRun();
    const other = createRun(state, { agentId, workspaceId: "w1" }, T0);
    if (!other.ok) throw new Error("fixture failed");

    let next = append(other.state, other.run.id, "Sibling event", T0);
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 10; i += 1) {
      next = append(next, runId, `Event ${i}`, T0 + i);
    }

    expect(selectRunEvents(next, runId)).toHaveLength(MAX_EVENTS_PER_RUN);
    expect(selectRunEvents(next, other.run.id)).toHaveLength(1);
  });

  it("drops genuinely oldest events even when they arrive out of order", () => {
    const { state, runId } = seededRun();
    let next = state;
    for (let i = 0; i < MAX_EVENTS_PER_RUN; i += 1) {
      next = append(next, runId, `Event ${i}`, T0 + 1_000 + i);
    }
    // Arrives last, but is older than everything already stored.
    next = append(next, runId, "Ancient", T0);

    // Exactly one event is over the cap, so exactly one is dropped — and it
    // is the oldest by timestamp, not the one that arrived last.
    const summaries = selectRunEvents(next, runId).map((e) => e.summary);
    expect(summaries).toHaveLength(MAX_EVENTS_PER_RUN);
    expect(summaries).not.toContain("Ancient");
    expect(summaries).toContain("Event 0");
    expect(summaries).toContain(`Event ${MAX_EVENTS_PER_RUN - 1}`);
  });

  it("re-applies the cap defensively on read", () => {
    const { state, runId } = seededRun();
    // State this build did not write: an oversized array smuggled in directly.
    const oversized: AgentState = {
      ...state,
      events: Array.from({ length: MAX_EVENTS_PER_RUN + 25 }, (_, i) => ({
        id: `e${i}`,
        runId,
        timestamp: T0 + i,
        kind: "activity" as const,
        summary: `Event ${i}`,
      })),
    };

    expect(selectRunEvents(oversized, runId)).toHaveLength(MAX_EVENTS_PER_RUN);
  });
});

describe("ordering and reads", () => {
  it("returns events oldest first regardless of insertion order", () => {
    const { state, runId } = seededRun();
    let next = append(state, runId, "Third", T0 + 300);
    next = append(next, runId, "First", T0 + 100);
    next = append(next, runId, "Second", T0 + 200);

    expect(selectRunEvents(next, runId).map((e) => e.summary)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("reports the latest event and uses it as activity fallback", () => {
    const { state, runId } = seededRun();
    const next = append(append(state, runId, "Older", T0), runId, "Newest", T0 + 10);

    expect(selectLatestRunEvent(next, runId)?.summary).toBe("Newest");
    expect(getRunActivity(next, runId)).toBe("Newest");
  });

  it("returns nothing for a run with no events", () => {
    const { state, runId } = seededRun();

    expect(selectRunEvents(state, runId)).toEqual([]);
    expect(selectLatestRunEvent(state, runId)).toBeUndefined();
    expect(getRunActivity(state, runId)).toBeUndefined();
  });

  it("clears one run's events without touching another's", () => {
    const { state, runId, agentId } = seededRun();
    const other = createRun(state, { agentId, workspaceId: "w1" }, T0);
    if (!other.ok) throw new Error("fixture failed");

    let next = append(other.state, runId, "Mine", T0);
    next = append(next, other.run.id, "Theirs", T0);

    const cleared = clearRunEvents(next, runId);
    expect(selectRunEvents(cleared, runId)).toEqual([]);
    expect(selectRunEvents(cleared, other.run.id)).toHaveLength(1);
  });
});
