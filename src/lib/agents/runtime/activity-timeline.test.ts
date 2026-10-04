// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createFakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { launchEntryFor } from "@/lib/agents/launch/allowlist";
import { createRuntimeHost } from "./host";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { RuntimeApprovalView, RuntimeCommand, RuntimeSessionView, SequencedControlEvent } from "./protocol";
import type { SessionContextServer } from "@/lib/agents/session-context/http";

/**
 * The activity timeline from the real pipeline, end to end.
 *
 * The real runtime host, control service, approval broker, session registry,
 * loopback MCP server and ACP adapter. The agent is a scripted ACP process on
 * an in-memory pipe; what it "does" to the workspace it does as a real agent
 * would — over MCP, with the credential Hubble handed it. Nothing below
 * appends an event by hand: every entry the timeline shows was journalled by
 * the runtime because something happened.
 */

const LOCAL: ExecutionGateResult = {
  allowed: true,
  environment: "local",
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};
const ALICE: RuntimeActor = { id: "local" };

const tab = (id: string, title: string, domain = "example.com") => ({
  id,
  url: `https://${domain}/${id}`,
  normalizedUrl: `https://${domain}/${id}`,
  domain,
  title,
});

const RESEARCH = {
  workspace: {
    id: "w-research",
    name: "Research",
    createdAt: 1,
    updatedAt: 2,
    tabs: [tab("t1", "Pricing research"), tab("t2", "Pricing models compared"), tab("t3", "Press kit", "example.org")],
  },
  collections: [{ id: "c1", workspaceId: "w-research", name: "Sources", tabIds: ["t3"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
};
const PRIVATE = {
  workspace: { id: "w-private", name: "Private", createdAt: 1, updatedAt: 2, tabs: [tab("p1", "Pricing of my bank account", "bank.example.com")] },
  collections: [],
  dependencies: [],
};

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function build(providers: AgentProviderId[] = ["gemini"]) {
  const agents = new Map<AgentProviderId, ReturnType<typeof createFakeAgent>>();
  const adapters = new Map<AgentProviderId, ReturnType<typeof createAcpControlAdapter>>();
  for (const provider of providers) {
    const agent = createFakeAgent({
      "session/new": () => ({ sessionId: `acp-${provider}`, modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "ask" }] } }),
      "session/prompt": () => new Promise(() => {}),
    });
    agents.set(provider, agent);
    adapters.set(
      provider,
      createAcpControlAdapter({
        provider,
        launch: agent.launcher,
        approval: { kind: "asking-mode", modeIds: ["default", "ask"] },
        contextIdentity: launchEntryFor(provider)!.acp!.contextIdentity,
      })
    );
  }
  const registry = createSessionContextRegistry({});
  const server = createSessionContextServer({ registry });
  servers.push(server);
  const host = createRuntimeHost({
    gate: LOCAL,
    resolveAdapter: (provider) => adapters.get(provider),
    providers,
    sessionContext: { registry, url: () => server.url() },
    runtimeId: "rt-1",
  });

  async function send<T = Record<string, unknown>>(command: RuntimeCommand) {
    return (await host.execute(ALICE, command as never)) as unknown as { ok: boolean; value?: T; error?: { code: string } };
  }

  async function start(provider: AgentProviderId, snapshot: typeof RESEARCH | typeof PRIVATE = RESEARCH) {
    await send({
      name: "authorize_projects",
      projects: [{ id: "p1", name: "Launch", path: "C:/work/launch", providers, permissions: { scopes: ["read_workspace", "read_project", "write_workspace"], projectId: "p1", grantedAt: 1 } }],
    } as never);
    const created = await send<RuntimeSessionView>({
      name: "create_session",
      provider,
      projectId: "p1",
      workspaceId: snapshot.workspace.id,
      contextSnapshot: snapshot,
    } as never);
    expect(created.ok).toBe(true);
    return created.value!.sessionId;
  }

  /** The credential Hubble handed this agent in `session/new` — what a real agent connects with. */
  async function agentClient(provider: AgentProviderId): Promise<Client> {
    const created = agents.get(provider)!.received.filter((message) => message.method === "session/new").at(-1);
    const entry = (created?.params as { mcpServers?: { url: string; headers: { value: string }[] }[] }).mcpServers![0]!;
    const client = new Client({ name: provider, version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: entry.headers[0]!.value } } })
    );
    return client;
  }

  async function snapshotOf(sessionId: string) {
    const view = await send<{ session: RuntimeSessionView; approvals: RuntimeApprovalView[] }>({ name: "get_session", sessionId } as never);
    const events = await send<{ events: SequencedControlEvent[] }>({ name: "get_events", sessionId, afterSequence: 0 } as never);
    return { session: view.value!.session, approvals: view.value!.approvals, events: events.value!.events };
  }

  async function timeline(sessionId: string, agentName: string, knownApprovals = new Map<string, RuntimeApprovalView>()) {
    const { session, approvals, events } = await snapshotOf(sessionId);
    for (const approval of approvals) knownApprovals.set(approval.approvalId, approval);
    return buildAgentActivityTimeline({ session, events, approvals, knownApprovals, agentName, workspaceName: "Research", now: Date.now() });
  }

  return { host, registry, agents, send, start, agentClient, snapshotOf, timeline };
}

