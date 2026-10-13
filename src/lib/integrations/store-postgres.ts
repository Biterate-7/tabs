import "server-only";
import { getPool, postgresConnectionString } from "@/lib/auth/store/postgres";
import { isValidScopeSet, isIntegrationClient } from "./scopes";
import type { Pool } from "pg";
import type {
  ActivityRecord,
  AuthorizationCodeRecord,
  ConnectionRecord,
  ContextSource,
  CredentialRecord,
  IdempotencyRecord,
  OAuthClientRecord,
  ProjectContextRecord,
  ProposalRecord,
  WorkspaceNoteRecord,
} from "./records";
import type { IntegrationStore } from "./store";

/**
 * `IntegrationStore` on the deployment's Postgres (./schema.sql).
 *
 * Shares the auth store's pool, as the MCP token, credential and remote
 * stores do. Every compare-and-set the interface promises is one UPDATE with
 * the expected state in its WHERE clause, so it holds across concurrent
 * serverless invocations, not only within one process.
 */

type ConnectionRow = {
  id: string;
  user_id: string;
  client: string;
  label: string;
  method: string;
  oauth_client_id: string | null;
  scopes: string[];
  workspace_ids: string[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const CONNECTION_COLUMNS =
  "id, user_id, client, label, method, oauth_client_id, scopes, workspace_ids, created_at, updated_at, last_used_at, revoked_at";

function connectionFromRow(row: ConnectionRow): ConnectionRecord | undefined {
  // A row this build cannot read authenticates nothing.
  if (!isValidScopeSet(row.scopes) || !isIntegrationClient(row.client) || (row.method !== "oauth" && row.method !== "token")) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    client: row.client,
    label: row.label,
    method: row.method,
    ...(row.oauth_client_id ? { oauthClientId: row.oauth_client_id } : {}),
    scopes: row.scopes,
    workspaceIds: row.workspace_ids,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_used_at !== null ? { lastUsedAt: Number(row.last_used_at) } : {}),
    ...(row.revoked_at !== null ? { revokedAt: Number(row.revoked_at) } : {}),
  };
}

type CredentialRow = {
  id: string;
  connection_id: string;
  kind: CredentialRecord["kind"];
  token_hash: string;
  hint: string;
  resource: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

const CREDENTIAL_COLUMNS = "id, connection_id, kind, token_hash, hint, resource, created_at, expires_at, used_at, revoked_at, last_used_at";

function credentialFromRow(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    kind: row.kind,
    tokenHash: row.token_hash,
    hint: row.hint,
    ...(row.resource ? { resource: row.resource } : {}),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    ...(row.used_at !== null ? { usedAt: Number(row.used_at) } : {}),
    ...(row.revoked_at !== null ? { revokedAt: Number(row.revoked_at) } : {}),
    ...(row.last_used_at !== null ? { lastUsedAt: Number(row.last_used_at) } : {}),
  };
}

type ProposalRow = {
  id: string;
  user_id: string;
  connection_id: string;
  client: string;
  workspace_id: string;
  base_version: string;
  operations: ProposalRecord["operations"];
  steps: ProposalRecord["steps"];
  tab_count: number;
  effect: string;
  summary: string | null;
  status: ProposalRecord["status"];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  applied_at: string | null;
  result: ProposalRecord["result"] | null;
  failure: string | null;
};

const PROPOSAL_COLUMNS =
  "id, user_id, connection_id, client, workspace_id, base_version, operations, steps, tab_count, effect, summary, status, created_at, expires_at, decided_at, applied_at, result, failure";

function proposalFromRow(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    userId: row.user_id,
    connectionId: row.connection_id,
    client: isIntegrationClient(row.client) ? row.client : "other",
    workspaceId: row.workspace_id,
    baseVersion: Number(row.base_version),
    operations: row.operations,
    steps: row.steps,
    tabCount: row.tab_count,
    effect: row.effect,
    ...(row.summary ? { summary: row.summary } : {}),
    status: row.status,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    ...(row.decided_at !== null ? { decidedAt: Number(row.decided_at) } : {}),
    ...(row.applied_at !== null ? { appliedAt: Number(row.applied_at) } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.failure ? { failure: row.failure } : {}),
  };
}

type ActivityRow = {
  id: string;
  user_id: string;
  connection_id: string | null;
  client: string | null;
  actor: ActivityRecord["actor"];
  kind: ActivityRecord["kind"];
  operation: string;
  workspace_id: string | null;
  targets: string[];
  outcome: ActivityRecord["outcome"];
  error_category: string | null;
  detail: string | null;
  at: string;
};

