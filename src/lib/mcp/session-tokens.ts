import { randomBytes } from "node:crypto";
import { MAX_ACTIVE_MCP_TOKENS, MCP_TOKEN_SCOPES, mintMcpToken } from "./tokens";
import type { McpTokenStore } from "./tokens";

/**
 * Short-lived MCP tokens for one agent session (Phase J).
 *
 * ## Why these exist
 *
 * A user-issued token (./tokens.ts `issueMcpToken`) is for a client the user
 * configures by hand — Claude Desktop — and lives 90 days. When TabDump
 * itself starts an agent session, it can hand the agent read access to
 * TabDump for *that session* instead, so the user never copies a token or
 * edits a config file, and nothing long-lived is written anywhere:
 *
 *   - the token is minted when the session starts and passed to the agent in
 *     memory, as part of the ACP `session/new` request;
 *   - it expires on its own after `SESSION_MCP_TOKEN_TTL_MS`;
 *   - it is revoked the moment the session ends.
 *
 * It is an ordinary row in the same table with the same `read` scope, the
 * same hash-only storage and the same account binding, so it grants exactly
 * what any MCP token grants and it appears in the user's token list, named for
 * the agent, where it can be revoked by hand. Additive: the functions in
 * ./tokens.ts are unchanged.
 */

export const SESSION_MCP_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export type SessionMcpToken = { token: string; tokenId: string };

export async function issueSessionMcpToken(
  store: McpTokenStore,
  input: { userId: string; agentName: string; now: number }
): Promise<SessionMcpToken | undefined> {
  // Shares the per-account ceiling. A user at the limit gets a session with
  // no TabDump tools rather than an eleventh live token.
  if ((await store.countActive(input.userId, input.now)) >= MAX_ACTIVE_MCP_TOKENS) return undefined;

  const minted = mintMcpToken();
  const tokenId = `mcpt_${randomBytes(12).toString("base64url")}`;
  const name = `Agent session · ${input.agentName}`.slice(0, 60);

  await store.create({
    id: tokenId,
    userId: input.userId,
    name,
    tokenHash: minted.tokenHash,
    hint: minted.hint,
    scopes: [...MCP_TOKEN_SCOPES],
    createdAt: input.now,
    expiresAt: input.now + SESSION_MCP_TOKEN_TTL_MS,
  });

  return { token: minted.token, tokenId };
}

export async function revokeSessionMcpToken(
  store: McpTokenStore,
  input: { userId: string; tokenId: string; now: number }
): Promise<void> {
  await store.revoke(input.userId, input.tokenId, input.now);
}
