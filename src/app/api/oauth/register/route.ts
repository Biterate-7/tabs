import "server-only";
import { registerClient } from "@/lib/integrations/oauth";
import { oauthJson, oauthStore, preflight, rateLimited } from "@/lib/integrations/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth Dynamic Client Registration (RFC 7591) — how ChatGPT, Claude, the
 * Gemini app, Grok and the Gemini CLI introduce themselves.
 *
 * Open, as DCR for MCP is by design: registering grants nothing. A
 * registered client can only send a person to Hubble's consent page, where
 * the person sees where the result will be sent and decides. Bounded per IP.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = rateLimited(request, "register");
  if (limited) return limited;
  const store = await oauthStore();
  if (!store) return oauthJson(503, { error: "temporarily_unavailable", error_description: "AI integrations are not available on this deployment." });

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 16 * 1024) return oauthJson(400, { error: "invalid_client_metadata", error_description: "The registration request is too large." });
    body = JSON.parse(text);
  } catch {
    return oauthJson(400, { error: "invalid_client_metadata", error_description: "The registration request must be JSON." });
  }
  const answer = await registerClient(store, body, Date.now());
  return oauthJson(answer.status, answer.body);
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
