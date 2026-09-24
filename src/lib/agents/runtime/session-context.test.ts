// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createFakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { createRuntimeHost, sessionContextAccessFor } from "./host";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { RuntimeCommand } from "./protocol";
import type { SessionContextServer } from "@/lib/agents/session-context/http";

/**
 * Session workspace context through the whole runtime (Phase J.3).
 *
 * The real host, control service, approval broker, session registry, loopback
 * MCP server and ACP adapter; the agent is a scripted ACP process on an
 * in-memory pipe that captures what TabDump hands it in `session/new` — which
 * is how the test gets the credential an agent would get, and nothing else.
 */

const LOCAL: ExecutionGateResult = {
  allowed: true,
  environment: "local",
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};
const ALICE: RuntimeActor = { id: "local" };
const ROOT = "C:/work/launch";

const LAUNCH_PLAN = {
  workspace: {
    id: "w-launch",
    name: "Launch Plan",
    createdAt: 1,
    updatedAt: 2,
    tabs: [
      { id: "t1", url: "https://example.com/pricing", normalizedUrl: "https://example.com/pricing", domain: "example.com", title: "Pricing research" },
      { id: "t2", url: "https://example.org/press", normalizedUrl: "https://example.org/press", domain: "example.org", title: "Press kit" },
    ],
  },
  collections: [],
  dependencies: [],
};
const OTHER = { ...LAUNCH_PLAN, workspace: { ...LAUNCH_PLAN.workspace, id: "w-other", name: "Other" } };

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function build(scopes: string[] = ["read_workspace", "read_project", "write_workspace"]) {
  const agent = createFakeAgent({
    "session/new": () => ({ sessionId: "acp-1", modes: { currentModeId: "default", availableModes: [{ id: "default" }] } }),
    "session/prompt": () => new Promise(() => {}),
  });
  const registry = createSessionContextRegistry({});
  const server = createSessionContextServer({ registry });
  servers.push(server);
  const adapter = createAcpControlAdapter({
    provider: "gemini",
    launch: agent.launcher,
    approval: { kind: "asking-mode", modeIds: ["default"] },
  });
  const host = createRuntimeHost({
    gate: LOCAL,
    resolveAdapter: (provider) => (provider === "gemini" ? adapter : undefined),
    providers: ["gemini"],
    sessionContext: { registry, url: () => server.url() },
    runtimeId: "rt-1",
  });

  async function send<T = Record<string, unknown>>(command: RuntimeCommand) {
    const result = await host.execute(ALICE, command as never);
    return result as unknown as { ok: boolean; value?: T; error?: { code: string } };
  }

  async function start(snapshot: unknown = LAUNCH_PLAN, workspaceId = "w-launch") {
    await send({
      name: "authorize_projects",
      projects: [
        {
          id: "p1",
          name: "Launch",
          path: ROOT,
          providers: ["gemini"],
          permissions: { scopes, projectId: "p1", grantedAt: 1 },
        },
      ],
    } as never);
    return send<{ sessionId: string; context?: { workspaceId: string; capabilities: string[] } }>({
      name: "create_session",
      provider: "gemini",
      projectId: "p1",
      workspaceId,
      contextSnapshot: snapshot,
    } as never);
  }

  /** What TabDump handed the agent in session/new — the credential an agent really gets. */
  function credential(): { url: string; token: string } | undefined {
    const created = agent.received.filter((message) => message.method === "session/new").at(-1);
    const entry = (created?.params as { mcpServers?: { url: string; headers: { value: string }[] }[] } | undefined)?.mcpServers?.[0];
    return entry ? { url: entry.url, token: entry.headers[0].value.replace(/^Bearer /, "") } : undefined;
  }

  return { host, registry, send, start, credential, agent };
}

