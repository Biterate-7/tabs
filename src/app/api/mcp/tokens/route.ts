import "server-only";
import { getSession } from "@/lib/auth/session";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { issueMcpToken, toMcpTokenView } from "@/lib/mcp/tokens";
import { getMcpTokenStore } from "@/lib/mcp/tokens-postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP access tokens for the signed-in user — list, create, revoke.
 *
 * ## Who may call this
 *
 * A signed-in Hubble account, from Hubble's own origin, and nobody else.
 * There is no anonymous actor on this route at all: a token reads
 * account-synced data, so without an account there is nothing for one to
 * read. The session cookie authenticates *this* route; the tokens it mints
 * are what authenticate `/api/mcp`, and neither can stand in for the other.
 *
 * ## The token crosses the wire once
 *
 * `POST` answers with the token itself, exactly once. Every other response —
 * including `POST`'s own `token` sibling fields and every `GET` — is built
 * from `McpTokenView`, which has no field a token or its hash fits in.
 */

const FAILURE_MESSAGES = {
  "invalid-request": "Hubble could not read that request.",
  "sign-in-required": "Sign in to connect Claude Desktop.",
  "mcp-unavailable": "Claude Desktop connections are not available on this deployment.",
  "invalid-name": "Give the connection a name of up to 60 characters.",
  "too-many-tokens": "You already have the maximum number of Claude Desktop connections. Revoke one first.",
  "not-found": "That connection no longer exists.",
} as const;

type FailureCode = keyof typeof FAILURE_MESSAGES;

function refuse(code: FailureCode, status: number): Response {
  return Response.json({ ok: false, error: { code, message: FAILURE_MESSAGES[code] } }, { status });
}

async function signedInUserId(request: Request): Promise<string | null> {
  const session = await getSession(request);
  return session.ok ? session.auth.user.id : null;
}

export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return refuse("invalid-request", 403);
  const userId = await signedInUserId(request);
  if (!userId) return refuse("sign-in-required", 401);

  const store = await getMcpTokenStore().catch(() => undefined);
  if (!store) return refuse("mcp-unavailable", 503);

  const tokens = await store.listForUser(userId);
  return Response.json({ ok: true, value: { tokens: tokens.map(toMcpTokenView) } });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) return refuse("invalid-request", 403);
  const userId = await signedInUserId(request);
  if (!userId) return refuse("sign-in-required", 401);

  const store = await getMcpTokenStore().catch(() => undefined);
  if (!store) return refuse("mcp-unavailable", 503);

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return refuse("invalid-request", 400);
  }

  const issued = await issueMcpToken(store, { userId, name: body?.name, now: Date.now() });
  if (!issued.ok) return refuse(issued.reason, issued.reason === "too-many-tokens" ? 429 : 400);

  return Response.json(
    { ok: true, value: { token: issued.token, connection: issued.view } },
    // Never cached anywhere: this body is the only copy of a live credential.
    { headers: { "cache-control": "no-store" } }
  );
}

export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) return refuse("invalid-request", 403);
  const userId = await signedInUserId(request);
  if (!userId) return refuse("sign-in-required", 401);

  const store = await getMcpTokenStore().catch(() => undefined);
  if (!store) return refuse("mcp-unavailable", 503);

  let body: { tokenId?: unknown };
  try {
    body = (await request.json()) as { tokenId?: unknown };
  } catch {
    return refuse("invalid-request", 400);
  }
  if (typeof body?.tokenId !== "string" || !body.tokenId) return refuse("invalid-request", 400);

  const revoked = await store.revoke(userId, body.tokenId, Date.now());
  return revoked ? Response.json({ ok: true, value: { revoked: true } }) : refuse("not-found", 404);
}