async function until(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the timeline from a real MCP-connected session", () => {
  it("connect → context loaded → read → search, with the counts the server actually answered", async () => {
    const h = build();
    const sessionId = await h.start("gemini");

    // Started: the agent connected, and Hubble says what context it was handed.
    const first = await h.snapshotOf(sessionId);
    const loaded = first.events.find((event) => event.kind === "context_loaded");
    expect(loaded?.context).toEqual({ workspaceId: "w-research", tabs: 3, collections: 1 });
    expect(loaded?.summary).toBe("3 tabs · 1 collection");

    // The agent reads and searches, over MCP, as a real agent does.
    const client = await h.agentClient("gemini");
    await client.callTool({ name: "get_workspace_summary", arguments: {} });
    await client.callTool({ name: "list_tabs", arguments: { limit: 2 } });
    const search = (await client.callTool({ name: "search_tabs", arguments: { query: "pricing" } })) as { content: { text: string }[] };
    const answered = JSON.parse(search.content[0]!.text) as { totalMatches: number };

    await until(async () => (await h.snapshotOf(sessionId)).events.filter((event) => event.kind === "context_read").length === 3);
    const entries = await h.timeline(sessionId, "Gemini");
    expect(entries.map((entry) => entry.title)).toEqual([
      "Gemini connected",
      "Workspace context loaded",
      "Read workspace",
      `Found ${answered.totalMatches} relevant tabs`,
    ]);
    expect(answered.totalMatches).toBe(2);
    expect(entries[2]).toMatchObject({ count: 2, metadata: { tabs: 3, collections: 1 } });

    // Never a search query, a title or a URL on the wire for the timeline.
    const wire = JSON.stringify((await h.snapshotOf(sessionId)).events.filter((event) => event.kind.startsWith("context_")));
    for (const secret of ["pricing", "Pricing research", "example.com", "t1"]) expect(wire).not.toContain(secret);
    await client.close();
  });

  it("connect → approval required → approved → applied", async () => {
    const h = build();
    const sessionId = await h.start("gemini");
    const client = await h.agentClient("gemini");
    const known = new Map<string, RuntimeApprovalView>();

    const proposal = client.callTool({ name: "create_collection", arguments: { name: "Pricing", tabIds: ["t1", "t2"] } });
    let approvalId = "";
    await until(async () => {
      approvalId = (await h.snapshotOf(sessionId)).approvals[0]?.approvalId ?? "";
      return Boolean(approvalId);
    });

    const waiting = await h.timeline(sessionId, "Gemini", known);
    expect(waiting.at(-1)).toMatchObject({ status: "waiting", title: "Waiting for approval", description: "Create collection “Pricing” · 2 tabs" });

    expect(await h.send({ name: "respond_to_approval", approvalId, decision: "granted" } as never)).toMatchObject({ ok: true });
    let actionId = "";
    let approvedBy: string | undefined;
    await until(async () => {
      const pending = (await h.snapshotOf(sessionId)).session.context?.pendingActions ?? [];
      actionId = pending[0]?.actionId ?? "";
      approvedBy = pending[0]?.approvalId;
      return Boolean(actionId);
    });
    // The change the Command Centre is asked to apply names the approval that
    // allowed it — the reference the action inspector joins on, by id.
    expect(approvedBy).toBe(approvalId);
    await h.send({ name: "complete_context_action", sessionId, actionId, outcome: { ok: true, collectionId: "c-new" } } as never);
    await proposal;

    const after = await h.timeline(sessionId, "Gemini", known);
    // The runtime moved the session back to running once the question was
    // answered, and the scripted agent never finishes its turn — so the last
    // entry is the truthful "Working…", not a made-up completion.
    expect((await h.snapshotOf(sessionId)).session.status).toBe("running");
    expect(after.map((entry) => entry.title).slice(-3)).toEqual(["Asked for approval", "Approved", "Working…"]);
    expect(after.at(-2)).toMatchObject({ description: "Create collection “Pricing” · 2 tabs" });
    expect(after.some((entry) => entry.status === "waiting")).toBe(false);
    // A proposal is not a read: no "Read workspace" row for it.
    expect(after.filter((entry) => entry.kind === "reading")).toEqual([]);
    await client.close();
  });

  it("a refused read is journalled as a failed read, and the agent's answer is unchanged", async () => {
    const h = build();
    const sessionId = await h.start("gemini");
    const client = await h.agentClient("gemini");
    const refused = (await client.callTool({ name: "get_workspace", arguments: { workspaceId: "w-private" } })) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    await until(async () => (await h.snapshotOf(sessionId)).events.some((event) => event.kind === "context_read"));
    const entries = await h.timeline(sessionId, "Gemini");
    expect(entries.at(-1)).toMatchObject({ status: "failed", title: "Couldn't read the workspace" });
    await client.close();
  });
});