async function mcp(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function until(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a session started from a workspace", () => {
  it("gets that workspace's context automatically, and the view says what it can do — never the credential", async () => {
    const h = build();
    const created = await h.start();
    expect(created.ok).toBe(true);
    expect(created.value?.context).toEqual({
      workspaceId: "w-launch",
      workspaceName: "Launch Plan",
      capabilities: ["workspace.read", "tabs.read", "collections.read", "relationships.read", "collections.write"],
      pendingActions: [],
    });

    const given = h.credential()!;
    expect(given.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = await mcp(given.url, given.token);
    const current = await client.callTool({ name: "get_current_workspace", arguments: {} });
    expect(JSON.stringify(current)).toContain("Pricing research");

    // The raw credential appears in no answer the host gives a client.
    const answers = [
      created,
      await h.send({ name: "list_sessions" } as never),
      await h.send({ name: "get_session", sessionId: created.value!.sessionId } as never),
      await h.send({ name: "get_events", sessionId: created.value!.sessionId } as never),
      await h.send({ name: "get_status" } as never),
    ];
    expect(JSON.stringify(answers)).not.toContain(given.token);
    await client.close();
  });

  it("derives read-only access from a grant without write_workspace — the request cannot ask for more", async () => {
    const h = build(["read_workspace", "read_project"]);
    const created = await h.start();
    expect(created.value?.context?.capabilities).not.toContain("collections.write");
    const given = h.credential()!;
    const client = await mcp(given.url, given.token);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("create_collection");
    await client.close();
  });

  it("gets no context at all when its project was not granted read_workspace", async () => {
    const h = build(["read_project"]);
    const created = await h.start();
    expect(created.ok).toBe(true);
    expect(created.value?.context).toBeUndefined();
    expect(h.credential()).toBeUndefined();
  });

  it("refuses to start at all with a snapshot of a different workspace than it names", async () => {
    const h = build();
    // Refused at the protocol boundary: the snapshot must be of workspaceId.
    const refused = await h.send({
      name: "create_session",
      provider: "gemini",
      workspaceId: "w-launch",
      contextSnapshot: OTHER,
    } as never);
    // The host re-reads the snapshot against the workspace named, refuses it,
    // and does not start the session without the context it was asked for.
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(h.registry.activeCount()).toBe(0);
  });

  it("never moves: a sync of another workspace is refused, the same one is accepted", async () => {
    const h = build();
    const created = await h.start();
    const sessionId = created.value!.sessionId;
    expect(await h.send({ name: "sync_session_context", sessionId, snapshot: OTHER } as never)).toMatchObject({
      ok: false,
      error: { code: "context_invalid" },
    });
    expect(
      await h.send({
        name: "sync_session_context",
        sessionId,
        snapshot: { ...LAUNCH_PLAN, workspace: { ...LAUNCH_PLAN.workspace, name: "Launch Plan (renamed)" } },
      } as never)
    ).toMatchObject({ ok: true });
    const view = await h.send<{ session: { context: { workspaceId: string; workspaceName: string } } }>({ name: "get_session", sessionId } as never);
    expect(view.value?.session.context).toMatchObject({ workspaceId: "w-launch", workspaceName: "Launch Plan (renamed)" });
  });
});

describe("a workspace change goes through TabDump's approval", () => {
  it("appears as an ordinary approval, and happens only once approved and applied by the Command Centre", async () => {
    const h = build();
    const created = await h.start();
    const sessionId = created.value!.sessionId;
    const given = h.credential()!;
    const client = await mcp(given.url, given.token);

    const call = client.callTool({ name: "create_collection", arguments: { name: "Launch sources", tabIds: ["t1", "t2"] } });

    // The same approval list, the same shape, scoped to the workspace — no project.
    let approval: { approvalId: string; action: string; scope: string; workspaceId?: string; projectId?: string; targets: string[] } | undefined;
    await until(async () => {
      const view = await h.send<{ approvals: (typeof approval)[] }>({ name: "get_session", sessionId } as never);
      approval = view.value?.approvals?.[0];
      return Boolean(approval);
    });
    expect(approval).toMatchObject({ action: "change_workspace", scope: "write_workspace", workspaceId: "w-launch" });
    expect(approval!.projectId).toBeUndefined();
    expect(approval!.targets[0]).toBe('New collection "Launch sources" with 2 tabs');

    // Nothing to apply until the user says yes.
    let session = await h.send<{ session: { context: { pendingActions: unknown[] } } }>({ name: "get_session", sessionId } as never);
    expect(session.value?.session.context.pendingActions).toEqual([]);

    expect(await h.send({ name: "respond_to_approval", approvalId: approval!.approvalId, decision: "granted" } as never)).toMatchObject({ ok: true });

    await until(async () => {
      session = await h.send({ name: "get_session", sessionId } as never);
      return (session.value?.session.context.pendingActions.length ?? 0) === 1;
    });
    const [action] = session.value!.session.context.pendingActions as { actionId: string; name: string; tabIds: string[] }[];
    expect(action).toMatchObject({ name: "Launch sources", tabIds: ["t1", "t2"] });

    // A made-up action cannot be completed.
    expect(await h.send({ name: "complete_context_action", sessionId, actionId: "invented", outcome: { ok: true, collectionId: "c1" } } as never)).toMatchObject({
      ok: false,
    });
    expect(await h.send({ name: "complete_context_action", sessionId, actionId: action.actionId, outcome: { ok: true, collectionId: "c-created" } } as never)).toMatchObject({ ok: true });

    const result = await call;
    expect(JSON.parse((result as { content: { text: string }[] }).content[0].text)).toEqual({
      created: true,
      collectionId: "c-created",
      name: "Launch sources",
      tabCount: 2,
    });

    const events = await h.send<{ events: { kind: string }[] }>({ name: "get_events", sessionId } as never);
    expect(events.value?.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["approval_requested", "approval_granted"]));
    await client.close();
  });

  it("changes nothing when the user declines", async () => {
    const h = build();
    const created = await h.start();
    const sessionId = created.value!.sessionId;
    const given = h.credential()!;
    const client = await mcp(given.url, given.token);
    const call = client.callTool({ name: "create_collection", arguments: { name: "No", tabIds: ["t1"] } });
    let approvalId = "";
    await until(async () => {
      const view = await h.send<{ approvals: { approvalId: string }[] }>({ name: "get_session", sessionId } as never);
      approvalId = view.value?.approvals?.[0]?.approvalId ?? "";
      return Boolean(approvalId);
    });
    await h.send({ name: "respond_to_approval", approvalId, decision: "denied" } as never);
    const result = await call;
    expect((result as { isError?: boolean }).isError).toBe(true);
    const view = await h.send<{ session: { context: { pendingActions: unknown[] } } }>({ name: "get_session", sessionId } as never);
    expect(view.value?.session.context.pendingActions).toEqual([]);
    await client.close();
  });
});

