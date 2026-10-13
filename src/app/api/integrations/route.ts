import "server-only";
import { getMcpTokenStore } from "@/lib/mcp/tokens-postgres";
import { toMcpTokenView } from "@/lib/mcp/tokens";
import { requestOrigin } from "@/lib/integrations/origin";
import { grantableWorkspaces, integrationContext, okJson } from "@/lib/integrations/routes";
import { listActivityViews, listConnectionViews, listProposalViews } from "@/lib/integrations/service";
import { mcpServerUrl } from "@/lib/integrations/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the AI Integrations pane shows, for the signed-in person: their
 * connections and each one's real status, proposals waiting for them, recent
 * activity, the synced workspaces a connection could be granted, older
 * read-only Claude Desktop tokens, and this deployment's MCP URL.
 */
export async function GET(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: false });
  if (context instanceof Response) return context;
  const { store, sync, userId } = context;
  const now = Date.now();
  const before = Number(new URL(request.url).searchParams.get("before") ?? "");

  const [connections, proposals, activity, workspaces, legacy] = await Promise.all([
    listConnectionViews(store, userId, now),
    listProposalViews(store, userId, now),
    listActivityViews(store, userId, { limit: 40, ...(Number.isFinite(before) && before > 0 ? { before } : {}) }),
    grantableWorkspaces(sync, userId),
    getMcpTokenStore()
      .then((tokens) => tokens?.listForUser(userId) ?? [])
      .catch(() => []),
  ]);

  return okJson({
    mcpUrl: mcpServerUrl(requestOrigin(request)),
    connections,
    proposals,
    activity,
    workspaces,
    legacyTokens: legacy.map(toMcpTokenView).filter((token) => !token.revoked && token.expiresAt > now),
  });
}
