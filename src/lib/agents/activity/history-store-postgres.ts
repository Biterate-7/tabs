import "server-only";
import { getPool, postgresConnectionString } from "@/lib/auth/store/postgres";
import { isTerminalSessionStatus, TERMINAL_SESSION_STATUSES } from "@/lib/agents/control/session";
import { HISTORY_LIMITS, groupHistoryRecords, reviveHistoryRecord, reviveHistorySession } from "./history";
import { pageLimit } from "./history-store";
import type { Pool, PoolClient } from "pg";
import type { AgentHistoryRecord, AgentHistorySession } from "./history";
import type { AgentHistoryListOptions, AgentHistoryStore, AgentHistoryWrite } from "./history-store";

/**
 * Agent history on the shared Postgres pool (src/lib/auth/store/postgres.ts).
 *
 * Every statement names `owner_id` — and every read `workspace_id` — in its
 * predicate, the same access-control-not-access-check rule the remote and
 * credential stores follow. See ./history-store.ts for what a write may change.
 *
 * Three queries at most per operation and none per row: a page is one
 * statement, a session is two (its row, then all its records), and a write
 * is one transaction of one upsert per session plus one multi-row insert.
 */

type SessionRow = {
  id: string;
  workspace_id: string;
  provider: string;
  status: string;
  title: string | null;
  project_id: string | null;
  context_unavailable: boolean;
  truncated: boolean;
  started_at: string | number;
  last_activity_at: string | number;
  ended_at: string | number | null;
};

type RecordRow = { kind: string; data: unknown };

const SESSION_COLUMNS =
  "id, workspace_id, provider, status, title, project_id, context_unavailable, truncated, started_at, last_activity_at, ended_at";

/** BIGINT comes back as a string; epoch ms is exact as a number. Same helper as the other stores. */
const toMillis = (value: string | number) => (typeof value === "number" ? value : Number(value));

/** A row back into the domain type — through the same reviver the wire uses, so an unreadable row is dropped. */
function toSession(row: SessionRow): AgentHistorySession | null {
  return reviveHistorySession({
    sessionId: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    status: row.status,
    ...(row.title ? { title: row.title } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.context_unavailable ? { contextUnavailable: true } : {}),
    startedAt: toMillis(row.started_at),
    lastActivityAt: toMillis(row.last_activity_at),
    ...(row.ended_at !== null ? { endedAt: toMillis(row.ended_at) } : {}),
    ...(row.truncated ? { truncated: true } : {}),
  });
}

const TERMINAL = `ARRAY[${TERMINAL_SESSION_STATUSES.map((status) => `'${status}'`).join(", ")}]`;

export class PostgresAgentHistoryStore implements AgentHistoryStore {
  constructor(private readonly pool: Pool) {}

