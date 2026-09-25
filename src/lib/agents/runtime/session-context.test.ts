// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createFakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { ATTENDED_WINDOW_MS, createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { createRuntimeHost, sessionContextAccessFor } from "./host";
import { launchEntryFor } from "@/lib/agents/launch/allowlist";
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

function build(scopes: string[] = ["read_workspace", "read_project", "write_workspace"], clock?: { now: number }) {
  const agent = createFakeAgent({
    "session/new": () => ({ sessionId: "acp-1", modes: { currentModeId: "default", availableModes: [{ id: "default" }] } }),
    "session/prompt": () => new Promise(() => {}),
  });
  const registry = createSessionContextRegistry(clock ? { now: () => clock.now } : {});
  const server = createSessionContextServer({ registry });
  servers.push(server);
  const adapter = createAcpControlAdapter({
    provider: "gemini",
    launch: agent.launcher,
    approval: { kind: "asking-mode", modeIds: ["default"] },
    contextIdentity: launchEntryFor("gemini")!.acp!.contextIdentity,
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
      version: 1,
      syncedAt: expect.any(Number),
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      pendingActions: [],
    });
    // The agent was launched limited to this session's own server name (J.4).
    expect(h.agent.launches.at(-1)?.contextServerName).toMatch(/^tabdump_[a-z2-7]{16}$/);

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
    expect(approval!.targets[0]).toBe('New collection "Launch sources"');
    expect(approval).toMatchObject({
      provider: "gemini",
      change: { kind: "create_collection", subject: "Launch sources", tabCount: 2 },
    });

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

/* ------------------------------------------------------------------ *
 * Phase J.4 — provider-neutral context, at the runtime boundary
 * ------------------------------------------------------------------ */

const BOB: RuntimeActor = { id: "bob" };

describe("versions and synchronization (J.4)", () => {
  it("starts at version 1, moves only when the content changes, never goes back, and never switches workspace", async () => {
    const h = build();
    const created = await h.start();
    const sessionId = created.value!.sessionId;
    const renamed = { ...LAUNCH_PLAN, workspace: { ...LAUNCH_PLAN.workspace, name: "Launch Plan v2" } };

    // The same content again: accepted, version unchanged.
    expect(await h.send({ name: "sync_session_context", sessionId, snapshot: LAUNCH_PLAN } as never)).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await h.send({ name: "sync_session_context", sessionId, snapshot: renamed } as never)).toMatchObject({ ok: true, value: { version: 2 } });
    // Back to the old content is still a *change*: forward, never backward.
    expect(await h.send({ name: "sync_session_context", sessionId, snapshot: LAUNCH_PLAN } as never)).toMatchObject({ ok: true, value: { version: 3 } });
    // Another workspace: refused, version untouched, binding untouched.
    expect(await h.send({ name: "sync_session_context", sessionId, snapshot: OTHER } as never)).toMatchObject({ ok: false });
    const view = await h.send<{ session: { context: { version: number; workspaceId: string } } }>({ name: "get_session", sessionId } as never);
    expect(view.value?.session.context).toMatchObject({ version: 3, workspaceId: "w-launch" });
  });

  it("lets the agent tell a stale version from a fresh one, and see what changed — ids, not a dump", async () => {
    const h = build();
    const created = await h.start();
    const sessionId = created.value!.sessionId;
    const given = h.credential()!;
    const client = await mcp(given.url, given.token);

    const text = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
    const status = async (knownVersion: number) =>
      text(await client.callTool({ name: "get_context_status", arguments: { knownVersion } }));
    expect(await status(1)).toMatchObject({ contextVersion: 1, fresh: true, workspace: { name: "Launch Plan" } });

    const added = {
      ...LAUNCH_PLAN,
      workspace: {
        ...LAUNCH_PLAN.workspace,
        tabs: [
          LAUNCH_PLAN.workspace.tabs[0],
          { id: "t3", url: "https://example.net/brief", normalizedUrl: "https://example.net/brief", domain: "example.net", title: "Brief" },
        ],
      },
    };
    await h.send({ name: "sync_session_context", sessionId, snapshot: added } as never);
    expect(await status(1)).toMatchObject({ contextVersion: 2, fresh: false });

    expect(text(await client.callTool({ name: "get_context_changes", arguments: { sinceVersion: 1 } }))).toMatchObject({
      version: 2,
      since: 1,
      complete: true,
      tabs: { changed: ["t3"], removed: ["t2"] },
      collections: { changed: [], removed: [] },
      truncated: false,
    });
    // Every read carries the version it was answered from.
    expect(text(await client.callTool({ name: "list_collections", arguments: {} })).contextVersion).toBe(2);
    await client.close();
  });
});

