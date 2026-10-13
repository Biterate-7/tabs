import { credentialKindOf, sha256Hex } from "./credentials";
import { isValidScopeSet } from "./scopes";
import type { ConnectionRecord, ActivityActor } from "./records";
import type { HubbleScope, IntegrationClient } from "./scopes";
import type { IntegrationStore } from "./store";
import type { McpTokenStore } from "@/lib/mcp/tokens";
import { authenticateMcpToken, isWellFormedMcpToken } from "@/lib/mcp/tokens";

/**
 * A grant: what one MCP request is allowed to do, established once from its
 * credential and then consulted by every tool.
 *
 * ## One permission model
 *
 * Every way in — an OAuth access token from ChatGPT, Claude, Gemini or Grok,
 * a personal token in a CLI's config, Hubble's own connection test, and the
 * read-only `tdmcp_` tokens issued before this layer existed — resolves to
 * this one shape. The MCP server never looks at a credential again, and no
 * tool reads a permission from its arguments: a workspace id, a scope or a
 * flag supplied by the client is data to check against the grant, never a
 * grant itself.
 *
 * ## What is re-read on every request
 *
 * Scopes and workspaces live on the connection, not the token, and the
 * connection is read with the credential each time. Narrowing or revoking a
 * connection in Hubble therefore applies to the very next call, including
 * calls carrying an access token issued a minute earlier.
 */
export type IntegrationGrant = {
  userId: string;
  /** Absent only for a legacy `tdmcp_` token, which predates connections. */
  connectionId?: string;
  credentialId: string;
  client: IntegrationClient;
  label: string;
  method: "oauth" | "token" | "legacy";
  actor: ActivityActor;
  scopes: readonly HubbleScope[];
  /**
   * The workspaces this request may see. `all` is held only by a legacy
   * read-only token, which has always been able to read every synced
   * workspace of its account; every connection lists its own.
   */
  workspaces: { kind: "listed"; ids: readonly string[] } | { kind: "all" };
};

export function canWrite(grant: IntegrationGrant): boolean {
  return grant.scopes.includes("hubble.write");
}

export function canSeeWorkspace(grant: IntegrationGrant, workspaceId: string): boolean {
  return grant.workspaces.kind === "all" || grant.workspaces.ids.includes(workspaceId);
}

export type GrantFailure = "missing" | "malformed" | "unknown" | "revoked" | "expired" | "wrong_audience";

export type GrantResult = { ok: true; grant: IntegrationGrant } | { ok: false; reason: GrantFailure; oauth: boolean };

/** `last_used_at` is refreshed at most this often, so a burst of reads is not a burst of writes. */
export const TOUCH_INTERVAL_MS = 60 * 1000;

function connectionGrant(connection: ConnectionRecord, credentialId: string, actor: ActivityActor): IntegrationGrant | undefined {
  // A stored scope set this build does not recognise is not narrowed to one
  // it does: the connection authenticates nothing until it is fixed.
  if (!isValidScopeSet(connection.scopes)) return undefined;
  return {
    userId: connection.userId,
    connectionId: connection.id,
    credentialId,
    client: connection.client,
    label: connection.label,
    method: connection.method,
    actor,
    scopes: [...connection.scopes],
    workspaces: { kind: "listed", ids: [...connection.workspaceIds] },
  };
}

/**
 * The grant a bearer credential carries on this endpoint, or why it carries
 * none. `resource` is the canonical URL of the MCP endpoint being called; an
 * OAuth access token issued for any other resource is refused (RFC 8707,
 * the MCP authorization specification's audience rule).
 */
export async function authenticateBearer(
  presented: string | null,
  deps: { store?: IntegrationStore; legacy?: McpTokenStore; now: number; resource: string }
): Promise<GrantResult> {
  if (presented === null) return { ok: false, reason: "missing", oauth: deps.store !== undefined };

  if (isWellFormedMcpToken(presented)) {
    if (!deps.legacy) return { ok: false, reason: "unknown", oauth: false };
    const legacy = await authenticateMcpToken(deps.legacy, presented, deps.now);
    if (!legacy.ok) return { ok: false, reason: legacy.reason === "malformed" ? "malformed" : legacy.reason, oauth: false };
    return {
      ok: true,
      grant: {
        userId: legacy.userId,
        credentialId: legacy.tokenId,
        // Every tdmcp_ token was minted by the Claude Desktop card.
        client: "claude",
        label: "Claude Desktop (older token)",
        method: "legacy",
        actor: "ai_client",
        scopes: ["hubble.read"],
        workspaces: { kind: "all" },
      },
    };
  }

  const kind = credentialKindOf(presented);
  // A refresh token is never a bearer credential: it is only ever presented
  // to the token endpoint.
  if (!kind || kind === "refresh") return { ok: false, reason: "malformed", oauth: deps.store !== undefined };
  if (!deps.store) return { ok: false, reason: "unknown", oauth: false };
  const oauth = kind === "access";

  const found = await deps.store.findCredential(sha256Hex(presented));
  if (!found || found.credential.kind !== kind) return { ok: false, reason: "unknown", oauth };
  const { credential, connection } = found;
  if (credential.revokedAt !== undefined || connection.revokedAt !== undefined) return { ok: false, reason: "revoked", oauth };
  if (credential.expiresAt <= deps.now) return { ok: false, reason: "expired", oauth };
  if (kind === "access" && credential.resource !== deps.resource) return { ok: false, reason: "wrong_audience", oauth };

  const grant = connectionGrant(connection, credential.id, kind === "test" ? "connection_test" : "ai_client");
  if (!grant) return { ok: false, reason: "unknown", oauth };

  // Bookkeeping is best effort: a failed write never turns a valid call into
  // a refusal. Hubble's own test does not count as the client having connected.
  if (kind !== "test" && (connection.lastUsedAt === undefined || deps.now - connection.lastUsedAt >= TOUCH_INTERVAL_MS)) {
    await deps.store.touchConnection(connection.id, deps.now).catch(() => {});
    await deps.store.touchCredential(credential.id, deps.now).catch(() => {});
  }
  return { ok: true, grant };
}
