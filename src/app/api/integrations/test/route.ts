import "server-only";
import { TABDUMP_MCP_WRITE_TOOLS } from "@/lib/mcp/server";
import { accountReference } from "@/lib/mcp/integration-tools";
import { requestOrigin } from "@/lib/integrations/origin";
import { integrationContext, okJson, readJson, refuse } from "@/lib/integrations/routes";
import { testConnection } from "@/lib/integrations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The test makes real MCP requests to this deployment's own /api/mcp.
export const maxDuration = 30;

/**
 * Tests one connection end to end: a short-lived credential with exactly
 * the connection's grant, the official MCP client, this deployment's real
 * endpoint over HTTP. See `testConnection` for what each step checks.
 */
export async function POST(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (!body || typeof body.connectionId !== "string") return refuse("invalid_request", "Hubble could not read that request.", 400);

  const result = await testConnection(context.store, {
    userId: context.userId,
    connectionId: body.connectionId,
    issuer: requestOrigin(request),
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    expectedAccountRef: accountReference(context.userId),
    writeTools: TABDUMP_MCP_WRITE_TOOLS,
    now: () => Date.now(),
  });
  if (!result) return refuse("not_found", "That connection no longer exists.", 404);
  return okJson(result);
}