describe("isolation at the runtime (J.4)", () => {
  it("ignores a client that claims capabilities: the grant decides", async () => {
    const h = build(["read_workspace", "read_project"]);
    await h.send({
      name: "authorize_projects",
      projects: [{ id: "p1", name: "Launch", path: ROOT, providers: ["gemini"], permissions: { scopes: ["read_workspace", "read_project"], projectId: "p1", grantedAt: 1 } }],
    } as never);
    const created = await h.send<{ context?: { capabilities: string[] } }>({
      name: "create_session",
      provider: "gemini",
      projectId: "p1",
      workspaceId: "w-launch",
      contextSnapshot: LAUNCH_PLAN,
      capabilities: ["collections.write"],
      access: "read_write",
    } as never);
    expect(created.value?.context?.capabilities).not.toContain("collections.write");
    const given = h.credential()!;
    const client = await mcp(given.url, given.token);
    const attempt = await client.callTool({ name: "create_collection", arguments: { name: "x", tabIds: ["t1"], capabilities: ["collections.write"] } });
    expect(attempt.isError).toBe(true);
    await client.close();
  });

  it("refuses another actor at every door, and refuses a replayed answer or completion", async () => {
    const h = build();
    const created = await h.start();
    const sessionId = created.value!.sessionId;
    const given = h.credential()!;
    const client = await mcp(given.url, given.token);
    const call = client.callTool({ name: "create_collection", arguments: { name: "Mine", tabIds: ["t1"] } });
    let approvalId = "";
    await until(async () => {
      const view = await h.send<{ approvals: { approvalId: string }[] }>({ name: "get_session", sessionId } as never);
      approvalId = view.value?.approvals?.[0]?.approvalId ?? "";
      return Boolean(approvalId);
    });

    // Bob does not own the session: every door is shut.
    expect((await h.host.execute(BOB, { name: "respond_to_approval", approvalId, decision: "granted" } as never)).ok).toBe(false);
    expect((await h.host.execute(BOB, { name: "sync_session_context", sessionId, snapshot: LAUNCH_PLAN } as never)).ok).toBe(false);

    await h.send({ name: "respond_to_approval", approvalId, decision: "granted" } as never);
    // A second answer to the same approval is refused: no replay.
    expect((await h.send({ name: "respond_to_approval", approvalId, decision: "granted" } as never)).ok).toBe(false);
    let actionId = "";
    await until(async () => {
      const view = await h.send<{ session: { context: { pendingActions: { actionId: string }[] } } }>({ name: "get_session", sessionId } as never);
      actionId = view.value?.session.context.pendingActions[0]?.actionId ?? "";
      return Boolean(actionId);
    });
    expect((await h.host.execute(BOB, { name: "complete_context_action", sessionId, actionId, outcome: { ok: true, collectionId: "c" } } as never)).ok).toBe(false);
    expect((await h.send({ name: "complete_context_action", sessionId, actionId, outcome: { ok: true, collectionId: "c" } } as never)).ok).toBe(true);
    expect((await h.send({ name: "complete_context_action", sessionId, actionId, outcome: { ok: true, collectionId: "c" } } as never)).ok).toBe(false);
    await call;
    await client.close();
  });

  it("gives a second session its own server name and credential; ending one leaves the other working", async () => {
    const h = build();
    const first = await h.start();
    const firstCredential = h.credential()!;
    const firstName = h.agent.launches.at(-1)?.contextServerName;
    const second = await h.send<{ sessionId: string }>({ name: "create_session", provider: "gemini", projectId: "p1", workspaceId: "w-launch", contextSnapshot: LAUNCH_PLAN } as never);
    expect(second.ok).toBe(true);
    const secondCredential = h.credential()!;
    expect(h.agent.launches.at(-1)?.contextServerName).not.toBe(firstName);
    expect(secondCredential.token).not.toBe(firstCredential.token);

    await h.send({ name: "dispose_session", sessionId: first.value!.sessionId } as never);
    await expect(mcp(firstCredential.url, firstCredential.token)).rejects.toThrow();
    const client = await mcp(secondCredential.url, secondCredential.token);
    expect(JSON.stringify(await client.callTool({ name: "list_workspaces", arguments: {} }))).toContain("Launch Plan");
    await client.close();
  });
});

