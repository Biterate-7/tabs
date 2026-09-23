import "server-only";
import { createPostgresRemoteStore } from "@/lib/agents/remote/store-postgres";
import { getSyncService } from "@/lib/sync/store";
import { createSyncMcpData } from "./data";
import { getMcpTokenStore } from "./tokens-postgres";
import type { McpHttpDeps } from "./http";

/**
 * The MCP endpoint's infrastructure, or `undefined` when this deployment
 * cannot serve it.
 *
 * Needs a database for two reasons that are really one: tokens live there,
 * and so does the only TabDump data a server has — the account-synced copy.
 * No database means no MCP, reported as a 503, never an in-memory stand-in
 * that would accept tokens it forgets on the next cold start.
 *
 * The remote agent store is optional. Without it the two agent-status tools
 * answer `available: false`; the workspace tools are unaffected.
 */
export async function getMcpDeps(): Promise<McpHttpDeps | undefined> {
  const tokens = await getMcpTokenStore().catch(() => undefined);
  if (!tokens) return undefined;

  const sync = await getSyncService();
  if (!sync.ok) return undefined;

  const remote = await createPostgresRemoteStore().catch(() => undefined);
  return { tokens, data: createSyncMcpData({ sync: sync.service, remote }) };
}
