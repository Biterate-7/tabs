import { isTerminalSessionStatus } from "@/lib/agents/control/session";
import { handoffLinksOf, isFinalHandoffStatus } from "@/lib/agents/handoff/handoff";
import { HISTORY_LIMITS, groupHistoryRecords } from "./history";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type {
  AgentHistoryCursor,
  AgentHistoryDetail,
  AgentHistoryPage,
  AgentHistoryRecord,
  AgentHistorySession,
} from "./history";

/**
 * Where agent history is kept.
 *
 * The same shape every durable Hubble store has (remote/store.ts,
 * credentials/store.ts, mcp/tokens.ts): an interface, an in-memory
 * implementation for tests, and a Postgres one (./history-store-postgres.ts)
 * on the shared pool.
 *
 * ## Ownership and workspace are query predicates, not checks
 *
 * Every read takes the owner (the runtime actor: `account:<id>`, or `local`)
 * *and* the workspace, and both are part of the lookup. There is no
 * `readSession(sessionId)`: a session of another account, or of another
 * workspace of the same account, does not come back, and is
 * indistinguishable from one that never existed.
 *
 * ## What a write may and may not change
 *
 * A session's workspace, provider and start never change once recorded — a
 * write naming another workspace for a recorded session is ignored, so no
 * write can move history between workspaces. Its status, title and last
 * activity move forward, and a terminal status is never replaced by a live
 * one (a replay of an earlier moment cannot reopen a session that ended).
 *
 * Records are immutable once written: the same key again writes nothing.
 * That is what makes a replay free, and what keeps an action exactly as it
 * happened — an undo is a new `undo` record, never an edit of the change.
 * The one exception is a plan's outcome, which is the runtime's latest word
 * on that plan.
 *
 * ## Handoffs (Hubble 1.4)
 *
 * A handoff is its own row, joining a source session to a target session by
 * id — the relationship is stored, never inferred. It is kept only once it
 * ended (`ready` or `failed`), only for a source session of this owner in
 * the handoff's own workspace, and only once: a handoff does not change
 * after it ends. Reading a session returns the handoffs naming it as source
 * or target, in its workspace; listing attaches each session's links.
 */

export type AgentHistoryRecordInput = AgentHistoryRecord & { sessionId: string };

export type AgentHistoryWrite = {
  sessions: readonly AgentHistorySession[];
  /** Kept only for sessions of this owner that exist (in this batch or before it). */
  records: readonly AgentHistoryRecordInput[];
  /** Ended handoffs whose source session is this owner's, in the handoff's workspace. Written once. */
  handoffs?: readonly SessionHandoff[];
};

export type AgentHistoryListOptions = { before?: AgentHistoryCursor; limit?: number };

export type AgentHistoryStore = {
  /** Applies one batch, sessions first. Owner-scoped by signature. */
  write(ownerId: string, batch: AgentHistoryWrite): Promise<void>;

  /** One page of this owner's sessions in this workspace, newest activity first. */
  listSessions(ownerId: string, workspaceId: string, options?: AgentHistoryListOptions): Promise<AgentHistoryPage>;

  /** One session with every record it kept — or nothing, for a session not this owner's in this workspace. */
  readSession(ownerId: string, workspaceId: string, sessionId: string): Promise<AgentHistoryDetail | undefined>;

  /** Whether this owner's session in this workspace recorded this change as applied. */
  hasAppliedChange(ownerId: string, workspaceId: string, sessionId: string, changeId: string): Promise<boolean>;
};

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return HISTORY_LIMITS.pageSize;
  return Math.min(limit, HISTORY_LIMITS.maxPageSize);
}

/** The session a write leaves behind, given what was there. See the note above. */
export function mergeHistorySession(existing: AgentHistorySession | undefined, next: AgentHistorySession): AgentHistorySession | undefined {
  if (!existing) return next;
  if (existing.workspaceId !== next.workspaceId) return undefined;
  const keepEnded = isTerminalSessionStatus(existing.status) && !isTerminalSessionStatus(next.status);
  const title = next.title ?? existing.title;
  const projectId = next.projectId ?? existing.projectId;
  const endedAt = keepEnded ? existing.endedAt : (next.endedAt ?? existing.endedAt);
  return {
    sessionId: existing.sessionId,
    workspaceId: existing.workspaceId,
    provider: existing.provider,
    status: keepEnded ? existing.status : next.status,
    ...(title ? { title } : {}),
    ...(projectId ? { projectId } : {}),
    ...(existing.contextUnavailable || next.contextUnavailable ? { contextUnavailable: true } : {}),
    startedAt: existing.startedAt,
    lastActivityAt: Math.max(existing.lastActivityAt, next.lastActivityAt),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(existing.truncated || next.truncated ? { truncated: true } : {}),
  };
}

