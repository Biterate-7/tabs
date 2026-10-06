import { beforeEach, expect, it } from "vitest";
import { HISTORY_LIMITS, eventRecordKey } from "./history";
import type { AgentHistoryRecord, AgentHistorySession } from "./history";
import type { AgentHistoryStore } from "./history-store";
import type { SequencedControlEvent } from "@/lib/agents/runtime/protocol";

/**
 * The one contract every agent history store keeps — run against the memory
 * store (history-store.test.ts) and against real PostgreSQL
 * (history-store.pg.test.ts), so the two cannot drift apart on isolation,
 * immutability or paging.
 */

export const T0 = 1_700_000_000_000;
const ALICE = "account:alice";
const BOB = "account:bob";

export function historySession(over: Partial<AgentHistorySession> = {}): AgentHistorySession {
  return {
    sessionId: "s1",
    workspaceId: "w-a",
    provider: "claude-code",
    status: "running",
    startedAt: T0,
    lastActivityAt: T0 + 1_000,
    ...over,
  };
}

export function eventRecord(sequence: number, sessionId = "s1"): AgentHistoryRecord {
  const event: SequencedControlEvent = {
    id: `e${sequence}`,
    sessionId,
    provider: "claude-code",
    kind: "context_read",
    timestamp: T0 + sequence,
    summary: "",
    sequence,
    context: { workspaceId: "w-a", operation: "search_tabs", ok: true, matches: sequence },
  };
  return { kind: "event", key: eventRecordKey(event), at: event.timestamp, data: event };
}

function changeRecord(id: string, ok = true): AgentHistoryRecord {
  return {
    kind: "change",
    key: id,
    at: T0 + 5_000,
    data: {
      id,
      sessionId: "s1",
      provider: "claude-code",
      workspaceId: "w-a",
      at: T0 + 5_000,
      ok,
      steps: ok ? [{ kind: "created", collectionId: "c9", name: "Pricing", tabCount: 2 }] : [],
    },
  };
}

