// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { handleMcpHttpRequest } from "./http";
import { TABDUMP_MCP_TOOLS } from "./server";
import { createMemoryMcpTokenStore, issueMcpToken, mintMcpToken } from "./tokens";
import { ALICE, ALICE_RESEARCH, createFixtureData } from "./__fixtures__/accounts";
import type { McpHttpDeps } from "./http";

/**
 * The Claude Desktop path, end to end on this machine.
 *
 * Claude Desktop launches `node scripts/tabdump-mcp-bridge.mjs` and talks to
 * it over stdio. So does this test, with the official SDK's stdio client —
 * the same transport Claude Desktop uses. The bridge is a real child process
 * speaking real HTTP to a real local server running the route's handler.
 */

const BRIDGE = path.resolve(__dirname, "../../../scripts/tabdump-mcp-bridge.mjs");

let server: Server;
let url: string;
let token: string;
let deps: McpHttpDeps;

beforeAll(async () => {
  const tokens = createMemoryMcpTokenStore();
  deps = { tokens, data: await createFixtureData() };
  const issued = await issueMcpToken(tokens, { userId: ALICE, name: "bridge test", now: Date.now() });
  if (!issued.ok) throw new Error("fixture token");
  token = issued.token;

  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handleMcpHttpRequest(request, deps);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function bridge(env: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    // Exactly what Claude Desktop passes: its own `env` block, nothing inherited
    // beyond what the SDK's default safe environment includes.
    env,
    stderr: "pipe",
  });
}

describe("Claude Desktop → stdio bridge → TabDump MCP", () => {
  it("completes the handshake, discovers the tools, and calls one", async () => {
    const transport = bridge({ TABDUMP_MCP_TOKEN: token, TABDUMP_MCP_URL: url });
    const client = new Client({ name: "claude-desktop-stand-in", version: "1.0.0" });
    await client.connect(transport);

    expect(client.getServerVersion()?.name).toBe("tabdump");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TABDUMP_MCP_TOOLS].sort());

    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    const body = JSON.parse((result.content as { text: string }[])[0].text);
    expect(body.workspaces.map((w: { workspaceId: string }) => w.workspaceId)).toContain(ALICE_RESEARCH);

    await client.close();
  }, 30_000);

  it("answers a refused token with an error rather than hanging", async () => {
    const transport = bridge({ TABDUMP_MCP_TOKEN: mintMcpToken().token, TABDUMP_MCP_URL: url });
    const client = new Client({ name: "claude-desktop-stand-in", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toThrow(/TabDump refused/);
    await client.close().catch(() => {});
  }, 30_000);

  it("never writes the token to stderr, which is Claude Desktop's log", async () => {
    const stolenToken = mintMcpToken().token;
    const transport = bridge({ TABDUMP_MCP_TOKEN: stolenToken, TABDUMP_MCP_URL: url });
    const logged: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => logged.push(chunk.toString("utf8")));
    const client = new Client({ name: "claude-desktop-stand-in", version: "1.0.0" });
    await client.connect(transport).catch(() => {});
    await client.close().catch(() => {});

    const log = logged.join("");
    expect(log).toContain("[tabdump-mcp]");
    expect(log).not.toContain(stolenToken);
    expect(log).not.toContain(stolenToken.slice(6, 20));
  }, 30_000);

  it("refuses to send a token over plain http to anywhere but this machine", async () => {
    const transport = bridge({ TABDUMP_MCP_TOKEN: token, TABDUMP_MCP_URL: "http://tabdump.example.com/api/mcp" });
    const client = new Client({ name: "claude-desktop-stand-in", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => {});
  }, 30_000);
});
