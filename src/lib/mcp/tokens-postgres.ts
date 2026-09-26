import "server-only";
import { getPool, postgresConnectionString } from "@/lib/auth/store/postgres";
import type { Pool } from "pg";
import type { McpTokenRecord, McpTokenScope, McpTokenStore } from "./tokens";

/**
 * `McpTokenStore` on the deployment's Postgres (src/lib/mcp/schema.sql).
 *
 * Shares the auth store's pool, as the credential and remote stores do: one
 * database, one pool, and tokens are an account concern like sessions are.
 */

type TokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  hint: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

const COLUMNS =
  "id, user_id, name, token_hash, hint, scopes, created_at, expires_at, last_used_at, revoked_at";

function fromRow(row: TokenRow): McpTokenRecord | undefined {
  // A scope this build does not know is not silently narrowed to one it
  // does. The row is unreadable, and an unreadable token authenticates
  // nothing.
  if (!row.scopes.every((scope) => scope === "read")) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenHash: row.token_hash,
    hint: row.hint,
    scopes: row.scopes as McpTokenScope[],
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    ...(row.last_used_at !== null ? { lastUsedAt: Number(row.last_used_at) } : {}),
    ...(row.revoked_at !== null ? { revokedAt: Number(row.revoked_at) } : {}),
  };
}

export function createPostgresMcpTokenStore(pool: Pool): McpTokenStore {
  return {
    async create(record) {
      await pool.query(
        `INSERT INTO tabdump_mcp_tokens (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)`,
        [
          record.id,
          record.userId,
          record.name,
          record.tokenHash,
          record.hint,
          [...record.scopes],
          record.createdAt,
          record.expiresAt,
        ]
      );
    },

    async findByHash(tokenHash) {
      const result = await pool.query<TokenRow>(
        `SELECT ${COLUMNS} FROM tabdump_mcp_tokens WHERE token_hash = $1`,
        [tokenHash]
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    },

    async listForUser(userId) {
      const result = await pool.query<TokenRow>(
        `SELECT ${COLUMNS} FROM tabdump_mcp_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      return result.rows
        .map(fromRow)
        .filter((record): record is McpTokenRecord => record !== undefined);
    },

    async countActive(userId, now) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tabdump_mcp_tokens
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
        [userId, now]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async revoke(userId, tokenId, at) {
      // Owner in the predicate: somebody else's token id revokes nothing and
      // reports exactly what a nonexistent id reports.
      const result = await pool.query(
        `UPDATE tabdump_mcp_tokens SET revoked_at = $3
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [tokenId, userId, at]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async touch(tokenId, at) {
      await pool.query(`UPDATE tabdump_mcp_tokens SET last_used_at = $2 WHERE id = $1`, [
        tokenId,
        at,
      ]);
    },
  };
}

let resolved: Promise<McpTokenStore | undefined> | undefined;

/** The deployment's token store, or `undefined` with no database — in which case MCP is off. */
export async function getMcpTokenStore(): Promise<McpTokenStore | undefined> {
  resolved ??= (async () => {
    const connectionString = postgresConnectionString();
    if (!connectionString) return undefined;
    return createPostgresMcpTokenStore(await getPool(connectionString));
  })().catch((error) => {
    resolved = undefined;
    throw error;
  });
  return resolved;
}
