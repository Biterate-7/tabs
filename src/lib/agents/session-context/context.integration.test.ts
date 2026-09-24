// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSessionContextServer } from "./http";
import { CREDENTIAL_MAX_AGE_MS, createSessionContextRegistry } from "./registry";
import type { ApprovalOutcome, ContextApprovalRequest, SessionContextRegistry } from "./registry";
import type { SessionContextServer } from "./http";

/**
 * The session context layer against the real thing (Phase J.3): a real
 * loopback HTTP server, the real session-mode MCP server, and the official
 * MCP client SDK — the same client code Claude Code and ACP agents use.
 *
 * Every security property the brief names is asserted here, at the server,
 * not in a UI: workspace isolation, session isolation, credential revocation
 * on release, on runtime restart, capability separation, and writes that
 * cannot happen without an approval.
 */

function snapshot(workspaceId: string, name: string, tabs: { id: string; title: string; url: string }[]) {
  return {
    workspace: {
      id: workspaceId,
      name,
      createdAt: 1,
      updatedAt: 2,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        url: tab.url,
        normalizedUrl: tab.url,
        domain: new URL(tab.url).hostname,
        title: tab.title,
      })),
    },
    collections: [{ id: `${workspaceId}-c1`, workspaceId, name: "Existing", tabIds: [tabs[0].id], createdAt: 1, updatedAt: 1 }],
    dependencies: [],
  };
}

const LAUNCH_PLAN = snapshot("ws-launch", "Launch Plan", [
  { id: "t-pricing", title: "Pricing page competitors", url: "https://example.com/pricing?secret_token=abc123" },
  { id: "t-press", title: "Press kit checklist", url: "https://news.example.org/press" },
  { id: "t-launch", title: "Launch day runbook", url: "https://docs.example.net/runbook" },
]);
const PRIVATE = snapshot("ws-private", "Private finances", [
  { id: "t-bank", title: "Bank statements", url: "https://bank.example.com/statements" },
]);

type Harness = {
  registry: SessionContextRegistry;
  server: SessionContextServer;
  approvals: ContextApprovalRequest[];
  answer: (outcome: ApprovalOutcome) => void;
};

const open: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.close();
});

function harness(options: { now?: () => number } = {}): Harness {
  const approvals: ContextApprovalRequest[] = [];
  let pending: ((outcome: ApprovalOutcome) => void) | undefined;
  const registry = createSessionContextRegistry({
    ...(options.now ? { now: options.now } : {}),
    approve: (request) => {
      approvals.push(request);
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
  });
  const server = createSessionContextServer({ registry });
  open.push(server);
  return { registry, server, approvals, answer: (outcome) => pending?.(outcome) };
}

async function connect(url: string, token: string | undefined, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } },
    })
  );
  return client;
}

function text(result: unknown): string {
  return ((result as { content: { text: string }[] }).content[0]?.text ?? "") as string;
}

async function bind(h: Harness, sessionId: string, data: unknown, workspaceId: string, access: "read" | "read_write" = "read") {
  const bound = await h.registry.bind({ sessionId, ownerId: "local", workspaceId, access, snapshot: data });
  if (!bound) throw new Error("bind failed");
  return bound.token;
}

describe("workspace context over MCP", () => {
  it("gives a session its workspace, queryable — never a dump", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch");
    const client = await connect(await h.server.url(), token);

    const current = JSON.parse(text(await client.callTool({ name: "get_current_workspace", arguments: {} })));
    const labels = JSON.stringify(current.items);
    expect(labels).toContain("Launch Plan");
    expect(labels).toContain("Pricing page competitors");
    // The same redaction as every TabDump answer: the secret query value is gone.
    expect(labels).not.toContain("abc123");

    const found = JSON.parse(text(await client.callTool({ name: "search_tabs", arguments: { query: "press" } })));
    expect(JSON.stringify(found.items)).toContain("Press kit checklist");
    expect(JSON.stringify(found.items)).not.toContain("Launch day runbook");
    await client.close();
  });

  it("DENIES a session asking for another workspace, at the server", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch");
    await bind(h, "s2", PRIVATE, "ws-private");
    const client = await connect(await h.server.url(), token);

    const listed = JSON.parse(text(await client.callTool({ name: "list_workspaces", arguments: {} })));
    expect(listed.workspaces.map((workspace: { workspaceId: string }) => workspace.workspaceId)).toEqual(["ws-launch"]);

    for (const [name, args] of [
      ["get_workspace", { workspaceId: "ws-private" }],
      ["get_tabs", { workspaceId: "ws-private", tabIds: ["t-bank"] }],
      ["get_collection", { workspaceId: "ws-private", collectionId: "ws-private-c1" }],
      ["get_tab_graph", { workspaceId: "ws-private", tabId: "t-bank" }],
    ] as const) {
      const denied = await client.callTool({ name, arguments: args });
      expect(denied.isError, name).toBe(true);
      expect(text(denied), name).toBe("This session can only read the TabDump workspace it was started from.");
    }
    // And another workspace's tab id, asked about without naming its workspace, is simply not there.
    const guessed = JSON.parse(text(await client.callTool({ name: "get_tabs", arguments: { tabIds: ["t-bank"] } })));
    expect(JSON.stringify(guessed)).not.toContain("Bank statements");
    await client.close();
  });

  it("keeps sessions apart: each credential is exactly one session", async () => {
    const h = harness();
    const tokenA = await bind(h, "sA", LAUNCH_PLAN, "ws-launch");
    const tokenB = await bind(h, "sB", PRIVATE, "ws-private");
    const url = await h.server.url();
    const a = await connect(url, tokenA);
    const b = await connect(url, tokenB);
    expect(text(await a.callTool({ name: "get_current_workspace", arguments: {} }))).toContain("Launch Plan");
    expect(text(await b.callTool({ name: "get_current_workspace", arguments: {} }))).toContain("Private finances");
    expect(text(await b.callTool({ name: "get_current_workspace", arguments: {} }))).not.toContain("Launch Plan");
    expect(tokenA).not.toBe(tokenB);
    await a.close();
    await b.close();
  });
});

