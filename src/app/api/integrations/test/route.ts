import "server-only";
import { TABDUMP_MCP_WRITE_TOOLS } from "@/lib/mcp/server";
import { accountReference } from "@/lib/mcp/integration-tools";
import { handleMcpHttpRequest } from "@/lib/mcp/http";
import { getMcpDeps } from "@/lib/mcp/services";
import { requestOrigin } from "@/lib/integrations/origin";
import { integrationContext, okJson, readJson, refuse } from "@/lib/integrations/routes";
import { testConnection } from "@/lib/integrations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tests one connection end to end: a short-lived credential with exactly
 * the connection's grant, the official MCP client, and this deployment's
 * real MCP handler, authentication and tools. See `testConnection` for what
 * each step checks.
 *
 * ## In-process, never over the network
 *
 * The MCP requests are handed straight to `handleMcpHttpRequest` with the
 * production dependencies rather than fetched from this deployment's URL.
 * Building that URL from the request's Host / X-Forwarded-Host would let a
 * signed-in caller on a deployment without a header-rewriting proxy point
 * the server — and the test credential — at any host it named (SSRF). The
 * handler path is the one an AI client's request takes after the edge; that
 * the public URL is reachable is shown by the client itself ("last used").
 */
export async function POST(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (!body || typeof body.connectionId !== "string") return refuse("invalid_request", "Hubble could not read that request.", 400);

  const deps = await getMcpDeps();
  if (!deps) return refuse("unavailable", "AI integrations are not available on this deployment.", 503);

  const result = await testConnection(context.store, {
    userId: context.userId,
    connectionId: body.connectionId,
    // Only names the resource the in-process requests are addressed to; nothing is fetched from it.
    issuer: requestOrigin(request),
    fetch: (input, init) => handleMcpHttpRequest(new Request(input, init), deps),
    expectedAccountRef: accountReference(context.userId),
    writeTools: TABDUMP_MCP_WRITE_TOOLS,
    now: () => Date.now(),
  });
  if (!result) return refuse("not_found", "That connection no longer exists.", 404);
  return okJson(result);
}
