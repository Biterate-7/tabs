// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MAX_ACTIVE_CONNECTIONS } from "@/lib/integrations/oauth";
import { ALICE, BOB, BOB_SPACE, ENDPOINT, HISTORY, PHYSICS, createWorld } from "@/lib/integrations/__fixtures__/world";

/**
 * The /api/integrations/* route handlers — the HTTP layer Settings talks to.
 *
 * The library beneath is covered on its own (service.test.ts, the MCP
 * integration suite); these run the real handlers, so the request checks,
 * the status codes and the connect → narrow → disconnect → reconnect cycle
 * are what the browser actually gets. The session, the sync service and the
 * stores are an in-memory world: no database, nothing outside the process.
 */

const ORIGIN = "https://hubble.test";
const USERS = {
  [ALICE]: { id: ALICE, name: "Alice", email: "alice@example.test" },
  [BOB]: { id: BOB, name: "Bob", email: "bob@example.test" },
} as const;

let world = createWorld();
let signedIn: string | null = ALICE;
let accounts: "configured" | "not-configured" = "configured";
/** What getIntegrationStore does: the migrated store, no schema yet (undefined), or an unreachable database (rejects). */
let storeState: "ready" | "not-migrated" | "unreachable" = "ready";

vi.mock("@/lib/auth/session", () => ({
  getSession: async () => {
    if (accounts === "not-configured") return { ok: false, reason: "not-configured" };
    return signedIn ? { ok: true, auth: { user: USERS[signedIn as keyof typeof USERS] } } : { ok: false, reason: "no-session" };
  },
}));
vi.mock("@/lib/sync/store", () => ({
  getSyncService: async () => ({ ok: true, service: world.sync }),
}));
vi.mock("@/lib/integrations/store-postgres", () => ({
  getIntegrationStore: async () => {
    if (storeState === "unreachable") throw new Error("connect ECONNREFUSED postgresql://owner:s3cret@db.internal/neondb");
    return storeState === "ready" ? world.store : undefined;
  },
}));
vi.mock("@/lib/mcp/tokens-postgres", () => ({
  getMcpTokenStore: async () => world.tokens,
}));
vi.mock("@/lib/mcp/services", () => ({
  getMcpDeps: async () => world.deps,
}));

const overview = await import("./route");
const connections = await import("./connections/route");
const contextRoute = await import("./context/route");
const proposals = await import("./proposals/route");
const testRoute = await import("./test/route");

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, host: "hubble.test", "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

/** The routes answer `{ ok: true, value }` or `{ ok: false, error: { code, message } }`. */
async function valueOf(response: Response) {
  const body = await response.clone().json();
  if (!body.ok) throw new Error(`expected success, got ${response.status} ${JSON.stringify(body.error)}`);
  return body.value;
}

async function errorOf(response: Response): Promise<string> {
  return (await response.clone().json()).error?.code;
}

async function createConnection(body: Record<string, unknown> = {}) {
  const response = await connections.POST(
    request("/api/integrations/connections", "POST", { client: "claude", label: "Claude Code", permission: "write", workspaceIds: [PHYSICS], ...body })
  );
  const answer = await response.clone().json();
  return { response, body: answer.ok ? answer.value : undefined, error: answer.ok ? undefined : (answer.error.code as string) };
}

