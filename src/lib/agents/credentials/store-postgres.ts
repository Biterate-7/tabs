import "server-only";
import { getPool, postgresConnectionString } from "@/lib/auth/store/postgres";
import { readConnectionRow } from "./store";
import type { Pool, QueryResultRow } from "pg";
import type { SealedSecret, SealedSecretRows } from "./secret-store";
import type { ConnectionStore } from "./store";
import type { AgentProviderConnection } from "./types";

/**
 * The durable provider-connection store.
 *
 * Shares the auth layer's pool, exactly as `remote/store-postgres.ts` does and
 * for the same reason: `getPool` exists for this, and a third pool against the
 * same database would triple an instance's connection footprint for nothing.
 *
 * ## Ownership lives in the WHERE clause
 *
 * Every statement below names `owner_id` in its predicate. Not
 * fetched-then-checked: a row belonging to someone else does not come back, is
 * not counted, and is not updated. That is the difference between an access
 * check and access *control*, and it is why §13's isolation tests can be
 * written as "does A see anything of B's" rather than "did we remember the
 * check at this call site".
 */

const CONNECTION_COLUMNS =
  "id, owner_id, provider, auth_method, display_name, status, created_at, updated_at, last_validated_at, last_failure_code";

type ConnectionRow = QueryResultRow & {
  id: string;
  owner_id: string;
  provider: string;
  auth_method: string;
  display_name: string;
  status: string;
  created_at: string | number;
  updated_at: string | number;
  last_validated_at: string | number | null;
  last_failure_code: string | null;
};

type SecretRow = QueryResultRow & {
  scheme: number;
  iv: string;
  ciphertext: string;
  auth_tag: string;
};

/**
 * Builds both stores, or neither.
 *
 * They are returned together because a deployment with connections and no
 * secret table can report a user as connected and then fail every session, and
 * a caller holding one of the two would have to remember that. Resolving to
 * `undefined` when there is no database is the fail-closed answer the whole
 * feature is built on.
 */
export async function createPostgresCredentialStores(): Promise<
  { connections: ConnectionStore; secrets: SealedSecretRows } | undefined
> {
  const connectionString = postgresConnectionString();
  if (!connectionString) return undefined;

  const pool = await getPool(connectionString);
  return { connections: connectionStore(pool), secrets: secretRows(pool) };
}

