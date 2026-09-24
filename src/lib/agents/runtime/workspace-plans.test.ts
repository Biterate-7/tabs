// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createFakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { launchEntryFor } from "@/lib/agents/launch/allowlist";
import { createRuntimeHost } from "./host";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { RuntimeApprovalView, RuntimeCommand, RuntimeSessionView } from "./protocol";
import type { SessionContextServer } from "@/lib/agents/session-context/http";

/**
 * A workspace plan through the whole runtime (Phase J.5): the real host,
 * control service, approval broker, registry and loopback MCP server, with a
 * scripted ACP agent. The test plays the agent (over MCP, with the credential
 * TabDump handed it) and the Command Centre (over the runtime protocol) — the
 * two sides of the boundary — and nothing else.
 */

const LOCAL: ExecutionGateResult = {
  allowed: true,
  environment: "local",
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};
const ALICE: RuntimeActor = { id: "local" };
const BOB: RuntimeActor = { id: "bob" };

function tab(id: string, title: string) {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", title };
}

const LAUNCH_PLAN = {
  workspace: {
    id: "w-launch",
    name: "Launch Plan",
    createdAt: 1,
    updatedAt: 2,
    tabs: [tab("t1", "MIT admissions"), tab("t2", "Stanford essays"), tab("t3", "Physics lecture"), tab("t4", "Quantum notes")],
  },
  collections: [{ id: "c1", workspaceId: "w-launch", name: "Collection 2", tabIds: ["t3"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
};

const PLAN = {
  basedOnVersion: 1,
  operations: [
    { kind: "create_collection", name: "College Research", tabIds: ["t1", "t2"] },
    { kind: "rename_collection", collectionId: "c1", name: "Physics" },
    { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t4"] },
  ],
};

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function build() {
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
    contextIdentity: launchEntryFor("gemini")!.acp!.contextIdentity,
  });
  const host = createRuntimeHost({
    gate: LOCAL,
    resolveAdapter: (provider) => (provider === "gemini" ? adapter : undefined),
    providers: ["gemini"],
    sessionContext: { registry, url: () => server.url() },
    runtimeId: "rt-1",
  });

  async function send<T = Record<string, unknown>>(command: RuntimeCommand, actor: RuntimeActor = ALICE) {
    const result = await host.execute(actor, command as never);
    return result as unknown as { ok: boolean; value?: T; error?: { code: string } };
  }

  async function start(): Promise<string> {
    await send({
      name: "authorize_projects",
      projects: [
        {
          id: "p1",
          name: "Launch",
          path: "C:/work/launch",
          providers: ["gemini"],
          permissions: { scopes: ["read_workspace", "read_project", "write_workspace"], projectId: "p1", grantedAt: 1 },
        },
      ],
    } as never);
    const created = await send<{ sessionId: string }>({
      name: "create_session",
      provider: "gemini",
      projectId: "p1",
      workspaceId: "w-launch",
      contextSnapshot: LAUNCH_PLAN,
    } as never);
    return created.value!.sessionId;
  }

  function credential(): { url: string; token: string } {
    const created = agent.received.filter((message) => message.method === "session/new").at(-1);
    const entry = (created?.params as { mcpServers: { url: string; headers: { value: string }[] }[] }).mcpServers[0];
    return { url: entry.url, token: entry.headers[0].value.replace(/^Bearer /, "") };
  }

  async function session(sessionId: string) {
    const view = await send<{ session: RuntimeSessionView; approvals: RuntimeApprovalView[] }>({ name: "get_session", sessionId } as never);
    return view.value!;
  }

  return { host, registry, send, start, credential, session };
}

async function mcp(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a plan through the runtime", () => {
  it("is one approval showing every step, applied only after it, once, then verified — and the agent is told the new version", async () => {
    const h = build();
    const sessionId = await h.start();
    const given = h.credential();
    const client = await mcp(given.url, given.token);

    const call = client.callTool({ name: "propose_workspace_plan", arguments: PLAN });
    const { approvals } = await until(() => h.session(sessionId), (view) => view.approvals.length === 1);
    const [approval] = approvals;

    // An ordinary workspace approval: who, where, every step — no ids, no credential.
    expect(approval).toMatchObject({
      provider: "gemini",
      action: "change_workspace",
      scope: "write_workspace",
      workspaceId: "w-launch",
      reason: "Apply 3 changes to this workspace.",
      targets: [
        'Create collection "College Research" with 2 tabs',
        'Rename collection "Collection 2" to "Physics"',
        'Add 1 tab to "Physics"',
      ],
      plan: { operationCount: 3, tabCount: 3, basedOnVersion: 1 },
    });
    expect(approval.projectId).toBeUndefined();
    expect(JSON.stringify({ targets: approval.targets, plan: approval.plan })).not.toMatch(/"t\d"|"c1"|w-launch|tdctx_/);
    expect(JSON.stringify(approval)).not.toContain(given.token);

    // Nothing to apply before the answer.
    expect((await h.session(sessionId)).session.context?.pendingActions).toEqual([]);

    // Another actor can neither answer it nor complete anything.
    expect((await h.send({ name: "respond_to_approval", approvalId: approval.approvalId, decision: "granted" } as never, BOB)).ok).toBe(false);
    expect((await h.send({ name: "respond_to_approval", approvalId: approval.approvalId, decision: "granted" } as never)).ok).toBe(true);
    // A second answer to the same approval is refused.
    expect((await h.send({ name: "respond_to_approval", approvalId: approval.approvalId, decision: "denied" } as never)).ok).toBe(false);

    const { session } = await until(() => h.session(sessionId), (view) => (view.session.context?.pendingActions.length ?? 0) === 1);
    const [action] = session.context!.pendingActions;
    if (action.kind !== "apply_plan") throw new Error(`expected a plan, got ${action.kind}`);
    expect(action.operations).toEqual([
      { kind: "create_collection", name: "College Research", tabIds: ["t1", "t2"] },
      { kind: "rename_collection", collectionId: "c1", name: "Physics" },
      { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["t4"] },
    ]);

    // The Command Centre's part: the store's batch, the synced result, then the report.
    const applied = applyCollectionBatch(LAUNCH_PLAN.collections, { workspaceId: "w-launch", tabIds: new Set(["t1", "t2", "t3", "t4"]) }, action.operations, 3);
    if (!applied.ok) throw new Error("apply failed");
    expect((await h.send({ name: "sync_session_context", sessionId, snapshot: { ...LAUNCH_PLAN, collections: applied.collections } } as never, BOB)).ok).toBe(false);
    expect(await h.send({ name: "sync_session_context", sessionId, snapshot: { ...LAUNCH_PLAN, collections: applied.collections } } as never)).toMatchObject({
      ok: true,
      value: { version: 2 },
    });
    const report = { name: "complete_context_action", sessionId, actionId: action.actionId, outcome: { ok: true, planHash: action.planHash, created: applied.created } };
    expect((await h.send({ ...report, outcome: { ...report.outcome, planHash: "not-the-approved-plan" } } as never)).ok).toBe(false);
    expect((await h.send(report as never, BOB)).ok).toBe(false);
    expect((await h.send(report as never)).ok).toBe(true);
    // Replayed: refused.
    expect((await h.send(report as never)).ok).toBe(false);

    const result = JSON.parse((await call as { content: { text: string }[] }).content[0].text);
    expect(result).toMatchObject({ applied: true, verified: true, previousVersion: 1, contextVersion: 2 });
    expect(result.results).toHaveLength(3);

    // The result line the Command Centre shows, tied to the approval the user gave.
    const after = await h.session(sessionId);
    expect(after.session.context?.planOutcomes).toMatchObject([
      { approvalId: approval.approvalId, status: "applied", operationCount: 3, verifiedCount: 3, contextVersion: 2 },
    ]);
    expect(after.session.context?.pendingActions).toEqual([]);
    await client.close();
  });

  it("applies nothing when the user declines, and the agent hears it", async () => {
    const h = build();
    const sessionId = await h.start();
    const given = h.credential();
    const client = await mcp(given.url, given.token);
    const call = client.callTool({ name: "propose_workspace_plan", arguments: PLAN });
    const { approvals } = await until(() => h.session(sessionId), (view) => view.approvals.length === 1);
    await h.send({ name: "respond_to_approval", approvalId: approvals[0].approvalId, decision: "denied" } as never);
    const result = (await call) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("The user declined this plan. Nothing was changed.");
    const view = await h.session(sessionId);
    expect(view.session.context).toMatchObject({ version: 1, pendingActions: [], planOutcomes: [{ status: "denied" }] });
    await client.close();
  });

  it("ends a waiting plan with the session, and the credential with it", async () => {
    const h = build();
    const sessionId = await h.start();
    const given = h.credential();
    const client = await mcp(given.url, given.token);
    const call = client.callTool({ name: "propose_workspace_plan", arguments: PLAN });
    await until(() => h.session(sessionId), (view) => view.approvals.length === 1);
    await h.send({ name: "dispose_session", sessionId } as never);
    const ended = (await call) as { content: { text: string }[] };
    expect(ended.content[0].text).toBe("This TabDump session has ended.");
    await expect(mcp(given.url, given.token)).rejects.toThrow();
    expect(h.registry.activeCount()).toBe(0);
    await client.close().catch(() => {});
  });
});
