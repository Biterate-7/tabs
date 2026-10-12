import "server-only";
import { exchangeToken, readBasicClientAuth } from "@/lib/integrations/oauth";
import { requestOrigin } from "@/lib/integrations/origin";
import { oauthJson, oauthStore, preflight, rateLimited } from "@/lib/integrations/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The OAuth token endpoint: an authorization code (with its PKCE verifier)
 * or a refresh token, for an access token on /api/mcp and a new refresh
 * token. Form-encoded, as RFC 6749 requires. No cookie is read.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = rateLimited(request, "token");
  if (limited) return limited;
  const store = await oauthStore();
  if (!store) return oauthJson(503, { error: "temporarily_unavailable", error_description: "AI integrations are not available on this deployment." });

  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return oauthJson(400, { error: "invalid_request", error_description: "Send the token request as application/x-www-form-urlencoded." });
  }
  const text = await request.text();
  if (text.length > 16 * 1024) return oauthJson(400, { error: "invalid_request", error_description: "The token request is too large." });

  const answer = await exchangeToken(store, new URLSearchParams(text), readBasicClientAuth(request.headers.get("authorization")), requestOrigin(request), Date.now());
  const response = oauthJson(answer.status, answer.body);
  if (answer.status === 401) response.headers.set("www-authenticate", 'Basic realm="Hubble OAuth"');
  return response;
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
