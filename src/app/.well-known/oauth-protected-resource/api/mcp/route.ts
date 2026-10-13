import { protectedResourceMetadata } from "@/lib/integrations/oauth";
import { requestOrigin } from "@/lib/integrations/origin";
import { preflight, publicJson } from "@/lib/integrations/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected resource metadata for /api/mcp, at the path-specific
 * location the MCP authorization specification has clients try first. The
 * 401 from /api/mcp names this URL in its `resource_metadata` parameter.
 */
export async function GET(request: Request): Promise<Response> {
  return publicJson(protectedResourceMetadata(requestOrigin(request)));
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
