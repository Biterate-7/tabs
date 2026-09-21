import { describe, expect, it } from "vitest";
import { createEventJournal } from "./journal";
import type { AgentControlEvent, AgentControlEventKind } from "@/lib/agents/control/events";

const T0 = 1_700_000_000_000;

function event(
  over: Partial<AgentControlEvent> & { sessionId: string; kind: AgentControlEventKind }
): AgentControlEvent {
  return {
    id: over.id ?? `e-${Math.random().toString(36).slice(2)}`,
    provider: "claude-code",
    timestamp: T0,
    summary: "event",
    ...over,
  } as AgentControlEvent;
}

describe("ordering", () => {
  it("numbers events in the order the runtime received them, per session", () => {
    const journal = createEventJournal();

    journal.append(event({ id: "a", sessionId: "s1", kind: "message_sent" }));
    journal.append(event({ id: "b", sessionId: "s2", kind: "message_sent" }));
    journal.append(event({ id: "c", sessionId: "s1", kind: "message_received" }));

    expect(journal.read("s1").events.map((e) => [e.id, e.sequence])).toEqual([
      ["a", 1],
      ["c", 2],
    ]);
    // Sequences are per session, not global. Two sessions both start at 1, so
    // a client reading one never has gaps caused by another's traffic.
    expect(journal.read("s2").events.map((e) => [e.id, e.sequence])).toEqual([["b", 1]]);
  });

  it("orders events that share a timestamp", () => {
    // The case a timestamp sort gets wrong. Three events normalized from one
    // provider message all read the same clock; only arrival order is real.
    const journal = createEventJournal();

    for (const id of ["tool_started", "tool_finished", "message_received"]) {
      journal.append(
        event({
          id,
          sessionId: "s1",
          kind: id === "message_received" ? "message_received" : (id as AgentControlEventKind),
          timestamp: T0,
          ...(id.startsWith("tool") ? { tool: { name: "Read" } } : {}),
        })
      );
    }

    expect(journal.read("s1").events.map((e) => e.id)).toEqual([
      "tool_started",
      "tool_finished",
      "message_received",
    ]);
  });

  it("preserves a realistic asynchronous run in the order it arrived", () => {
    const journal = createEventJournal();
    const arrivals: [string, AgentControlEventKind][] = [
      ["m1", "message_sent"],
      ["t1", "thinking"],
      ["c1", "tool_started"],
      ["c2", "tool_finished"],
      ["r1", "message_received"],
      ["done", "run_completed"],
    ];

    for (const [id, kind] of arrivals) {
      journal.append(
        event({
          id,
          sessionId: "s1",
          kind,
          // Deliberately out of order and sometimes equal. Timestamps must not
          // be what decides.
          timestamp: T0 + (id === "c2" ? -50 : 0),
          ...(kind === "tool_started" || kind === "tool_finished"
            ? { tool: { name: "Bash" } }
            : {}),
        })
      );
    }

    expect(journal.read("s1").events.map((e) => e.id)).toEqual([
      "m1",
      "t1",
      "c1",
      "c2",
      "r1",
      "done",
    ]);
  });
});

describe("cursors", () => {
  it("returns only what a client has not seen", () => {
    const journal = createEventJournal();
    for (const id of ["a", "b", "c"]) {
      journal.append(event({ id, sessionId: "s1", kind: "thinking" }));
    }

    expect(journal.read("s1", 1).events.map((e) => e.id)).toEqual(["b", "c"]);
    expect(journal.read("s1", 3).events).toEqual([]);
    expect(journal.read("s1", 3).latestSequence).toBe(3);
  });

  it("answers for a session it has never seen without inventing one", () => {
    const journal = createEventJournal();
    expect(journal.read("nobody")).toMatchObject({ events: [], latestSequence: 0 });
    expect(journal.latestSequence("nobody")).toBe(0);
  });
});