describe("two agents, two workspaces", () => {
  it("keeps each session's activity in its own session and workspace", async () => {
    const h = build(["gemini", "grok"]);
    const research = await h.start("gemini", RESEARCH);
    const other = await h.start("grok", PRIVATE);

    const gemini = await h.agentClient("gemini");
    await gemini.callTool({ name: "search_tabs", arguments: { query: "pricing" } });
    await until(async () => (await h.snapshotOf(research)).events.some((event) => event.kind === "context_read"));

    const otherEvents = (await h.snapshotOf(other)).events;
    expect(otherEvents.some((event) => event.kind === "context_read")).toBe(false);
    expect(JSON.stringify(otherEvents)).not.toContain("w-research");

    // Grok cannot be given Hubble's context server (launch/allowlist.ts), and its timeline says so rather than pretending.
    const grok = await h.timeline(other, "Grok");
    expect(grok.map((entry) => entry.title)).toEqual(["Grok connected", "Started without workspace context"]);
    expect(grok.every((entry) => entry.sessionId === other && entry.provider === "grok")).toBe(true);

    const geminiTimeline = await h.timeline(research, "Gemini");
    expect(geminiTimeline.every((entry) => entry.sessionId === research && entry.workspaceId === "w-research")).toBe(true);
    await gemini.close();
  });
});

describe("disconnect", () => {
  it("an agent that exits mid-session ends the timeline with what happened, and nothing left in progress", async () => {
    const h = build();
    const sessionId = await h.start("gemini");
    const client = await h.agentClient("gemini");
    await client.callTool({ name: "get_workspace_summary", arguments: {} });
    await until(async () => (await h.snapshotOf(sessionId)).events.some((event) => event.kind === "context_read"));

    h.agents.get("gemini")!.crash();
    await until(async () => (await h.snapshotOf(sessionId)).events.some((event) => event.kind === "error"));

    const { session } = await h.snapshotOf(sessionId);
    expect(["failed", "disconnected"]).toContain(session.status);
    const entries = await h.timeline(sessionId, "Gemini");
    expect(entries.map((entry) => entry.title)).toEqual([
      "Gemini connected",
      "Workspace context loaded",
      "Read workspace",
      "Gemini stopped unexpectedly",
    ]);
    expect(entries.at(-1)).toMatchObject({ status: "failed", description: "Agent disconnected unexpectedly", action: { kind: "new_session" } });
    expect(entries.some((entry) => entry.status === "active" || entry.status === "waiting")).toBe(false);

    // The credential went with the session: a read now reaches nothing, and journals nothing.
    const before = (await h.snapshotOf(sessionId)).events.length;
    await client.callTool({ name: "get_workspace_summary", arguments: {} }).catch(() => undefined);
    expect((await h.snapshotOf(sessionId)).events.length).toBe(before);
    await client.close().catch(() => undefined);
  });
});