describe("an agent whose context calls cannot be proven (J.4)", () => {
  it("starts the session without context, says so, and mints no credential", async () => {
    const agent = createFakeAgent({
      "session/new": () => ({ sessionId: "acp-1", modes: { currentModeId: "ask", availableModes: [{ id: "ask" }] } }),
    });
    const registry = createSessionContextRegistry({});
    const server = createSessionContextServer({ registry });
    servers.push(server);
    const entry = launchEntryFor("grok")!.acp!;
    const adapter = createAcpControlAdapter({ provider: "grok", launch: agent.launcher, approval: entry.approval, contextIdentity: entry.contextIdentity });
    const host = createRuntimeHost({
      gate: LOCAL,
      resolveAdapter: (provider) => (provider === "grok" ? adapter : undefined),
      providers: ["grok"],
      sessionContext: { registry, url: () => server.url() },
      runtimeId: "rt-2",
    });

    await host.execute(ALICE, {
      name: "authorize_projects",
      projects: [{ id: "p1", name: "Launch", path: ROOT, providers: ["grok"], permissions: { scopes: ["read_workspace", "read_project", "write_workspace"], projectId: "p1", grantedAt: 1 } }],
    } as never);
    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "grok",
      projectId: "p1",
      workspaceId: "w-launch",
      contextSnapshot: LAUNCH_PLAN,
    } as never);
    expect(created.ok).toBe(true);
    const view = (created as unknown as { value: { context?: unknown; contextUnavailable?: string } }).value;
    expect(view.context).toBeUndefined();
    expect(view.contextUnavailable).toBe("provider");
    expect(registry.activeCount()).toBe(0);
    expect(agent.launches.at(-1)?.contextServerName).toBeUndefined();
    const opened = agent.received.filter((message) => message.method === "session/new").at(-1);
    expect((opened?.params as { mcpServers: unknown[] }).mcpServers).toEqual([]);
    await host.dispose();
  });
});

describe("freshness through the host (Phase J.6)", () => {
  it("counts the Command Centre asking about a session — its own, and only its owner's — as live", async () => {
    const clock = { now: 5_000_000 };
    const h = build(undefined, clock);
    const created = await h.start();
    const sessionId = created.value!.sessionId;
    expect(h.registry.freshness(sessionId)).toEqual({ sync: "live", lastSeenAt: 5_000_000 });

    clock.now += ATTENDED_WINDOW_MS + 1;
    expect(h.registry.freshness(sessionId)?.sync).toBe("paused");

    // Somebody else polling says nothing about whether Alice's Command Centre is open.
    await h.host.execute({ id: "bob" }, { name: "list_sessions" } as never);
    expect(h.registry.freshness(sessionId)?.sync).toBe("paused");

    await h.send({ name: "list_sessions" } as never);
    expect(h.registry.freshness(sessionId)).toEqual({ sync: "live", lastSeenAt: clock.now });

    clock.now += ATTENDED_WINDOW_MS + 1;
    await h.send({ name: "get_session", sessionId } as never);
    expect(h.registry.freshness(sessionId)?.sync).toBe("live");

    // Attendance never moves a version.
    expect(h.registry.binding(sessionId)?.version).toBe(1);

    await h.send({ name: "dispose_session", sessionId } as never);
    expect(h.registry.freshness(sessionId)).toBeUndefined();
  });
});
