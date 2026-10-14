import "server-only";
import { checkRateLimit } from "@/lib/ai/server/rate-limit";
import { getIntegrationStore } from "@/lib/integrations/store-postgres";
import { getSyncService } from "@/lib/sync/store";
import { createSyncMcpData } from "./data";
import { getMcpTokenStore } from "./tokens-postgres";
import type { McpHttpDeps } from "./http";

/**
 * The MCP endpoint's infrastructure, or `undefined` when this deployment
 * cannot serve it.
 *
 * Needs a database for two reasons that are really one: credentials live
 * there, and so does the only Hubble data a server has — the account-synced
 * copy. No database means no MCP, reported as a 503, never an in-memory
 * stand-in that would accept tokens it forgets on the next cold start.
 *
 * The integration store (connections, OAuth, proposals, context, audit) is
 * on the same database; a deployment that has not run
 * `npm run migrate:integrations` yet still serves legacy read-only tokens.
 */
export async function getMcpDeps(): Promise<McpHttpDeps | undefined> {
  const tokens = await getMcpTokenStore().catch(() => undefined);
  if (!tokens) return undefined;

  const sync = await getSyncService();
  if (!sync.ok) return undefined;

  const store = await getIntegrationStore().catch(() => undefined);
  return {
    tokens,
    data: createSyncMcpData({ sync: sync.service }),
    ...(store ? { integration: { store, sync: sync.service } } : {}),
    rateLimit: checkRateLimit,
  };
}
