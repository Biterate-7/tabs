import { protectedResourceMetadata } from "@/lib/integrations/oauth";
import { requestOrigin } from "@/lib/integrations/origin";
import { preflight, publicJson } from "@/lib/integrations/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected resource metadata, at the root well-known path — where
 * an MCP client looks if it does not try the path-specific document
 * (./api/mcp/route.ts) first. Both describe the same resource: /api/mcp.
 *
 * Like every route.ts, absent from the desktop static export.
 */
export async function GET(request: Request): Promise<Response> {
  return publicJson(protectedResourceMetadata(requestOrigin(request)));
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