/** Newest first, ties broken by id — the order the cursor walks. */
export function compareHistorySessions(a: AgentHistorySession, b: AgentHistorySession): number {
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  return a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0;
}

/** Whether a handoff may be kept for this source session: ended, and in the source's own workspace. */
export function isKeepableHandoff(handoff: SessionHandoff, source: AgentHistorySession | undefined): boolean {
  if (!source || source.sessionId !== handoff.sourceSessionId || source.workspaceId !== handoff.workspaceId) return false;
  return isFinalHandoffStatus(handoff.status) && handoff.status !== "cancelled";
}

/** For tests, and for a runtime that wants history within one process only. Nothing here survives the process. */
export function createMemoryAgentHistoryStore(): AgentHistoryStore {
  const sessions = new Map<string, AgentHistorySession>();
  const records = new Map<string, Map<string, AgentHistoryRecord>>();
  const handoffs = new Map<string, SessionHandoff>();
  const key = (ownerId: string, sessionId: string) => `${ownerId}\u0000${sessionId}`;
  const handoffsOf = (ownerId: string, workspaceId: string, sessionId: string) =>
    [...handoffs.entries()]
      .filter(([id, handoff]) => id.startsWith(`${ownerId}\u0000`) && handoff.workspaceId === workspaceId)
      .map(([, handoff]) => handoff)
      .filter((handoff) => handoff.sourceSessionId === sessionId || handoff.targetSessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  const withLinks = (ownerId: string, session: AgentHistorySession): AgentHistorySession => {
    const links = handoffLinksOf(session.sessionId, handoffsOf(ownerId, session.workspaceId, session.sessionId));
    return links ? { ...session, handoff: links } : session;
  };

  return {
    async write(ownerId, batch) {
      for (const session of batch.sessions) {
        const id = key(ownerId, session.sessionId);
        const merged = mergeHistorySession(sessions.get(id), structuredClone(session));
        if (merged) sessions.set(id, merged);
      }
      for (const input of batch.records) {
        const id = key(ownerId, input.sessionId);
        const session = sessions.get(id);
        if (!session) continue;
        const held = records.get(id) ?? new Map<string, AgentHistoryRecord>();
        records.set(id, held);
        const recordKey = `${input.kind}\u0000${input.key}`;
        if (held.has(recordKey) && input.kind !== "plan_outcome") continue;
        if (input.kind === "event" && !held.has(recordKey)) {
          const events = [...held.values()].filter((record) => record.kind === "event").length;
          if (events >= HISTORY_LIMITS.eventsPerSession) {
            sessions.set(id, { ...session, truncated: true });
            continue;
          }
        }
        const { sessionId: _unused, ...record } = input
        void _unused;
        held.set(recordKey, structuredClone(record) as AgentHistoryRecord);
      }
      for (const handoff of batch.handoffs ?? []) {
        const id = key(ownerId, handoff.handoffId);
        if (handoffs.has(id)) continue;
        if (!isKeepableHandoff(handoff, sessions.get(key(ownerId, handoff.sourceSessionId)))) continue;
        handoffs.set(id, structuredClone(handoff));
      }
    },

    async listSessions(ownerId, workspaceId, options = {}) {
      const limit = pageLimit(options.limit);
      const before = options.before;
      const mine = [...sessions.entries()]
        .filter(([id, session]) => id.startsWith(`${ownerId}\u0000`) && session.workspaceId === workspaceId)
        .map(([, session]) => session)
        .filter((session) =>
          !before ||
          session.lastActivityAt < before.lastActivityAt ||
          (session.lastActivityAt === before.lastActivityAt && session.sessionId < before.sessionId)
        )
        .sort(compareHistorySessions);
      const page = mine.slice(0, limit).map((session) => structuredClone(withLinks(ownerId, session)));
      const last = page[page.length - 1];
      return {
        sessions: page,
        ...(mine.length > limit && last ? { next: { lastActivityAt: last.lastActivityAt, sessionId: last.sessionId } } : {}),
      };
    },

    async readSession(ownerId, workspaceId, sessionId) {
      const id = key(ownerId, sessionId);
      const session = sessions.get(id);
      if (!session || session.workspaceId !== workspaceId) return undefined;
      const grouped = groupHistoryRecords(structuredClone([...(records.get(id)?.values() ?? [])]));
      const related = handoffsOf(ownerId, workspaceId, sessionId);
      return {
        session: structuredClone(withLinks(ownerId, session)),
        records: related.length > 0 ? { ...grouped, handoffs: structuredClone(related) } : grouped,
      };
    },

    async hasAppliedChange(ownerId, workspaceId, sessionId, changeId) {
      const id = key(ownerId, sessionId);
      if (sessions.get(id)?.workspaceId !== workspaceId) return false;
      const record = records.get(id)?.get(`change\u0000${changeId}`);
      return record?.kind === "change" && record.data.ok;
    },
  };
}
