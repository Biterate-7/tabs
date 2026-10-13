import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isSameOrigin } from "@/lib/auth/origin";
import { authenticateBearer } from "@/lib/integrations/grants";
import { mcpResourceFor, protectedResourceMetadataUrl } from "@/lib/integrations/oauth";
import { requestOrigin } from "@/lib/integrations/origin";
import { createHubbleMcpServer } from "./server";
import { readBearerToken } from "./tokens";
import type { HubbleMcpData } from "./data";
import type { McpTokenStore } from "./tokens";
import type { IntegrationStore } from "@/lib/integrations/store";
import type { SyncWriterBackend } from "@/lib/integrations/writer";

/**
 * The MCP endpoint, as a function of a web-standard `Request`.
 *
 * Streamable HTTP in its **stateless** form: every POST carries its own
 * bearer credential and gets a fresh server bound to that credential's
 * grant, then a complete JSON response. Nothing is held between requests —
 * which is what a serverless function can honestly offer, and what makes
 * "who is this, and what may they do?" a question answered per request
 * rather than remembered. A reconnecting client loses nothing: everything it
 * can read or has saved lives in the account's synced data and the
 * integration store, never in a session.
 *
 * ## Authentication: a bearer credential, and only that
 *
 * The session cookie is never read here. A browser that happens to hold a
 * Hubble session gains nothing by calling this endpoint; only an
 * `Authorization: Bearer` header authenticates — an OAuth access token
 * (`hbat_`, audience-checked against this endpoint's URL), a personal token
 * (`hbpat_`), Hubble's own connection test (`hbtest_`), or a legacy
 * read-only `tdmcp_` token. That also removes the cross-site request class
 * entirely: a page cannot attach a header it does not know, and nothing here
 * answers a CORS preflight.
 *
 * A refusal follows the MCP authorization specification: 401 with a
 * `WWW-Authenticate` header naming the protected resource metadata, which is
 * how ChatGPT, Claude, Gemini and Grok discover where to sign in.
 *
 * A request carrying a *foreign* browser `Origin` is refused outright, as the
 * MCP transport specification requires servers to validate it. ChatGPT,
 * Claude and the other clients call from their servers or a CLI, with none.
 */

/** Far above any real JSON-RPC request this server accepts; far below anything abusive. */
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;

/** Requests per credential per minute. A busy conversation makes a few dozen; this is a ceiling on abuse. */
export const MCP_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

export type McpHttpDeps = {
  /** Legacy read-only `tdmcp_` tokens. */
  tokens?: McpTokenStore;
  data: HubbleMcpData;
  /** The integration layer: connections, credentials, proposals, context, audit. */
  integration?: { store: IntegrationStore; sync?: SyncWriterBackend };
  /** Fixed-window limiter, keyed per credential. Absent: no limit (tests). */
  rateLimit?: (key: string, limit: { limit: number; windowMs: number }) => { allowed: true } | { allowed: false; retryAfterMs: number };
  now?: () => number;
};

function jsonRpcError(status: number, code: number, message: string, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function methodNotAllowed(): Response {
  // Stateless: there is no server-initiated stream to GET and no session to DELETE.
  return jsonRpcError(405, -32000, "Method not allowed.", { allow: "POST" });
}

export async function handleMcpHttpRequest(request: Request, deps: McpHttpDeps): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  if (!isSameOrigin(request)) return jsonRpcError(403, -32000, "Forbidden.");

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BYTES) {
    return jsonRpcError(413, -32000, "Request too large.");
  }

  const now = (deps.now ?? (() => Date.now()))();
  const issuer = requestOrigin(request);
  const auth = await authenticateBearer(readBearerToken(request), {
    store: deps.integration?.store,
    legacy: deps.tokens,
    now,
    resource: mcpResourceFor(issuer),
  });
  if (!auth.ok) {
    // One answer for every failure. Which of missing, malformed, unknown,
    // revoked, expired or wrong-audience it was is not something to tell a
    // stranger. The metadata pointer is what starts a client's sign-in.
    const metadata = deps.integration ? `, resource_metadata="${protectedResourceMetadataUrl(issuer)}"` : "";
    return jsonRpcError(401, -32001, "A valid Hubble credential is required. Connect Hubble again from your AI client.", {
      "www-authenticate":
        auth.reason === "missing"
          ? `Bearer realm="Hubble MCP"${metadata}`
          : `Bearer realm="Hubble MCP", error="invalid_token"${metadata}`,
    });
  }

  if (deps.rateLimit) {
    const limited = deps.rateLimit(`mcp:${auth.grant.credentialId}`, MCP_RATE_LIMIT);
    if (!limited.allowed) {
      return jsonRpcError(429, -32000, "Too many requests. Try again shortly.", {
        "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))),
      });
    }
  }

  // Read with a hard cap, so a body without an honest content-length is
  // still bounded.
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_MCP_REQUEST_BYTES) return jsonRpcError(413, -32000, "Request too large.");
    body = JSON.parse(text);
  } catch {
    return jsonRpcError(400, -32700, "Parse error.");
  }

  const server = createHubbleMcpServer({
    data: deps.data,
    userId: auth.grant.userId,
    // A legacy token's grant is the server's old one (read, whole account);
    // passing none keeps its instructions exactly what they were.
    ...(auth.grant.method === "legacy" ? {} : { grant: auth.grant }),
    integration: deps.integration ? { ...deps.integration, issuer } : undefined,
    now: deps.now,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    // The JSON response is complete by now. Closing releases the per-request
    // server; there is no stream for a client to keep open.
    await server.close().catch(() => {});
  }
}