describe("the credential lifecycle", () => {
  it("refuses a missing, wrong or malformed credential", async () => {
    const h = harness();
    await bind(h, "s1", LAUNCH_PLAN, "ws-launch");
    const url = await h.server.url();
    await expect(connect(url, undefined)).rejects.toThrow();
    await expect(connect(url, "tdctx_not-a-real-token")).rejects.toThrow();
    await expect(connect(url, "Bearer-shaped-garbage")).rejects.toThrow();
  });

  it("stops working the moment the session is released (dispose / disconnect)", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch");
    const url = await h.server.url();
    const client = await connect(url, token);
    await client.callTool({ name: "get_current_workspace", arguments: {} });

    h.registry.release("s1");

    expect(h.registry.activeCount()).toBe(0);
    await expect(client.callTool({ name: "get_current_workspace", arguments: {} })).rejects.toThrow();
    await expect(connect(url, token)).rejects.toThrow();
  });

  it("is useless after a runtime restart: a new runtime knows no old credential", async () => {
    const first = harness();
    const token = await bind(first, "s1", LAUNCH_PLAN, "ws-launch");
    const oldUrl = await first.server.url();
    first.registry.releaseAll();
    await first.server.close();

    const second = harness();
    await bind(second, "s1", LAUNCH_PLAN, "ws-launch");
    // The same session id, the same workspace — and still the old token does nothing.
    await expect(connect(await second.server.url(), token)).rejects.toThrow();
    await expect(connect(oldUrl, token)).rejects.toThrow();
  });

  it("expires on its own, even for a session that never ends", async () => {
    let clock = 1_000_000;
    const h = harness({ now: () => clock });
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch");
    const url = await h.server.url();

    clock += CREDENTIAL_MAX_AGE_MS - 1;
    const client = await connect(url, token);
    await client.callTool({ name: "get_current_workspace", arguments: {} });

    clock += 1;
    await expect(client.callTool({ name: "get_current_workspace", arguments: {} })).rejects.toThrow();
    await expect(connect(url, token)).rejects.toThrow();
    // Forgotten, not paused: winding the clock back does not revive it.
    clock -= CREDENTIAL_MAX_AGE_MS;
    await expect(connect(url, token)).rejects.toThrow();
    // The session itself is untouched — only the agent's access ended.
    expect(h.registry.binding("s1")?.workspaceId).toBe("ws-launch");
  });

  it("refuses any browser, and any other host name", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch");
    const url = await h.server.url();
    await expect(connect(url, token, { Origin: "https://evil.example" })).rejects.toThrow();
    const response = await fetch(url.replace("127.0.0.1", "localhost"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
  });

  it("never puts the credential in anything it returns", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch", "read_write");
    const client = await connect(await h.server.url(), token);
    const outputs = [
      await client.listTools(),
      await client.callTool({ name: "get_current_workspace", arguments: {} }),
      await client.callTool({ name: "list_workspaces", arguments: {} }),
    ];
    expect(JSON.stringify(outputs)).not.toContain(token);
    expect(JSON.stringify(outputs)).not.toContain(token.slice(6, 30));
    await client.close();
  });
});

