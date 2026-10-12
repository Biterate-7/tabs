import "server-only";
import { readBasicClientAuth, revokeToken } from "@/lib/integrations/oauth";
import { oauthJson, oauthStore, preflight, rateLimited } from "@/lib/integrations/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 7009 token revocation, for a client disconnecting itself. People disconnect in Hubble's settings. */
export async function POST(request: Request): Promise<Response> {
  const limited = rateLimited(request, "token");
  if (limited) return limited;
  const store = await oauthStore();
  if (!store) return oauthJson(503, { error: "temporarily_unavailable", error_description: "AI integrations are not available on this deployment." });
  const text = await request.text();
  if (text.length > 16 * 1024) return oauthJson(400, { error: "invalid_request", error_description: "The request is too large." });
  const answer = await revokeToken(store, new URLSearchParams(text), readBasicClientAuth(request.headers.get("authorization")), Date.now());
  return oauthJson(answer.status, answer.body);
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
