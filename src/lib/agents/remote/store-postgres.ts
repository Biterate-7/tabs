import "server-only";
import { getPool, postgresConnectionString } from "@/lib/auth/store/postgres";
import { liveStatuses } from "./store";
import { isAgentPermissionScope } from "@/lib/agents/control/permissions";
import { isRemoteSandboxStatus } from "./types";
import type { Pool, QueryResultRow } from "pg";
import type { ExpiredSandbox, RemoteStore } from "./store";
import type { RemoteProject, RemoteSession } from "./types";

/**
 * The durable remote store.
 *
 * Shares the auth layer's pool rather than opening a second one — `getPool`
 * is exported for exactly this, and two pools against the same database would
 * double an instance's connection footprint for no benefit. The reasoning
 * about `max` over there assumes one pool, and this keeps that true.
 *
 * ## Ownership lives in the WHERE clause
 *
 * Every statement that reads or writes a row names `owner_id` in its
 * predicate. Not fetched-then-checked: a row belonging to someone else does
 * not come back, is not counted, and is not updated, and there is no code
 * path here that holds one long enough to leak it into a log line. That is
 * the difference between an access check and an access *control*, and it is
 * why `findProject(id)` — the shape that invites a forgotten check at a new
 * call site — does not exist on the interface at all.
 */

/**
 * Epoch-millisecond columns come back from `pg` as strings, because BIGINT
 * exceeds what a JS number can hold in general. Epoch ms does not, so
 * `Number()` is lossless for every value this schema can hold. Same helper,
 * same reasoning as the auth store's.
 */
function toMillis(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  source: string;
  sandbox_name: string;
  scopes: string[] | null;
  status: string;
  expires_at: string | number | null;
  created_at: string | number;
  updated_at: string | number;
};

type SessionRow = {
  id: string;
  owner_id: string;
  project_id: string;
  provider: string;
  sandbox_name: string;
  command_id: string | null;
  provider_session_id: string | null;
  created_at: string | number;
  updated_at: string | number;
};

const PROJECT_COLUMNS =
  "id, owner_id, name, source, sandbox_name, scopes, status, expires_at, created_at, updated_at";
const SESSION_COLUMNS =
  "id, owner_id, project_id, provider, sandbox_name, command_id, provider_session_id, created_at, updated_at";

/**
 * Reads a row into the domain type, refusing anything it cannot read.
 *
 * A `status` the code does not recognise is treated as `failed` rather than
 * passed through. A database that has been written to by a newer version of
 * this code, or by hand, must not be able to put a value into the lifecycle
 * that `isDispatchableStatus` has never seen — because the fail-open reading
 * of an unknown status is "sure, dispatch into it".
 */
