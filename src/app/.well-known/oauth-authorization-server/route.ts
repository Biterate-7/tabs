import { authorizationServerMetadata } from "@/lib/integrations/oauth";
import { requestOrigin } from "@/lib/integrations/origin";
import { preflight, publicJson } from "@/lib/integrations/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 8414 authorization server metadata. The issuer is this deployment's
 * origin, so a preview deployment is a different authorization server from
 * production, with tokens neither accepts from the other.
 */
export async function GET(request: Request): Promise<Response> {
  return publicJson(authorizationServerMetadata(requestOrigin(request)));
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