function activityFromRow(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.connection_id ? { connectionId: row.connection_id } : {}),
    ...(row.client && isIntegrationClient(row.client) ? { client: row.client } : {}),
    actor: row.actor,
    kind: row.kind,
    operation: row.operation,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    targets: row.targets,
    outcome: row.outcome,
    ...(row.error_category ? { errorCategory: row.error_category } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    at: Number(row.at),
  };
}

type NoteRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  collection_id: string | null;
  title: string;
  body: string;
  content_hash: string;
  source: ContextSource;
  created_at: string;
};

const NOTE_COLUMNS = "id, user_id, workspace_id, collection_id, title, body, content_hash, source, created_at";

function noteFromRow(row: NoteRow): WorkspaceNoteRecord {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    ...(row.collection_id ? { collectionId: row.collection_id } : {}),
    title: row.title,
    body: row.body,
    contentHash: row.content_hash,
    createdAt: Number(row.created_at),
    source: row.source,
  };
}

export function createPostgresIntegrationStore(pool: Pool): IntegrationStore {
  const store: IntegrationStore = {
    async createConnection(r) {
      await pool.query(
        `INSERT INTO hubble_integration_connections (${CONNECTION_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL)`,
        [r.id, r.userId, r.client, r.label, r.method, r.oauthClientId ?? null, r.scopes, r.workspaceIds, r.createdAt, r.updatedAt]
      );
    },
    async getConnection(userId, id) {
      const result = await pool.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM hubble_integration_connections WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      return result.rows[0] ? connectionFromRow(result.rows[0]) : undefined;
    },
    async listConnections(userId) {
      const result = await pool.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM hubble_integration_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [userId]
      );
      return result.rows.map(connectionFromRow).filter((r): r is ConnectionRecord => r !== undefined);
    },
    async countActiveConnections(userId) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM hubble_integration_connections WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      return Number(result.rows[0]?.count ?? 0);
    },
    async updateConnection(userId, id, patch, at) {
      const result = await pool.query<ConnectionRow>(
        `UPDATE hubble_integration_connections
            SET scopes = COALESCE($3, scopes), workspace_ids = COALESCE($4, workspace_ids), label = COALESCE($5, label), updated_at = $6
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING ${CONNECTION_COLUMNS}`,
        [id, userId, patch.scopes ?? null, patch.workspaceIds ?? null, patch.label ?? null, at]
      );
      return result.rows[0] ? connectionFromRow(result.rows[0]) : undefined;
    },
    async revokeConnection(userId, id, at) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE hubble_integration_connections SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [id, userId, at]
        );
        const revoked = (result.rowCount ?? 0) > 0;
        if (revoked) {
          await client.query(
            `UPDATE hubble_integration_credentials SET revoked_at = $2 WHERE connection_id = $1 AND revoked_at IS NULL`,
            [id, at]
          );
        }
        await client.query("COMMIT");
        return revoked;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async touchConnection(id, at) {
      await pool.query(`UPDATE hubble_integration_connections SET last_used_at = $2 WHERE id = $1`, [id, at]);
    },

    async createCredential(r) {
      await pool.query(
        `INSERT INTO hubble_integration_credentials (${CREDENTIAL_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, NULL)`,
        [r.id, r.connectionId, r.kind, r.tokenHash, r.hint, r.resource ?? null, r.createdAt, r.expiresAt]
      );
    },
    async findCredential(tokenHash) {
      const result = await pool.query<CredentialRow & { c: ConnectionRow }>(
        `SELECT ${CREDENTIAL_COLUMNS.split(", ").map((c) => `k.${c}`).join(", ")}, row_to_json(c.*) AS c
           FROM hubble_integration_credentials k
           JOIN hubble_integration_connections c ON c.id = k.connection_id
          WHERE k.token_hash = $1`,
        [tokenHash]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const connection = connectionFromRow({
        ...row.c,
        created_at: String(row.c.created_at),
        updated_at: String(row.c.updated_at),
        last_used_at: row.c.last_used_at === null ? null : String(row.c.last_used_at),
        revoked_at: row.c.revoked_at === null ? null : String(row.c.revoked_at),
      });
      return connection ? { credential: credentialFromRow(row), connection } : undefined;
    },
    async listCredentials(userId, connectionId) {
      const result = await pool.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS.split(", ").map((c) => `k.${c}`).join(", ")}
           FROM hubble_integration_credentials k
           JOIN hubble_integration_connections c ON c.id = k.connection_id
          WHERE k.connection_id = $1 AND c.user_id = $2
          ORDER BY k.created_at DESC LIMIT 50`,
        [connectionId, userId]
      );
      return result.rows.map(credentialFromRow);
    },
    async markCredentialUsed(id, at) {
      const result = await pool.query(`UPDATE hubble_integration_credentials SET used_at = $2 WHERE id = $1 AND used_at IS NULL`, [id, at]);
      return (result.rowCount ?? 0) > 0;
    },
    async revokeCredential(id, at) {
      await pool.query(`UPDATE hubble_integration_credentials SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, at]);
    },
    async touchCredential(id, at) {
      await pool.query(`UPDATE hubble_integration_credentials SET last_used_at = $2 WHERE id = $1`, [id, at]);
    },

    async createOAuthClient(r) {
      await pool.query(
        `INSERT INTO hubble_oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, secret_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.clientId, r.clientName, r.redirectUris, r.tokenEndpointAuthMethod, r.secretHash ?? null, r.createdAt]
      );
    },
    async getOAuthClient(clientId) {
      const result = await pool.query<{
        client_id: string;
        client_name: string;
        redirect_uris: string[];
        token_endpoint_auth_method: OAuthClientRecord["tokenEndpointAuthMethod"];
        secret_hash: string | null;
        created_at: string;
      }>(
        `SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method, secret_hash, created_at FROM hubble_oauth_clients WHERE client_id = $1`,
        [clientId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        clientId: row.client_id,
        clientName: row.client_name,
        redirectUris: row.redirect_uris,
        tokenEndpointAuthMethod: row.token_endpoint_auth_method,
        ...(row.secret_hash ? { secretHash: row.secret_hash } : {}),
        createdAt: Number(row.created_at),
      };
    },

    async createAuthorizationCode(r) {
      await pool.query(
        `INSERT INTO hubble_oauth_codes
           (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scopes, workspace_ids, client, label, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [r.codeHash, r.clientId, r.userId, r.redirectUri, r.codeChallenge, r.resource, r.scopes, r.workspaceIds, r.client, r.label, r.createdAt, r.expiresAt]
      );
    },
    async consumeAuthorizationCode(codeHash, at) {
      type Row = {
        code_hash: string;
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string;
        scopes: string[];
        workspace_ids: string[];
        client: string;
        label: string;
        created_at: string;
        expires_at: string;
        used_at: string | null;
        connection_id: string | null;
      };
      const toRecord = (row: Row): AuthorizationCodeRecord => ({
        codeHash: row.code_hash,
        clientId: row.client_id,
        userId: row.user_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        resource: row.resource,
        scopes: isValidScopeSet(row.scopes) ? row.scopes : ["hubble.read"],
        workspaceIds: row.workspace_ids,
        client: isIntegrationClient(row.client) ? row.client : "other",
        label: row.label,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
        ...(row.used_at !== null ? { usedAt: Number(row.used_at) } : {}),
        ...(row.connection_id ? { connectionId: row.connection_id } : {}),
      });
      // The first redeemer marks it; everyone after sees it already used.
      const claimed = await pool.query<Row>(
        `UPDATE hubble_oauth_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL RETURNING *`,
        [codeHash, at]
      );
      if (claimed.rows[0]) return { record: toRecord(claimed.rows[0]), alreadyUsed: false };
      const existing = await pool.query<Row>(`SELECT * FROM hubble_oauth_codes WHERE code_hash = $1`, [codeHash]);
      return existing.rows[0] ? { record: toRecord(existing.rows[0]), alreadyUsed: true } : undefined;
    },
    async setAuthorizationCodeConnection(codeHash, connectionId) {
      await pool.query(`UPDATE hubble_oauth_codes SET connection_id = $2 WHERE code_hash = $1`, [codeHash, connectionId]);
    },

    async createProposal(r) {
      await pool.query(
        `INSERT INTO hubble_integration_proposals (${PROPOSAL_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, NULL, NULL, NULL)`,
        [
          r.id,
          r.userId,
          r.connectionId,
          r.client,
          r.workspaceId,
          r.baseVersion,
          JSON.stringify(r.operations),
          JSON.stringify(r.steps),
          r.tabCount,
          r.effect,
          r.summary ?? null,
          r.status,
          r.createdAt,
          r.expiresAt,
        ]
      );
    },
    async getProposal(userId, id) {
      const result = await pool.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM hubble_integration_proposals WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      return result.rows[0] ? proposalFromRow(result.rows[0]) : undefined;
    },
    async listProposals(userId, options) {
      const result = await pool.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM hubble_integration_proposals
          WHERE user_id = $1 AND ($2::text[] IS NULL OR status = ANY ($2::text[]))
          ORDER BY created_at DESC LIMIT $3`,
        [userId, options.statuses ? [...options.statuses] : null, options.limit]
      );
      return result.rows.map(proposalFromRow);
    },
    async transitionProposal(userId, id, from, to, patch) {
      const result = await pool.query<ProposalRow>(
        `UPDATE hubble_integration_proposals
            SET status = $4,
                decided_at = COALESCE($5, decided_at),
                applied_at = COALESCE($6, applied_at),
                result = COALESCE($7::jsonb, result),
                failure = COALESCE($8, failure)
          WHERE id = $1 AND user_id = $2 AND status = ANY ($3::text[])
          RETURNING ${PROPOSAL_COLUMNS}`,
        [
          id,
          userId,
          [...from],
          to,
          patch.decidedAt ?? null,
          patch.appliedAt ?? null,
          patch.result ? JSON.stringify(patch.result) : null,
          patch.failure ?? null,
        ]
      );
      return result.rows[0] ? proposalFromRow(result.rows[0]) : undefined;
    },

    async appendActivity(r) {
      await pool.query(
        `INSERT INTO hubble_integration_activity
           (id, user_id, connection_id, client, actor, kind, operation, workspace_id, targets, outcome, error_category, detail, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          r.id,
          r.userId,
          r.connectionId ?? null,
          r.client ?? null,
          r.actor,
          r.kind,
          r.operation,
          r.workspaceId ?? null,
          r.targets,
          r.outcome,
          r.errorCategory ?? null,
          r.detail ?? null,
          r.at,
        ]
      );
    },
    async listActivity(userId, options) {
      const result = await pool.query<ActivityRow>(
        `SELECT * FROM hubble_integration_activity
          WHERE user_id = $1
            AND ($2::text IS NULL OR workspace_id = $2)
            AND ($3::text IS NULL OR connection_id = $3)
            AND ($4::bigint IS NULL OR at < $4)
          ORDER BY at DESC, id DESC LIMIT $5`,
        [userId, options.workspaceId ?? null, options.connectionId ?? null, options.before ?? null, options.limit]
      );
      return result.rows.map(activityFromRow);
    },
    async pruneExpired(cutoffs) {
      // Four independent deletes, each on its own index; none holds a lock a live request waits on for long.
      await pool.query(`DELETE FROM hubble_integration_activity WHERE at < $1`, [cutoffs.activityBefore]);
      await pool.query(`DELETE FROM hubble_integration_idempotency WHERE created_at < $1`, [cutoffs.idempotencyBefore]);
      await pool.query(`DELETE FROM hubble_oauth_codes WHERE expires_at < $1`, [cutoffs.codesExpiredBefore]);
      await pool.query(`DELETE FROM hubble_integration_credentials WHERE expires_at < $1`, [cutoffs.credentialsExpiredBefore]);
    },

    async getIdempotent(connectionId, key) {
      const result = await pool.query<{ connection_id: string; key: string; operation: string; result: unknown; created_at: string }>(
        `SELECT connection_id, key, operation, result, created_at FROM hubble_integration_idempotency WHERE connection_id = $1 AND key = $2`,
        [connectionId, key]
      );
      const row = result.rows[0];
      return row ? { connectionId: row.connection_id, key: row.key, operation: row.operation, result: row.result, createdAt: Number(row.created_at) } : undefined;
    },
    async putIdempotent(r: IdempotencyRecord) {
      await pool.query(
        `INSERT INTO hubble_integration_idempotency (connection_id, key, operation, result, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (connection_id, key) DO NOTHING`,
        [r.connectionId, r.key, r.operation, JSON.stringify(r.result), r.createdAt]
      );
      return (await store.getIdempotent(r.connectionId, r.key)) ?? r;
    },

    async getProjectContext(userId, workspaceId) {
      const result = await pool.query<{ document: ProjectContextRecord }>(
        `SELECT document FROM hubble_project_context WHERE user_id = $1 AND workspace_id = $2`,
        [userId, workspaceId]
      );
      const document = result.rows[0]?.document;
      return document && document.schemaVersion === 1 ? document : undefined;
    },
    async putProjectContext(r, expectedRevision) {
      if (expectedRevision === null) {
        const inserted = await pool.query(
          `INSERT INTO hubble_project_context (user_id, workspace_id, schema_version, revision, document, updated_at)
           VALUES ($1, $2, 1, $3, $4, $5) ON CONFLICT (user_id, workspace_id) DO NOTHING`,
          [r.userId, r.workspaceId, r.revision, JSON.stringify(r), r.updatedAt]
        );
        return (inserted.rowCount ?? 0) > 0 ? "ok" : "conflict";
      }
      const updated = await pool.query(
        `UPDATE hubble_project_context SET revision = $3, document = $4, updated_at = $5
          WHERE user_id = $1 AND workspace_id = $2 AND revision = $6`,
        [r.userId, r.workspaceId, r.revision, JSON.stringify(r), r.updatedAt, expectedRevision]
      );
      return (updated.rowCount ?? 0) > 0 ? "ok" : "conflict";
    },
    async deleteProjectContext(userId, workspaceId) {
      const result = await pool.query(`DELETE FROM hubble_project_context WHERE user_id = $1 AND workspace_id = $2`, [userId, workspaceId]);
      return (result.rowCount ?? 0) > 0;
    },

    async addNote(r) {
      const inserted = await pool.query<NoteRow>(
        `INSERT INTO hubble_workspace_notes (${NOTE_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, workspace_id, content_hash) DO NOTHING
         RETURNING ${NOTE_COLUMNS}`,
        [r.id, r.userId, r.workspaceId, r.collectionId ?? null, r.title, r.body, r.contentHash, JSON.stringify(r.source), r.createdAt]
      );
      if (inserted.rows[0]) return { note: noteFromRow(inserted.rows[0]), created: true };
      const existing = await pool.query<NoteRow>(
        `SELECT ${NOTE_COLUMNS} FROM hubble_workspace_notes WHERE user_id = $1 AND workspace_id = $2 AND content_hash = $3`,
        [r.userId, r.workspaceId, r.contentHash]
      );
      return { note: noteFromRow(existing.rows[0]), created: false };
    },
    async listNotes(userId, workspaceId, options) {
      const [rows, count] = [
        await pool.query<NoteRow>(
          `SELECT ${NOTE_COLUMNS} FROM hubble_workspace_notes WHERE user_id = $1 AND workspace_id = $2
            ORDER BY created_at DESC, id DESC OFFSET $3 LIMIT $4`,
          [userId, workspaceId, options.offset, options.limit]
        ),
        await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM hubble_workspace_notes WHERE user_id = $1 AND workspace_id = $2`,
          [userId, workspaceId]
        ),
      ];
      return { notes: rows.rows.map(noteFromRow), total: Number(count.rows[0]?.count ?? 0) };
    },
    async deleteNote(userId, noteId) {
      const result = await pool.query(`DELETE FROM hubble_workspace_notes WHERE id = $1 AND user_id = $2`, [noteId, userId]);
      return (result.rowCount ?? 0) > 0;
    },
  };
  return store;
}

/**
 * Whether `npm run migrate:integrations` has been applied to this database.
 *
 * The schema is applied in one transaction, so its last table existing means
 * all of it does.
 */
export async function integrationSchemaPresent(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(`SELECT to_regclass('public.hubble_workspace_notes') IS NOT NULL AS present`);
  return rows[0]?.present === true;
}

/** How long a "not migrated yet" answer is trusted before the database is asked again. */
const SCHEMA_RECHECK_MS = 60 * 1000;

let cached: { store?: IntegrationStore; checkedAt: number } | undefined;

/**
 * The deployment's integration store, or `undefined` when AI integrations
 * cannot run here: no database, or a database the integration migration has
 * not been applied to yet.
 *
 * The second case matters on the first deploy. The code can reach production
 * before `migrate:integrations` runs; without this check every OAuth and
 * integration route would fail with a missing-relation 500 instead of the
 * documented 503, and personal-token MCP requests with it. A missing schema
 * is re-checked every minute, so the feature turns on shortly after the
 * migration without a redeploy. A present one is cached for the process.
 */
export async function getIntegrationStore(): Promise<IntegrationStore | undefined> {
  const connectionString = postgresConnectionString();
  if (!connectionString) return undefined;
  if (cached?.store) return cached.store;
  if (cached && Date.now() - cached.checkedAt < SCHEMA_RECHECK_MS) return undefined;
  const pool = await getPool(connectionString);
  const present = await integrationSchemaPresent(pool);
  cached = present ? { store: createPostgresIntegrationStore(pool), checkedAt: Date.now() } : { checkedAt: Date.now() };
  return cached.store;
}

