import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isSameOrigin } from "@/lib/auth/origin";
import { createHubbleMcpServer } from "./server";
import { authenticateMcpToken, readBearerToken } from "./tokens";
import type { HubbleMcpData } from "./data";
import type { McpTokenStore } from "./tokens";

/**
 * The MCP endpoint, as a function of a web-standard `Request`.
 *
 * Streamable HTTP in its **stateless** form: every POST carries its own
 * bearer token and gets a fresh server bound to that token's account, then a
 * complete JSON response. Nothing is held between requests — which is what a
 * serverless function can honestly offer, and what makes "which account is
 * this?" a question answered per request rather than remembered.
 *
 * ## Authentication: the token, and only the token
 *
 * The session cookie is never read here. A browser that happens to hold a
 * Hubble session gains nothing by calling this endpoint; only an
 * `Authorization: Bearer tdmcp_…` header authenticates. That also removes the
 * cross-site request class entirely — a page cannot attach a header it does
 * not know, and nothing here answers a CORS preflight.
 *
 * A request carrying a *foreign* browser `Origin` is refused outright, as the
 * MCP transport specification requires servers to validate it. Claude
 * Desktop and other non-browser clients send none.
 */

/** Far above any real JSON-RPC request this server accepts; far below anything abusive. */
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;

export type McpHttpDeps = {
  tokens: McpTokenStore;
  data: HubbleMcpData;
  now?: () => number;
};

function jsonRpcError(status: number, code: number, message: string, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
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
  const auth = await authenticateMcpToken(deps.tokens, readBearerToken(request), now);
  if (!auth.ok) {
    // One answer for every failure. Which of missing, malformed, unknown,
    // revoked or expired it was is not something to tell a stranger.
    return jsonRpcError(401, -32001, "A valid Hubble MCP token is required.", {
      "www-authenticate":
        auth.reason === "missing"
          ? 'Bearer realm="Hubble MCP"'
          : 'Bearer realm="Hubble MCP", error="invalid_token"',
    });
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

  const server = createHubbleMcpServer({ data: deps.data, userId: auth.userId, now: deps.now });
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
