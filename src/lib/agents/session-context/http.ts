import "server-only";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSessionContextMcpServer } from "@/lib/mcp/server";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { SessionContextRegistry } from "./registry";

/**
 * Where an agent session reaches its TabDump context (Phase J.3): TabDump's
 * MCP server, on this machine's loopback interface only.
 *
 * ## Why a port, and why that is still inside the boundary
 *
 * An agent is a separate process, and the one way every agent TabDump drives
 * accepts extra tools is an MCP server it can reach over HTTP (Claude Code's
 * `--mcp-config`, ACP's `session/new` `mcpServers`). So the runtime listens —
 * but only on 127.0.0.1, on a port the OS picks, and it answers nothing
 * without a session credential:
 *
 *   - **POST /mcp only.** Stateless Streamable HTTP: each request carries its
 *     own bearer token and gets a fresh, session-scoped server.
 *   - **The credential is the session.** `registry.authenticate` maps a
 *     256-bit token to exactly one binding — one session, one workspace, one
 *     capability set. A released, unknown or malformed token gets one 401,
 *     whatever the reason.
 *   - **No browser.** A request carrying any `Origin` header is refused, so a
 *     web page cannot reach it even by guessing the port (DNS rebinding
 *     included — the `Host` must also be this exact loopback address).
 *   - **Bounded.** Bodies over 64 KiB are refused before parsing.
 *
 * Closed with the runtime. A restarted runtime listens on a new port with an
 * empty registry.
 */

export const MAX_CONTEXT_REQUEST_BYTES = 64 * 1024;

export type SessionContextServer = {
  /** The loopback URL agents are given. Starts listening on first use. */
  url(): Promise<string>;
  close(): Promise<void>;
};

function refuse(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match?.[1];
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_CONTEXT_REQUEST_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createSessionContextServer(options: {
  registry: SessionContextRegistry;
  now?: () => number;
}): SessionContextServer {
  let server: Server | undefined;
  let listening: Promise<string> | undefined;

  async function handle(req: IncomingMessage, res: ServerResponse, address: string): Promise<void> {
    if (req.method !== "POST" || req.url !== "/mcp") return refuse(res, 405, -32000, "Method not allowed.");
    if (req.headers.origin !== undefined) return refuse(res, 403, -32000, "Forbidden.");
    if (req.headers.host !== address) return refuse(res, 403, -32000, "Forbidden.");

    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > MAX_CONTEXT_REQUEST_BYTES) {
      return refuse(res, 413, -32000, "Request too large.");
    }

    const binding = await options.registry.authenticate(bearer(req));
    if (!binding) return refuse(res, 401, -32001, "A valid TabDump session credential is required.");
    const sessionId = binding.sessionId;

    const text = await readBody(req);
    if (text === undefined) return refuse(res, 413, -32000, "Request too large.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refuse(res, 400, -32700, "Parse error.");
    }

    const mcp = createSessionContextMcpServer({
      scope: {
        // Read live, so a session released while this request runs answers as ended.
        binding: () => options.registry.binding(sessionId),
        createCollection: (input) => options.registry.requestCreateCollection(sessionId, input),
      },
      ...(options.now ? { now: options.now } : {}),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      refuse(res, 500, -32603, "TabDump could not answer that request.");
    } finally {
      await mcp.close().catch(() => {});
    }
  }

  return {
    url() {
      listening ??= new Promise<string>((resolve, reject) => {
        const created = createServer((req, res) => {
          const port = (created.address() as { port: number }).port;
          void handle(req, res, `127.0.0.1:${port}`).catch(() => refuse(res, 500, -32603, "TabDump could not answer that request."));
        });
        created.on("error", reject);
        created.listen(0, "127.0.0.1", () => {
          server = created;
          const port = (created.address() as { port: number }).port;
          resolve(`http://127.0.0.1:${port}/mcp`);
        });
      });
      return listening;
    },

    async close() {
      const current = server;
      server = undefined;
      listening = undefined;
      if (!current) return;
      const closed = new Promise<void>((resolve) => current.close(() => resolve()));
      // Kept-alive connections would otherwise hold `close` open.
      current.closeAllConnections?.();
      await closed;
    },
  };
}
