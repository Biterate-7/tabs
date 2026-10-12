import "server-only";
import { handleMcpHttpRequest, methodNotAllowed } from "@/lib/mcp/http";
import { getMcpDeps } from "@/lib/mcp/services";

export const runtime = "nodejs";
// Every response depends on the bearer token; nothing here may be cached.
export const dynamic = "force-dynamic";

/**
 * Hubble's MCP server (Streamable HTTP, stateless) — what ChatGPT, Claude,
 * Gemini, Grok and other MCP clients connect to.
 *
 * Access to the credential owner's account-synced Hubble, scoped by that
 * connection's grant: read-only by default, Read and save when the person
 * chose it. See src/lib/mcp/http.ts for the request rules,
 * src/lib/mcp/server.ts and src/lib/mcp/integration-tools.ts for the tools, and
 * docs/ai-integrations.md for setup per client.
 *
 * Like every route.ts, this is absent from the desktop static export
 * (next.config.ts `pageExtensions`), so the packaged app gains nothing here.
 */
export async function POST(request: Request): Promise<Response> {
  const deps = await getMcpDeps();
  if (!deps) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "MCP is not available on this deployment." }, id: null },
      { status: 503 }
    );
  }
  return handleMcpHttpRequest(request, deps);
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