describe("the credential ends with the session", () => {
  async function revokedAfter(step: (h: ReturnType<typeof build>, sessionId: string) => Promise<void>) {
    const h = build();
    const created = await h.start();
    const given = h.credential()!;
    await (await mcp(given.url, given.token)).close();
    expect(h.registry.activeCount()).toBe(1);
    await step(h, created.value!.sessionId);
    expect(h.registry.activeCount()).toBe(0);
    await expect(mcp(given.url, given.token)).rejects.toThrow();
  }

  it("on dispose_session", async () => {
    await revokedAfter(async (h, sessionId) => {
      await h.send({ name: "dispose_session", sessionId } as never);
    });
  });

  it("on disconnect_provider", async () => {
    await revokedAfter(async (h) => {
      await h.send({ name: "disconnect_provider", provider: "gemini" } as never);
    });
  });

  it("when the session reaches a terminal status (the agent died)", async () => {
    await revokedAfter(async (h) => {
      h.agent.crash();
      await until(() => h.registry.activeCount() === 0);
    });
  });

  it("on runtime shutdown", async () => {
    await revokedAfter(async (h) => {
      await h.host.dispose();
    });
  });
});

describe("the access rule", () => {
  it("reads from read_workspace, writes only with write_workspace, and nothing without a grant", () => {
    const grant = (scopes: string[]) => ({ scopes, projectId: "p", grantedAt: 1 }) as never;
    expect(sessionContextAccessFor(grant(["read_workspace"]), "p")).toBe("read");
    expect(sessionContextAccessFor(grant(["read_workspace", "write_workspace"]), "p")).toBe("read_write");
    expect(sessionContextAccessFor(grant(["read_project"]), "p")).toBeUndefined();
    // No project: the one workspace the session was started from, read-only.
    expect(sessionContextAccessFor({ scopes: [], grantedAt: 1 }, undefined)).toBe("read");
  });
});