function toProject(row: ProjectRow): RemoteProject {
  const source = row.source === "remote_git" ? "remote_git" : "remote_upload";
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    source,
    sandboxName: row.sandbox_name,
    // Narrowed on read. A scope this build does not know about is not one it
    // can enforce, so it is dropped rather than carried as an opaque string.
    scopes: (row.scopes ?? []).filter(isAgentPermissionScope),
    status: isRemoteSandboxStatus(row.status) ? row.status : "failed",
    ...(row.expires_at === null ? {} : { expiresAt: toMillis(row.expires_at) }),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function toSession(row: SessionRow): RemoteSession {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    // Narrowed on read rather than asserted: the column is TEXT, and a
    // provider this build does not know about is not one it can drive.
    provider: row.provider as RemoteSession["provider"],
    sandboxName: row.sandbox_name,
    ...(row.command_id ? { commandId: row.command_id } : {}),
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class PostgresRemoteStore implements RemoteStore {
  constructor(private readonly pool: Pool) {}

  private async query<R extends QueryResultRow>(text: string, values: unknown[]): Promise<R[]> {
    const result = await this.pool.query<R>(text, values);
    return result.rows;
  }

  /* -------------------------------------------------------------- *
   * Projects
   * -------------------------------------------------------------- */

  async createProject(project: RemoteProject): Promise<void> {
    await this.query(
      `INSERT INTO tabdump_remote_projects
         (id, owner_id, name, source, sandbox_name, scopes, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        project.id,
        project.ownerId,
        project.name,
        project.source,
        project.sandboxName,
        [...project.scopes],
        project.status,
        project.expiresAt ?? null,
        project.createdAt,
      ]
    );
  }

  async findProject(ownerId: string, projectId: string): Promise<RemoteProject | undefined> {
    const rows = await this.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM tabdump_remote_projects WHERE id = $1 AND owner_id = $2`,
      [projectId, ownerId]
    );
    return rows[0] ? toProject(rows[0]) : undefined;
  }

  async listProjects(ownerId: string): Promise<RemoteProject[]> {
    const rows = await this.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM tabdump_remote_projects
        WHERE owner_id = $1
        ORDER BY created_at DESC`,
      [ownerId]
    );
    return rows.map(toProject);
  }

  async updateProject(
    ownerId: string,
    projectId: string,
    patch: Partial<Pick<RemoteProject, "status" | "expiresAt" | "sandboxName">>,
    now: number
  ): Promise<RemoteProject | undefined> {
    // COALESCE keeps this one statement for every shape of patch: a field the
    // caller did not mention is written back unchanged rather than nulled.
    // Spreading an optional into an UPDATE is the same bug as spreading it
    // into an object, and here it would clear the handle on a live sandbox.
    const rows = await this.query<ProjectRow>(
      `UPDATE tabdump_remote_projects
          SET status       = COALESCE($3, status),
              expires_at   = COALESCE($4, expires_at),
              sandbox_name = COALESCE($5, sandbox_name),
              updated_at   = $6
        WHERE id = $1 AND owner_id = $2
        RETURNING ${PROJECT_COLUMNS}`,
      [
        projectId,
        ownerId,
        patch.status ?? null,
        patch.expiresAt ?? null,
        patch.sandboxName ?? null,
        now,
      ]
    );
    return rows[0] ? toProject(rows[0]) : undefined;
  }

  async deleteProject(ownerId: string, projectId: string): Promise<boolean> {
    // Sessions cascade, by the FK in schema.sql. Deleting them here as well
    // would be a second implementation of the same rule, and the one in
    // application code is the one that gets forgotten.
    const rows = await this.query<{ id: string }>(
      `DELETE FROM tabdump_remote_projects WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [projectId, ownerId]
    );
    return rows.length > 0;
  }

  async countLiveSandboxes(ownerId: string): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tabdump_remote_projects
        WHERE owner_id = $1 AND status = ANY($2)`,
      [ownerId, [...liveStatuses()]]
    );
    return Number(rows[0]?.count ?? 0);
  }

  /* -------------------------------------------------------------- *
   * Sessions
   * -------------------------------------------------------------- */

  async createSession(session: RemoteSession): Promise<void> {
    await this.query(
      `INSERT INTO tabdump_remote_sessions
         (id, owner_id, project_id, provider, sandbox_name, command_id,
          provider_session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        session.id,
        session.ownerId,
        session.projectId,
        session.provider,
        session.sandboxName,
        session.commandId ?? null,
        session.providerSessionId ?? null,
        session.createdAt,
      ]
    );
  }

  async findSession(ownerId: string, sessionId: string): Promise<RemoteSession | undefined> {
    const rows = await this.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM tabdump_remote_sessions WHERE id = $1 AND owner_id = $2`,
      [sessionId, ownerId]
    );
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async listSessions(ownerId: string): Promise<RemoteSession[]> {
    const rows = await this.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM tabdump_remote_sessions
        WHERE owner_id = $1
        ORDER BY created_at DESC`,
      [ownerId]
    );
    return rows.map(toSession);
  }

  async updateSession(
    ownerId: string,
    sessionId: string,
    patch: Partial<Pick<RemoteSession, "commandId" | "providerSessionId">>,
    now: number
  ): Promise<RemoteSession | undefined> {
    const rows = await this.query<SessionRow>(
      `UPDATE tabdump_remote_sessions
          SET command_id          = COALESCE($3, command_id),
              -- Write-once, enforced in SQL rather than in a read-modify-write
              -- that two concurrent invocations could interleave. A session
              -- whose provider identity changed under it would be a different
              -- conversation wearing the same record.
              provider_session_id = COALESCE(provider_session_id, $4),
              updated_at          = $5
        WHERE id = $1 AND owner_id = $2
        RETURNING ${SESSION_COLUMNS}`,
      [
        sessionId,
        ownerId,
        patch.commandId ?? null,
        patch.providerSessionId ?? null,
        now,
      ]
    );
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async deleteSession(ownerId: string, sessionId: string): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM tabdump_remote_sessions WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [sessionId, ownerId]
    );
    return rows.length > 0;
  }

  async countLiveSessions(ownerId: string): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tabdump_remote_sessions WHERE owner_id = $1`,
      [ownerId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async findExpired(before: number, limit: number): Promise<ExpiredSandbox[]> {
    const rows = await this.query<{
      id: string;
      owner_id: string;
      sandbox_name: string;
    }>(
      `SELECT id, owner_id, sandbox_name FROM tabdump_remote_projects
        WHERE status = ANY($1) AND expires_at IS NOT NULL AND expires_at <= $2
        ORDER BY expires_at ASC
        LIMIT $3`,
      [[...liveStatuses()], before, limit]
    );
    return rows.map((row) => ({
      projectId: row.id,
      ownerId: row.owner_id,
      sandboxName: row.sandbox_name,
    }));
  }
}

/**
 * The remote store for this process, or nothing.
 *
 * Returns `undefined` rather than falling back to memory, and that refusal is
 * the whole point: a memory store behind a serverless function hands out a
 * sandbox on one instance and denies all knowledge of it on the next. The
 * auth store already refuses the same fallback for the same reason, and the
 * gate reads this as `no-durable-store` and says so truthfully.
 */
export async function createPostgresRemoteStore(): Promise<RemoteStore | undefined> {
  const connectionString = postgresConnectionString();
  if (!connectionString) return undefined;
  return new PostgresRemoteStore(await getPool(connectionString));
}