describe("idempotency", () => {
  it("drops a replayed event rather than renumbering it", () => {
    // A reconnecting adapter can re-emit. A second `run_completed` must not
    // reach a listener, or a run ends twice.
    const journal = createEventJournal();
    const replayed = event({ id: "done", sessionId: "s1", kind: "run_completed" });

    expect(journal.append(replayed).accepted).toBe(true);
    expect(journal.append(replayed)).toEqual({ accepted: false, reason: "duplicate" });
    expect(journal.read("s1").events).toHaveLength(1);
  });

  it("deduplicates on the provider's own id when it has one", () => {
    // Two events the adapter minted separately — different `id` — that
    // describe the same provider record. The provider id is the stronger
    // identity and is what decides.
    const journal = createEventJournal();

    journal.append(
      event({ id: "local-1", sessionId: "s1", kind: "thinking", sourceId: "prov-9" })
    );
    const second = journal.append(
      event({ id: "local-2", sessionId: "s1", kind: "thinking", sourceId: "prov-9" })
    );

    expect(second.accepted).toBe(false);
    expect(journal.read("s1").events).toHaveLength(1);
  });

  it("does not confuse two providers' identically numbered records", () => {
    const journal = createEventJournal();

    journal.append(
      event({ id: "a", sessionId: "s1", kind: "thinking", sourceId: "1", provider: "claude-code" })
    );
    const other = journal.append(
      event({ id: "b", sessionId: "s1", kind: "thinking", sourceId: "1", provider: "openai-codex" })
    );

    expect(other.accepted).toBe(true);
  });

  it("does not deduplicate an approval a second, genuinely different request", () => {
    const journal = createEventJournal();

    expect(
      journal.append(
        event({ id: "ap1", sessionId: "s1", kind: "approval_requested", approvalId: "a1" })
      ).accepted
    ).toBe(true);
    expect(
      journal.append(
        event({ id: "ap2", sessionId: "s1", kind: "approval_requested", approvalId: "a2" })
      ).accepted
    ).toBe(true);
  });
});

describe("bounds", () => {
  it("drops the oldest events and says that it did", () => {
    const journal = createEventJournal({ maxEventsPerSession: 3 });

    for (const id of ["a", "b", "c", "d", "e"]) {
      journal.append(event({ id, sessionId: "s1", kind: "thinking" }));
    }

    const read = journal.read("s1");
    expect(read.events.map((e) => e.id)).toEqual(["c", "d", "e"]);
    // The gap is reported rather than hidden. A client whose cursor is below
    // `oldestSequence` has missed events and can be told so.
    expect(read.truncated).toBe(true);
    expect(read.oldestSequence).toBe(3);
    expect(read.latestSequence).toBe(5);
  });

  it("keeps sequences monotonic across a truncation", () => {
    const journal = createEventJournal({ maxEventsPerSession: 2 });
    for (const id of ["a", "b", "c"]) {
      journal.append(event({ id, sessionId: "s1", kind: "thinking" }));
    }

    expect(journal.read("s1").events.map((e) => e.sequence)).toEqual([2, 3]);
  });

  it("evicts the least recently used session, never the busy one", () => {
    const journal = createEventJournal({ maxSessions: 2 });

    journal.append(event({ sessionId: "old", kind: "thinking" }));
    journal.append(event({ sessionId: "busy", kind: "thinking" }));
    journal.append(event({ sessionId: "busy", kind: "thinking" }));
    journal.append(event({ sessionId: "new", kind: "thinking" }));

    expect(journal.read("old").events).toEqual([]);
    expect(journal.read("busy").events).toHaveLength(2);
    expect(journal.read("new").events).toHaveLength(1);
  });

  it("forgets one session without touching another", () => {
    const journal = createEventJournal();
    journal.append(event({ sessionId: "s1", kind: "thinking" }));
    journal.append(event({ sessionId: "s2", kind: "thinking" }));

    journal.forget("s1");

    expect(journal.read("s1").events).toEqual([]);
    expect(journal.read("s2").events).toHaveLength(1);
  });
});