async function mcp(token: string): Promise<Client> {
  const client = new Client({ name: "routes-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: world.fetchMcp })
  );
  return client;
}

async function toolNames(token: string): Promise<string[]> {
  return (await (await mcp(token)).listTools()).tools.map((tool) => tool.name);
}

beforeEach(() => {
  world = createWorld();
  signedIn = ALICE;
  accounts = "configured";
  storeState = "ready";
});

describe("every /api/integrations route checks the request before doing anything", () => {
  const mutating = [
    ["POST /connections", () => connections.POST, "/api/integrations/connections", "POST", { client: "claude", label: "x", permission: "read", workspaceIds: [PHYSICS] }],
    ["PATCH /connections", () => connections.PATCH, "/api/integrations/connections", "PATCH", { connectionId: "conn_x", permission: "read" }],
    ["DELETE /connections", () => connections.DELETE, "/api/integrations/connections", "DELETE", { connectionId: "conn_x" }],
    ["DELETE /context", () => contextRoute.DELETE, "/api/integrations/context", "DELETE", { workspaceId: PHYSICS }],
    ["POST /proposals", () => proposals.POST, "/api/integrations/proposals", "POST", { proposalId: "prop_x", action: "approve" }],
    ["POST /test", () => testRoute.POST, "/api/integrations/test", "POST", { connectionId: "conn_x" }],
  ] as const;

  it.each(mutating)("%s refuses a cross-site request and a non-JSON body with 403, creating nothing", async (_name, handler, path, method, body) => {
    const crossSite = await handler()(request(path, method, body, { origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
    const formPost = await handler()(request(path, method, body, { "content-type": "application/x-www-form-urlencoded" }));
    expect(formPost.status).toBe(403);
    expect(await world.store.listConnections(ALICE)).toEqual([]);
  });

  it.each(mutating)("%s asks a signed-out visitor to sign in (401)", async (_name, handler, path, method, body) => {
    signedIn = null;
    const response = await handler()(request(path, method, body));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe("sign_in_required");
  });

  it("GET / refuses a cross-site read too, but needs no JSON content type", async () => {
    expect((await overview.GET(request("/api/integrations", "GET", undefined, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await overview.GET(request("/api/integrations", "GET", undefined, { "content-type": "text/plain" }))).status).toBe(200);
  });

  it("answers 503 when accounts are not configured, when the schema is not migrated, and when the database is unreachable — without leaking why", async () => {
    for (const setup of [
      () => (accounts = "not-configured"),
      () => (storeState = "not-migrated"),
      () => (storeState = "unreachable"),
    ]) {
      accounts = "configured";
      storeState = "ready";
      setup();
      for (const response of [await overview.GET(request("/api/integrations", "GET")), (await createConnection()).response]) {
        expect(response.status).toBe(503);
        const text = await response.clone().text();
        expect(await errorOf(response)).toBe("unavailable");
        expect(text).not.toMatch(/ECONNREFUSED|postgres|s3cret|db\.internal/i);
      }
    }
    expect(await world.store.listConnections(ALICE)).toEqual([]);
  });

  it("refuses an unreadable or oversized body with 400", async () => {
    expect((await connections.POST(request("/api/integrations/connections", "POST", "{not json"))).status).toBe(400);
    expect((await connections.POST(request("/api/integrations/connections", "POST", "[1,2]"))).status).toBe(400);
    const huge = JSON.stringify({ client: "claude", label: "x".repeat(70 * 1024), permission: "read", workspaceIds: [PHYSICS] });
    expect((await connections.POST(request("/api/integrations/connections", "POST", huge))).status).toBe(400);
    expect((await connections.PATCH(request("/api/integrations/connections", "PATCH", { permission: "read" }))).status).toBe(400);
    expect((await connections.DELETE(request("/api/integrations/connections", "DELETE", {}))).status).toBe(400);
  });
});

describe("a token connection, from Settings, through its whole life", () => {
  it("connects, works, narrows, disconnects, and reconnects with a fresh credential while the old one stays dead", async () => {
    // Connect: the token crosses the wire once, uncached, and works at once.
    const created = await createConnection();
    expect(created.response.status).toBe(200);
    expect(created.response.headers.get("cache-control")).toBe("no-store");
    const token: string = created.body.token;
    expect(token).toMatch(/^hbpat_/);
    expect(await toolNames(token)).toContain("save_workspace_note");

    // Listed, with a hint but never the token itself.
    const listed = await (await overview.GET(request("/api/integrations", "GET"))).text();
    expect(listed).not.toContain(token);
    const view = JSON.parse(listed).value;
    expect(view.mcpUrl).toBe(ENDPOINT);
    expect(view.connections).toHaveLength(1);
    expect(view.connections[0]).toMatchObject({ id: created.body.connection.id, permission: "write", workspaceIds: [PHYSICS], method: "token" });
    expect(view.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([HISTORY, PHYSICS].sort());

    // Narrow to read only: the write tools are gone on the very next request.
    const narrowed = await connections.PATCH(request("/api/integrations/connections", "PATCH", { connectionId: created.body.connection.id, permission: "read" }));
    expect(narrowed.status).toBe(200);
    const readOnly = await toolNames(token);
    expect(readOnly).toContain("list_workspaces");
    expect(readOnly).not.toContain("save_workspace_note");

    // Disconnect: the token is refused, the list is empty, a second disconnect is a 404.
    const revoked = await connections.DELETE(request("/api/integrations/connections", "DELETE", { connectionId: created.body.connection.id }));
    expect(revoked.status).toBe(200);
    await expect(mcp(token)).rejects.toThrow();
    expect((await valueOf(await overview.GET(request("/api/integrations", "GET")))).connections).toEqual([]);
    expect((await connections.DELETE(request("/api/integrations/connections", "DELETE", { connectionId: created.body.connection.id }))).status).toBe(404);
    expect((await connections.PATCH(request("/api/integrations/connections", "PATCH", { connectionId: created.body.connection.id, permission: "write" }))).status).toBe(404);

    // Reconnect: a new connection with a new token; the old one stays refused.
    const again = await createConnection({ permission: "read" });
    expect(again.response.status).toBe(200);
    expect(again.body.token).not.toBe(token);
    expect(again.body.connection.id).not.toBe(created.body.connection.id);
    expect(await toolNames(again.body.token)).toContain("list_workspaces");
    await expect(mcp(token)).rejects.toThrow();
    expect((await valueOf(await overview.GET(request("/api/integrations", "GET")))).connections).toHaveLength(1);
  });

  it("refuses invalid input with 400 and a workspace the account does not own as unknown", async () => {
    for (const [body, problem] of [
      [{ client: "skynet" }, "invalid_client"],
      [{ label: "" }, "invalid_label"],
      [{ permission: "admin" }, "invalid_permission"],
      [{ workspaceIds: [] }, "no_workspaces"],
      [{ workspaceIds: [BOB_SPACE] }, "unknown_workspace"],
    ] as const) {
      const { response, error } = await createConnection(body);
      expect(response.status, problem).toBe(400);
      expect(error, problem).toBe(problem);
    }
    expect(await world.store.listConnections(ALICE)).toEqual([]);
  });

  it("answers another account's connection exactly as a missing one, and changes nothing", async () => {
    const bobs = await world.connect(BOB, "write", [BOB_SPACE], "grok");
    expect((await connections.PATCH(request("/api/integrations/connections", "PATCH", { connectionId: bobs.connection.id, permission: "read" }))).status).toBe(404);
    expect((await connections.DELETE(request("/api/integrations/connections", "DELETE", { connectionId: bobs.connection.id }))).status).toBe(404);
    expect((await testRoute.POST(request("/api/integrations/test", "POST", { connectionId: bobs.connection.id }))).status).toBe(404);
    expect(await toolNames(bobs.token)).toContain("save_workspace_note");
  });

  it("refuses a PATCH that would grant a workspace the account does not own", async () => {
    const { body } = await createConnection();
    const response = await connections.PATCH(request("/api/integrations/connections", "PATCH", { connectionId: body.connection.id, workspaceIds: [BOB_SPACE] }));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("unknown_workspace");
  });

  it(`stops at ${MAX_ACTIVE_CONNECTIONS} live connections with 429, and frees a slot on disconnect`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_CONNECTIONS; i++) ids.push((await createConnection({ label: `c${i}` })).body.connection.id);
    const over = await createConnection({ label: "one too many" });
    expect(over.response.status).toBe(429);
    expect(over.error).toBe("too_many_connections");

    await connections.DELETE(request("/api/integrations/connections", "DELETE", { connectionId: ids[0] }));
    expect((await createConnection({ label: "after a disconnect" })).response.status).toBe(200);
  });

  it("runs the connection test for the person's own connection over the real MCP endpoint", async () => {
    const { body } = await createConnection({ permission: "read" });
    const response = await testRoute.POST(request("/api/integrations/test", "POST", { connectionId: body.connection.id }));
    expect(response.status).toBe(200);
    const result = await valueOf(response);
    expect(result.ok).toBe(true);
    expect(result.steps.map((step: { id: string }) => step.id)).toEqual(["handshake", "identity", "listing", "permissions"]);
  });
});

describe("saved context and proposals", () => {
  it("reads and clears saved project context only for the person's own workspace", async () => {
    expect((await contextRoute.GET(request(`/api/integrations/context?workspaceId=${BOB_SPACE}`, "GET"))).status).toBe(404);
    expect((await contextRoute.GET(request("/api/integrations/context", "GET"))).status).toBe(400);

    const { token } = await world.connect(ALICE, "write", [PHYSICS]);
    const client = await mcp(token);
    const saved = await client.callTool({ name: "save_workspace_note", arguments: { workspaceId: PHYSICS, title: "Exam plan", body: "Revise relativity first." } });
    expect(saved.isError).not.toBe(true);

    const read = await valueOf(await contextRoute.GET(request(`/api/integrations/context?workspaceId=${PHYSICS}`, "GET")));
    expect(read.notesTotal).toBe(1);
    const noteId: string = read.notes[0].id;

    // Bob cannot delete Alice's note, even naming his own workspace.
    signedIn = BOB;
    expect((await contextRoute.DELETE(request("/api/integrations/context", "DELETE", { workspaceId: BOB_SPACE, noteId }))).status).toBe(404);
    signedIn = ALICE;

    expect((await contextRoute.DELETE(request("/api/integrations/context", "DELETE", { workspaceId: PHYSICS, noteId }))).status).toBe(200);
    expect((await contextRoute.DELETE(request("/api/integrations/context", "DELETE", { workspaceId: PHYSICS, noteId }))).status).toBe(404);
    expect((await valueOf(await contextRoute.GET(request(`/api/integrations/context?workspaceId=${PHYSICS}`, "GET")))).notesTotal).toBe(0);
  });

  it("maps every proposal outcome to a status: unknown is 404, out of order is 409, bad input is 400", async () => {
    expect((await proposals.POST(request("/api/integrations/proposals", "POST", { proposalId: "prop_missing", action: "approve" }))).status).toBe(404);
    expect((await proposals.POST(request("/api/integrations/proposals", "POST", { proposalId: "prop_missing", action: "delete" }))).status).toBe(400);
    expect((await proposals.POST(request("/api/integrations/proposals", "POST", { action: "approve" }))).status).toBe(400);

    const { token } = await world.connect(ALICE, "write", [PHYSICS]);
    const client = await mcp(token);
    const proposed = await client.callTool({ name: "propose_organization", arguments: { workspaceId: PHYSICS, summary: "Group the physics tabs" } });
    expect(proposed.isError).not.toBe(true);
    const proposalId: string = JSON.parse((proposed.content as { text: string }[])[0].text).proposalId;

    expect((await proposals.POST(request("/api/integrations/proposals", "POST", { proposalId, action: "apply" }))).status).toBe(409);
    signedIn = BOB;
    expect((await proposals.POST(request("/api/integrations/proposals", "POST", { proposalId, action: "approve" }))).status).toBe(404);
    signedIn = ALICE;
    const approved = await proposals.POST(request("/api/integrations/proposals", "POST", { proposalId, action: "approve" }));
    expect(approved.status).toBe(200);
    expect((await valueOf(approved)).proposal.status).toBe("approved");
    expect((await proposals.POST(request("/api/integrations/proposals", "POST", { proposalId, action: "approve" }))).status).toBe(409);
  });
});