  async write(ownerId: string, batch: AgentHistoryWrite): Promise<void> {
    if (batch.sessions.length === 0 && batch.records.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const session of batch.sessions) await this.upsertSession(client, ownerId, session);

      const bySession = new Map<string, AgentHistoryWrite["records"][number][]>();
      for (const record of batch.records) {
        const list = bySession.get(record.sessionId) ?? [];
        list.push(record);
        bySession.set(record.sessionId, list);
      }
      for (const [sessionId, records] of bySession) await this.insertRecords(client, ownerId, sessionId, records);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertSession(client: PoolClient, ownerId: string, session: AgentHistorySession): Promise<void> {
    // The WHERE on the conflict arm is what keeps a session in its workspace:
    // a write naming another workspace updates nothing.
    await client.query(
      `INSERT INTO tabdump_agent_history_sessions AS s
         (owner_id, id, workspace_id, provider, status, title, project_id, context_unavailable, truncated,
          started_at, last_activity_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (owner_id, id) DO UPDATE SET
         status = CASE
           WHEN s.status = ANY(${TERMINAL}) AND NOT (EXCLUDED.status = ANY(${TERMINAL})) THEN s.status
           ELSE EXCLUDED.status END,
         title = COALESCE(EXCLUDED.title, s.title),
         project_id = COALESCE(EXCLUDED.project_id, s.project_id),
         context_unavailable = s.context_unavailable OR EXCLUDED.context_unavailable,
         truncated = s.truncated OR EXCLUDED.truncated,
         last_activity_at = GREATEST(s.last_activity_at, EXCLUDED.last_activity_at),
         ended_at = CASE
           WHEN s.status = ANY(${TERMINAL}) AND NOT (EXCLUDED.status = ANY(${TERMINAL})) THEN s.ended_at
           ELSE COALESCE(EXCLUDED.ended_at, s.ended_at) END
       WHERE s.workspace_id = EXCLUDED.workspace_id`,
      [
        ownerId,
        session.sessionId,
        session.workspaceId,
        session.provider,
        session.status,
        session.title ?? null,
        session.projectId ?? null,
        session.contextUnavailable === true,
        session.truncated === true,
        session.startedAt,
        session.lastActivityAt,
        isTerminalSessionStatus(session.status) ? (session.endedAt ?? null) : null,
      ]
    );
  }

  private async insertRecords(
    client: PoolClient,
    ownerId: string,
    sessionId: string,
    records: readonly AgentHistoryRecord[]
  ): Promise<void> {
    // Only into a session of this owner that exists; a record for any other
    // is not an error, it is simply not kept. Locked so two writers cannot
    // both see room under the event cap.
    const owner = await client.query<{ events: string }>(
      `SELECT (SELECT count(*) FROM tabdump_agent_history_records r
                WHERE r.owner_id = s.owner_id AND r.session_id = s.id AND r.kind = 'event') AS events
         FROM tabdump_agent_history_sessions s
        WHERE s.owner_id = $1 AND s.id = $2
        FOR UPDATE`,
      [ownerId, sessionId]
    );
    const row = owner.rows[0];
    if (!row) return;

    let room = HISTORY_LIMITS.eventsPerSession - Number(row.events);
    let truncated = false;
    const kept: AgentHistoryRecord[] = [];
    for (const record of records) {
      if (record.kind === "event") {
        if (room <= 0) {
          truncated = true;
          continue;
        }
        room -= 1;
      }
      kept.push(record);
    }

    if (kept.length > 0) {
      const rows = kept.map((record) => ({ kind: record.kind, record_key: record.key, at: record.at, data: record.data }));
      // One statement for the batch. Immutable on conflict, except a plan's
      // outcome, which is the runtime's latest word on that plan. An event
      // already kept still counted against `room` above, which can only make
      // the cap stricter, never looser.
      await client.query(
        `INSERT INTO tabdump_agent_history_records (owner_id, session_id, kind, record_key, at, data)
         SELECT $1, $2, r.kind, r.record_key, r.at, r.data
           FROM jsonb_to_recordset($3::jsonb) AS r(kind TEXT, record_key TEXT, at BIGINT, data JSONB)
         ON CONFLICT (owner_id, session_id, kind, record_key) DO UPDATE
           SET data = EXCLUDED.data, at = EXCLUDED.at
           WHERE tabdump_agent_history_records.kind = 'plan_outcome'`,
        [ownerId, sessionId, JSON.stringify(rows)]
      );
    }

    if (truncated) {
      await client.query(
        `UPDATE tabdump_agent_history_sessions SET truncated = TRUE WHERE owner_id = $1 AND id = $2`,
        [ownerId, sessionId]
      );
    }
  }

  async listSessions(ownerId: string, workspaceId: string, options: AgentHistoryListOptions = {}) {
    const limit = pageLimit(options.limit);
    const before = options.before;
    const result = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM tabdump_agent_history_sessions
        WHERE owner_id = $1 AND workspace_id = $2
          AND ($3::BIGINT IS NULL OR (last_activity_at, id) < ($3::BIGINT, $4::TEXT))
        ORDER BY last_activity_at DESC, id DESC
        LIMIT $5`,
      [ownerId, workspaceId, before?.lastActivityAt ?? null, before?.sessionId ?? "", limit + 1]
    );
    const all = result.rows.map(toSession);
    const sessions = all.slice(0, limit).filter((session): session is AgentHistorySession => session !== null);
    const lastRow = result.rows[Math.min(limit, result.rows.length) - 1];
    return {
      sessions,
      ...(result.rows.length > limit && lastRow
        ? { next: { lastActivityAt: toMillis(lastRow.last_activity_at), sessionId: lastRow.id } }
        : {}),
    };
  }

  async readSession(ownerId: string, workspaceId: string, sessionId: string) {
    const found = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM tabdump_agent_history_sessions
        WHERE owner_id = $1 AND workspace_id = $2 AND id = $3`,
      [ownerId, workspaceId, sessionId]
    );
    const row = found.rows[0];
    const session = row ? toSession(row) : null;
    if (!session) return undefined;

    const records = await this.pool.query<RecordRow>(
      `SELECT kind, data FROM tabdump_agent_history_records
        WHERE owner_id = $1 AND session_id = $2
        ORDER BY at, record_key`,
      [ownerId, sessionId]
    );
    const revived = records.rows
      .map((record) => reviveHistoryRecord(record.kind, record.data, session))
      .filter((record): record is AgentHistoryRecord => record !== null);
    return { session, records: groupHistoryRecords(revived) };
  }

  async hasAppliedChange(ownerId: string, workspaceId: string, sessionId: string, changeId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM tabdump_agent_history_records r
         JOIN tabdump_agent_history_sessions s ON s.owner_id = r.owner_id AND s.id = r.session_id
        WHERE r.owner_id = $1 AND s.workspace_id = $2 AND r.session_id = $3
          AND r.kind = 'change' AND r.record_key = $4 AND (r.data->>'ok')::BOOLEAN`,
      [ownerId, workspaceId, sessionId, changeId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/**
 * The Postgres store, when a database is configured *and* its tables exist.
 *
 * `undefined` otherwise — which is "history unavailable", said as such, not
 * an empty history. Checking for the table once here is what keeps an
 * unmigrated database from looking like an account with no history.
 */
export async function createPostgresAgentHistoryStore(): Promise<AgentHistoryStore | undefined> {
  const connectionString = postgresConnectionString();
  if (!connectionString) return undefined;
  return postgresAgentHistoryStoreFor(await getPool(connectionString));
}

/** The store on this pool, or `undefined` while the database has no history tables. */
export async function postgresAgentHistoryStoreFor(pool: Pool): Promise<AgentHistoryStore | undefined> {
  const found = await pool.query<{ ready: boolean }>(
    `SELECT to_regclass('public.tabdump_agent_history_records') IS NOT NULL AS ready`
  );
  return found.rows[0]?.ready ? new PostgresAgentHistoryStore(pool) : undefined;
}
