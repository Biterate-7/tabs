// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { bind, call, closeServers, harness } from "./__fixtures__/harness";
import { CONTEXT_SERVER_METHODS } from "./http";

/**
 * MCP resources fail closed on the session context server.
 *
 * Every read an agent makes of Hubble goes through a tool, and every tool call
 * is decided by `authorizeContextRequest`. MCP resources are a second way in
 * that no Hubble decision covers — Codex reads them with `read_mcp_resource`
 * and asks nobody. Today the server registers none, which made this harmless
 * by accident. These tests make it an invariant: a resource operation is
 * refused before the MCP SDK sees it, **even when a resource is registered**.
 *
 * To prove the last part, the real server factory is wrapped so every
 * session server it builds carries a resource holding a secret — the
 * mistake a later change could make. Nothing in production is changed for
 * the test.
 */

const SECRET = "RESOURCE-SECRET-8f41";

vi.mock("@/lib/mcp/server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/mcp/server")>();
  return {
    ...actual,
    createSessionContextMcpServer: (...args: Parameters<typeof actual.createSessionContextMcpServer>) => {
      const server = actual.createSessionContextMcpServer(...args);
      server.registerResource("leak", "hubble://leak", { mimeType: "text/plain" }, async (uri) => ({
        contents: [{ uri: uri.href, text: SECRET }],
      }));
      server.registerPrompt("leak-prompt", { description: "x" }, async () => ({
        messages: [{ role: "user", content: { type: "text", text: SECRET } }],
      }));
      return server;
    },
  };
});

afterEach(closeServers);

/** A raw JSON-RPC request with the session's credential, as any MCP client would send it. */
async function rpc(url: string, token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
  return { status: response.status, text: await response.text() };
}

async function boundToken() {
  const h = harness();
  const bound = await h.registry.bind({
    sessionId: "s-res",
    ownerId: "local",
    workspaceId: "ws-student",
    access: "read",
    snapshot: {
      workspace: { id: "ws-student", name: "Senior year", createdAt: 1, updatedAt: 2, tabs: [] },
      collections: [],
      dependencies: [],
    },
  });
  if (!bound) throw new Error("bind failed");
  return { h, url: await h.server.url(), token: bound.token };
}

describe("MCP resource access on the session context server", () => {
  it("answers only the tool methods, and nothing that reads around them", () => {
    expect([...CONTEXT_SERVER_METHODS].sort()).toEqual(["initialize", "ping", "tools/call", "tools/list"]);
  });

  it.each([
    ["resources/read", { uri: "hubble://leak" }],
    ["resources/list", {}],
    ["resources/templates/list", {}],
    ["resources/subscribe", { uri: "hubble://leak" }],
    ["prompts/list", {}],
    ["prompts/get", { name: "leak-prompt" }],
    ["completion/complete", { ref: { type: "ref/prompt", name: "leak-prompt" }, argument: { name: "x", value: "" } }],
    ["logging/setLevel", { level: "debug" }],
  ])("refuses %s with a valid session credential — even with a resource registered", async (method, params) => {
    const { url, token } = await boundToken();
    const answered = await rpc(url, token, method, params);
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.text)).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32601 } });
    expect(answered.text).not.toContain(SECRET);
    expect(answered.text).not.toContain("hubble://leak");
  });

  it("refuses a resource read hidden in a batch alongside an allowed call", async () => {
    const { url, token } = await boundToken();
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "hubble://leak" } },
      ]),
    });
    const text = await response.text();
    expect(text).toContain("-32601");
    expect(text).not.toContain(SECRET);
  });

  it("refuses it through the official MCP client too", async () => {
    const h = harness();
    const client = await bind(h, { access: "read" });
    await expect(client.readResource({ uri: "hubble://leak" })).rejects.toThrow();
    await expect(client.listResources()).rejects.toThrow();
    await expect(client.getPrompt({ name: "leak-prompt" })).rejects.toThrow();
    await client.close();
  });

  it("still serves Hubble's read-only context tools, governed by the session's own authorization", async () => {
    const h = harness();
    const client = await bind(h, { access: "read" });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("get_workspace");
    const workspace = await call(client, "get_workspace");
    expect(workspace.isError).toBe(false);
    expect(workspace.text).toContain("Senior year");
    // And never the other session's workspace.
    expect(workspace.text).not.toContain("Bank statement");
    await client.close();
  });

  it("refuses everything without a session credential, as before", async () => {
    const { url } = await boundToken();
    const answered = await rpc(url, "not-a-token", "resources/read", { uri: "hubble://leak" });
    expect(answered.status).toBe(401);
    expect(answered.text).not.toContain(SECRET);
  });
});