describe("capabilities and approval", () => {
  it("does not give a read-only session any way to write", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch", "read");
    const client = await connect(await h.server.url(), token);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).not.toContain("create_collection");
    const attempt = await client.callTool({ name: "create_collection", arguments: { name: "x", tabIds: ["t-press"] } });
    expect(attempt.isError).toBe(true);
    expect(h.approvals).toEqual([]);
    expect(await h.registry.requestCreateCollection("s1", { name: "x", tabIds: ["t-press"] })).toEqual({
      ok: false,
      reason: "not_permitted",
    });
    await client.close();
  });

  it("creates nothing until the user approves — and nothing at all when they decline", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch", "read_write");
    const client = await connect(await h.server.url(), token);

    const call = client.callTool({ name: "create_collection", arguments: { name: "Launch sources", tabIds: ["t-press", "t-launch"] } });
    await until(() => h.approvals.length === 1);
    expect(h.approvals[0]).toMatchObject({ sessionId: "s1", workspaceId: "ws-launch" });
    expect(h.approvals[0].targets[0]).toBe('New collection "Launch sources" with 2 tabs');
    // Waiting on the user: nothing to apply yet.
    expect(h.registry.pendingApplications("s1")).toEqual([]);

    h.answer("denied");
    const declined = await call;
    expect(declined.isError).toBe(true);
    expect(text(declined)).toBe("The user declined this change. Nothing was created.");
    expect(h.registry.pendingApplications("s1")).toEqual([]);
    await client.close();
  });

  it("creates nothing when the approval expires unanswered", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch", "read_write");
    const client = await connect(await h.server.url(), token);

    const call = client.callTool({ name: "create_collection", arguments: { name: "Stale", tabIds: ["t-press"] } });
    await until(() => h.approvals.length === 1);
    h.answer("expired");
    const result = await call;
    expect(result.isError).toBe(true);
    expect(h.registry.pendingApplications("s1")).toEqual([]);
    await client.close();
  });

  it("applies an approved change through the Command Centre, then tells the agent", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch", "read_write");
    const client = await connect(await h.server.url(), token);

    const call = client.callTool({ name: "create_collection", arguments: { name: "Launch sources", tabIds: ["t-press"] } });
    await until(() => h.approvals.length === 1);
    h.answer("granted");
    await until(() => h.registry.pendingApplications("s1").length === 1);

    const [action] = h.registry.pendingApplications("s1");
    expect(action).toMatchObject({ kind: "create_collection", name: "Launch sources", tabIds: ["t-press"], workspaceId: "ws-launch" });
    // The Command Centre cannot complete an action for another session, or one never approved.
    expect(h.registry.complete("someone-else", action.id, { ok: true, collectionId: "c-9" })).toBe(false);
    expect(h.registry.complete("s1", "made-up", { ok: true, collectionId: "c-9" })).toBe(false);
    expect(h.registry.complete("s1", action.id, { ok: true, collectionId: "c-new" })).toBe(true);

    const created = JSON.parse(text(await call));
    expect(created).toEqual({ created: true, collectionId: "c-new", name: "Launch sources", tabCount: 1 });
    await client.close();
  });

  it("refuses a proposal naming a tab of another workspace, without asking anyone", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch", "read_write");
    await bind(h, "s2", PRIVATE, "ws-private");
    const client = await connect(await h.server.url(), token);
    const refused = await client.callTool({ name: "create_collection", arguments: { name: "Steal", tabIds: ["t-press", "t-bank"] } });
    expect(refused.isError).toBe(true);
    expect(h.approvals).toEqual([]);
    await client.close();
  });

  it("answers a waiting write as ended when the session ends", async () => {
    const h = harness();
    const token = await bind(h, "s1", LAUNCH_PLAN, "ws-launch", "read_write");
    const client = await connect(await h.server.url(), token);
    const call = client.callTool({ name: "create_collection", arguments: { name: "Later", tabIds: ["t-press"] } });
    await until(() => h.approvals.length === 1);
    h.registry.release("s1");
    const ended = await call;
    expect(text(ended)).toBe("This TabDump session has ended.");
    await client.close().catch(() => {});
  });
});

describe("binding", () => {
  it("binds only the workspace named, and never moves it", async () => {
    const h = harness();
    expect(await h.registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "ws-launch", access: "read", snapshot: PRIVATE })).toBeUndefined();
    await bind(h, "s1", LAUNCH_PLAN, "ws-launch");
    expect(h.registry.update("s1", PRIVATE)).toBe(false);
    expect(h.registry.binding("s1")?.workspaceId).toBe("ws-launch");
    expect(h.registry.update("s1", { ...LAUNCH_PLAN, workspace: { ...LAUNCH_PLAN.workspace, name: "Launch Plan v2" } })).toBe(true);
    expect(h.registry.binding("s1")?.snapshot.workspace.name).toBe("Launch Plan v2");
  });
});

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