function connectionStore(pool: Pool): ConnectionStore {
  const read = (row: ConnectionRow): AgentProviderConnection | undefined =>
    readConnectionRow(row);

  return {
    async list(ownerId) {
      const result = await pool.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM tabdump_provider_connections
         WHERE owner_id = $1 ORDER BY created_at DESC`,
        [ownerId]
      );
      // A row this build cannot read is dropped rather than surfaced as a
      // half-populated connection. See `readConnectionRow`.
      return result.rows.map(read).filter((row): row is AgentProviderConnection => row !== undefined);
    },

    async find(ownerId, connectionId) {
      const result = await pool.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM tabdump_provider_connections
         WHERE owner_id = $1 AND id = $2`,
        [ownerId, connectionId]
      );
      return result.rows[0] ? read(result.rows[0]) : undefined;
    },

    async findByProvider(ownerId, provider) {
      const result = await pool.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM tabdump_provider_connections
         WHERE owner_id = $1 AND provider = $2`,
        [ownerId, provider]
      );
      return result.rows[0] ? read(result.rows[0]) : undefined;
    },

    async upsert(input) {
      // Conflict on (owner_id, provider) rather than on the primary key: the
      // uniqueness that matters is "one connection per provider per user", and
      // resolving it here means a concurrent double-connect updates rather
      // than raising. The id is preserved on conflict so a rotation keeps the
      // connection's identity.
      const result = await pool.query<ConnectionRow>(
        `INSERT INTO tabdump_provider_connections
           (id, owner_id, provider, auth_method, display_name, status,
            created_at, updated_at, last_validated_at, last_failure_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (owner_id, provider) DO UPDATE SET
           auth_method       = EXCLUDED.auth_method,
           display_name      = EXCLUDED.display_name,
           status            = EXCLUDED.status,
           updated_at        = EXCLUDED.updated_at,
           last_validated_at = EXCLUDED.last_validated_at,
           last_failure_code = EXCLUDED.last_failure_code
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          input.id,
          input.ownerId,
          input.provider,
          input.authMethod,
          input.displayName,
          input.status,
          input.createdAt,
          input.updatedAt,
          input.lastValidatedAt ?? null,
          input.lastFailureCode ?? null,
        ]
      );

      const connection = result.rows[0] ? read(result.rows[0]) : undefined;
      // Unreachable for a row this function just wrote — every column came
      // from a validated domain value. Throwing rather than inventing one is
      // the fail-closed direction: a caller that got a fabricated connection
      // back would report it to the user as connected.
      if (!connection) throw new Error("provider connection could not be read back");
      return connection;
    },

    async update(ownerId, connectionId, patch, at) {
      // Built with COALESCE rather than a dynamic SET list: every parameter is
      // positional, nothing is interpolated, and a patch that moves one field
      // leaves the rest exactly as they were. `last_failure_code` needs three
      // states — leave, set, clear — which is what the extra flag encodes.
      const clearFailure = patch.lastFailureCode === null;

      const result = await pool.query<ConnectionRow>(
        `UPDATE tabdump_provider_connections SET
           display_name      = COALESCE($3, display_name),
           status            = COALESCE($4, status),
           last_validated_at = COALESCE($5, last_validated_at),
           last_failure_code = CASE WHEN $6 THEN NULL
                                    ELSE COALESCE($7, last_failure_code) END,
           updated_at        = $8
         WHERE owner_id = $1 AND id = $2
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          ownerId,
          connectionId,
          patch.displayName ?? null,
          patch.status ?? null,
          patch.lastValidatedAt ?? null,
          clearFailure,
          clearFailure ? null : patch.lastFailureCode ?? null,
          at,
        ]
      );

      return result.rows[0] ? read(result.rows[0]) : undefined;
    },

    async remove(ownerId, connectionId) {
      // The secret row cascades. See the FK in schema.sql — that cascade is
      // the database's own guarantee against an orphaned secret, independent
      // of whether the service remembered to call `forget` first.
      const result = await pool.query(
        `DELETE FROM tabdump_provider_connections WHERE owner_id = $1 AND id = $2`,
        [ownerId, connectionId]
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

function secretRows(pool: Pool): SealedSecretRows {
  return {
    async put(connectionId, ownerId, sealed, at) {
      await pool.query(
        `INSERT INTO tabdump_provider_secrets
           (connection_id, owner_id, scheme, iv, ciphertext, auth_tag, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (connection_id) DO UPDATE SET
           scheme     = EXCLUDED.scheme,
           iv         = EXCLUDED.iv,
           ciphertext = EXCLUDED.ciphertext,
           auth_tag   = EXCLUDED.auth_tag,
           updated_at = EXCLUDED.updated_at
         WHERE tabdump_provider_secrets.owner_id = EXCLUDED.owner_id`,
        [connectionId, ownerId, sealed.version, sealed.iv, sealed.ciphertext, sealed.authTag, at]
      );
    },

    async get(connectionId, ownerId) {
      const result = await pool.query<SecretRow>(
        `SELECT scheme, iv, ciphertext, auth_tag FROM tabdump_provider_secrets
         WHERE connection_id = $1 AND owner_id = $2`,
        [connectionId, ownerId]
      );

      const row = result.rows[0];
      if (!row) return undefined;
      // Only scheme 1 exists. An unrecognised one is not opened — a record
      // sealed by a future version must not be handed to a cipher that would
      // misread it, and `undefined` here surfaces as "credential store
      // unavailable" rather than as a wrong key.
      if (row.scheme !== 1) return undefined;

      const sealed: SealedSecret = {
        version: 1,
        iv: row.iv,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
      };
      return sealed;
    },

    async delete(connectionId, ownerId) {
      await pool.query(
        `DELETE FROM tabdump_provider_secrets WHERE connection_id = $1 AND owner_id = $2`,
        [connectionId, ownerId]
      );
    },
  };
}