export function historyStoreContract(makeStore: () => Promise<AgentHistoryStore>): void {
  let store: AgentHistoryStore;
  beforeEach(async () => {
    store = await makeStore();
  });

  it("records a session and its activity, and reads them back in order", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [{ ...eventRecord(2), sessionId: "s1" }, { ...eventRecord(1), sessionId: "s1" }] });
    const detail = await store.readSession(ALICE, "w-a", "s1");
    expect(detail?.session).toEqual(historySession());
    expect(detail?.records.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("moves a session forward — status, last activity, its end — and never back", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [] });
    await store.write(ALICE, { sessions: [historySession({ status: "completed", lastActivityAt: T0 + 9_000, endedAt: T0 + 9_000, title: "Done" })], records: [] });
    // A replay of an earlier moment cannot reopen it, or rewind its activity.
    await store.write(ALICE, { sessions: [historySession({ status: "running", lastActivityAt: T0 + 2_000 })], records: [] });
    expect((await store.readSession(ALICE, "w-a", "s1"))?.session).toEqual(
      historySession({ status: "completed", lastActivityAt: T0 + 9_000, endedAt: T0 + 9_000, title: "Done" })
    );
  });

  it("records failed and disconnected sessions as they ended", async () => {
    await store.write(ALICE, {
      sessions: [
        historySession({ sessionId: "f", status: "failed", endedAt: T0 + 3_000 }),
        historySession({ sessionId: "d", status: "disconnected", endedAt: T0 + 4_000 }),
      ],
      records: [],
    });
    expect((await store.readSession(ALICE, "w-a", "f"))?.session.status).toBe("failed");
    expect((await store.readSession(ALICE, "w-a", "d"))?.session).toMatchObject({ status: "disconnected", endedAt: T0 + 4_000 });
  });

  it("never moves a session to another workspace", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [] });
    await store.write(ALICE, { sessions: [historySession({ workspaceId: "w-b", status: "completed" })], records: [] });
    expect(await store.readSession(ALICE, "w-b", "s1")).toBeUndefined();
    expect((await store.readSession(ALICE, "w-a", "s1"))?.session.status).toBe("running");
  });

  it("keeps a record exactly as first written", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [{ ...changeRecord("ctxa-1"), sessionId: "s1" }] });
    const rewritten = changeRecord("ctxa-1");
    (rewritten.data as unknown as { steps: unknown[] }).steps = [];
    await store.write(ALICE, { sessions: [], records: [{ ...rewritten, sessionId: "s1" }] });
    expect((await store.readSession(ALICE, "w-a", "s1"))?.records.changes[0]?.steps).toHaveLength(1);
  });

  it("keeps an undo as its own record, after the change", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [{ ...changeRecord("ctxa-1"), sessionId: "s1" }] });
    expect(await store.hasAppliedChange(ALICE, "w-a", "s1", "ctxa-1")).toBe(true);
    await store.write(ALICE, { sessions: [], records: [{ sessionId: "s1", kind: "undo", key: "ctxa-1", at: T0 + 6_000, data: { changeId: "ctxa-1", at: T0 + 6_000 } }] });
    const detail = await store.readSession(ALICE, "w-a", "s1");
    expect(detail?.records.undos).toEqual([{ changeId: "ctxa-1", at: T0 + 6_000 }]);
    expect(detail?.records.changes[0]).toEqual(changeRecord("ctxa-1").data);
  });

  it("knows only applied changes, of this owner's session, in this workspace", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [{ ...changeRecord("ok"), sessionId: "s1" }, { ...changeRecord("failed", false), sessionId: "s1" }] });
    expect(await store.hasAppliedChange(ALICE, "w-a", "s1", "ok")).toBe(true);
    expect(await store.hasAppliedChange(ALICE, "w-a", "s1", "failed")).toBe(false);
    expect(await store.hasAppliedChange(ALICE, "w-b", "s1", "ok")).toBe(false);
    expect(await store.hasAppliedChange(BOB, "w-a", "s1", "ok")).toBe(false);
  });

  it("keeps a record only for a session of this owner that exists", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [] });
    await store.write(BOB, { sessions: [], records: [{ ...eventRecord(1), sessionId: "s1" }] });
    await store.write(ALICE, { sessions: [], records: [{ ...eventRecord(1, "nobody"), sessionId: "nobody" }] });
    expect((await store.readSession(ALICE, "w-a", "s1"))?.records.events).toEqual([]);
  });

  it("isolates workspaces: workspace A never sees workspace B's sessions or activity", async () => {
    await store.write(ALICE, {
      sessions: [historySession({ sessionId: "in-a" }), historySession({ sessionId: "in-b", workspaceId: "w-b" })],
      records: [{ ...eventRecord(1, "in-a"), sessionId: "in-a" }],
    });
    expect((await store.listSessions(ALICE, "w-a")).sessions.map((session) => session.sessionId)).toEqual(["in-a"]);
    expect((await store.listSessions(ALICE, "w-b")).sessions.map((session) => session.sessionId)).toEqual(["in-b"]);
    expect(await store.readSession(ALICE, "w-b", "in-a")).toBeUndefined();
    expect(await store.readSession(ALICE, "w-a", "in-b")).toBeUndefined();
  });

  it("isolates accounts: user A never sees user B's history", async () => {
    await store.write(ALICE, { sessions: [historySession({ sessionId: "alice" })], records: [] });
    await store.write(BOB, { sessions: [historySession({ sessionId: "bob" })], records: [] });
    expect((await store.listSessions(ALICE, "w-a")).sessions.map((session) => session.sessionId)).toEqual(["alice"]);
    expect((await store.listSessions(BOB, "w-a")).sessions.map((session) => session.sessionId)).toEqual(["bob"]);
    expect(await store.readSession(BOB, "w-a", "alice")).toBeUndefined();
  });

  it("pages newest first, with a cursor that never repeats or skips a session", async () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      // Two share a last activity, so the tie-break is exercised.
      historySession({ sessionId: `s-${index}`, lastActivityAt: T0 + (index === 6 ? 5 : index) * 1_000 })
    );
    await store.write(ALICE, { sessions, records: [] });
    const seen: string[] = [];
    let page = await store.listSessions(ALICE, "w-a", { limit: 3 });
    seen.push(...page.sessions.map((session) => session.sessionId));
    while (page.next) {
      page = await store.listSessions(ALICE, "w-a", { limit: 3, before: page.next });
      seen.push(...page.sessions.map((session) => session.sessionId));
    }
    expect(seen).toEqual(["s-6", "s-5", "s-4", "s-3", "s-2", "s-1", "s-0"]);
  });

  it("is empty — not failing — for a workspace with no history", async () => {
    expect(await store.listSessions(ALICE, "w-empty")).toEqual({ sessions: [] });
    expect(await store.readSession(ALICE, "w-empty", "s1")).toBeUndefined();
  });

  it("stops keeping events at the cap, and says so", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [] });
    const all = Array.from({ length: HISTORY_LIMITS.eventsPerSession + 5 }, (_, index) => ({ ...eventRecord(index + 1), sessionId: "s1" }));
    await store.write(ALICE, { sessions: [], records: all });
    const detail = await store.readSession(ALICE, "w-a", "s1");
    expect(detail?.records.events).toHaveLength(HISTORY_LIMITS.eventsPerSession);
    expect(detail?.records.events.at(-1)?.sequence).toBe(HISTORY_LIMITS.eventsPerSession);
    expect(detail?.session.truncated).toBe(true);
  });

  it("writes nothing twice: a replayed event is the same record", async () => {
    await store.write(ALICE, { sessions: [historySession()], records: [{ ...eventRecord(1), sessionId: "s1" }] });
    await store.write(ALICE, { sessions: [], records: [{ ...eventRecord(1), sessionId: "s1" }, { ...eventRecord(1), sessionId: "s1" }] });
    expect((await store.readSession(ALICE, "w-a", "s1"))?.records.events).toHaveLength(1);
  });
}
