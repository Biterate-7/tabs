import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createFakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { createRuntimeHost } from "../host";
import type { AgentHistoryStore } from "@/lib/agents/activity/history-store";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { Collection } from "@/lib/collections/types";
import type { SessionContextServer } from "@/lib/agents/session-context/http";
import type { ExecutionGateResult } from "../gate";
import type { RuntimeActor, RuntimeHost } from "../host";
import type { RuntimeApprovalView, RuntimeCommand, RuntimeSessionView, SequencedControlEvent } from "../protocol";

/**
 * A real runtime for agent history tests: the real host, control service,
 * approval broker, session registry, loopback MCP server and ACP adapter,
 * with a scripted ACP agent on an in-memory pipe. Nothing is journalled by
 * hand — every event comes from something the agent, or the person, did.
 *
 * Each `startRuntime` is a separate runtime: its own host, journal, broker,
 * registry and MCP server, sharing nothing with another but the history
 * store it is given — which is what a restart is.
 */

export const LOCAL_GATE: ExecutionGateResult = {
  allowed: true,
  environment: "local",
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};

export const ALICE: RuntimeActor = { id: "local" };
export const BOB: RuntimeActor = { id: "account:bob" };

const tab = (id: string, title: string, domain = "example.com") => ({
  id,
  url: `https://${domain}/${id}`,
  normalizedUrl: `https://${domain}/${id}`,
  domain,
  title,
});

export const SOURCES: Collection = { id: "c1", workspaceId: "w-research", name: "Sources", tabIds: ["t3"], createdAt: 1, updatedAt: 1 };

export const RESEARCH = {
  workspace: {
    id: "w-research",
    name: "Research",
    createdAt: 1,
    updatedAt: 2,
    tabs: [tab("t1", "Pricing research"), tab("t2", "Pricing models compared"), tab("t3", "Press kit", "example.org")],
  },
  collections: [SOURCES],
  dependencies: [],
};

export const PRIVATE = {
  workspace: { id: "w-private", name: "Private", createdAt: 1, updatedAt: 2, tabs: [tab("p1", "Pricing of my bank account", "bank.example.com")] },
  collections: [],
  dependencies: [],
};

export type Reply<T> = { ok: boolean; value?: T; error?: { code: string } };

export async function until(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export type HistoryRuntime = Awaited<ReturnType<typeof startRuntime>>;

export async function startRuntime(options: {
  store?: AgentHistoryStore;
  runtimeId: string;
  providers?: AgentProviderId[];
  servers: SessionContextServer[];
  /**
   * How each provider's calls to the context server are proven — the launch
   * allowlist's own entry, passed in by the test so this support module does
   * not import the launch layer (launch/security.test.ts).
   */
  contextIdentity: (provider: AgentProviderId) => Parameters<typeof createAcpControlAdapter>[0]["contextIdentity"];
}) {
  const providers = options.providers ?? ["gemini"];
  let releaseTurn: (() => void) | undefined;
  const agents = new Map<AgentProviderId, ReturnType<typeof createFakeAgent>>();
  const adapters = new Map<AgentProviderId, ReturnType<typeof createAcpControlAdapter>>();
  for (const provider of providers) {
    const agent = createFakeAgent({
      "session/new": () => ({ sessionId: `acp-${provider}`, modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "ask" }] } }),
      // A turn: the agent says something, then works until the test lets it finish.
      "session/prompt": async (params, context) => {
        context.update(params.sessionId as string, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "REPLY-SECRET: I will organise the pricing tabs." },
        });
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        return { stopReason: "end_turn" };
      },
    });
    agents.set(provider, agent);
    adapters.set(
      provider,
      createAcpControlAdapter({
        provider,
        launch: agent.launcher,
        approval: { kind: "asking-mode", modeIds: ["default", "ask"] },
        contextIdentity: options.contextIdentity(provider),
      })
    );
  }
  const registry = createSessionContextRegistry({});
  const server = createSessionContextServer({ registry });
  options.servers.push(server);
  const host: RuntimeHost = createRuntimeHost({
    gate: LOCAL_GATE,
    resolveAdapter: (provider) => adapters.get(provider),
    providers,
    sessionContext: { registry, url: () => server.url() },
    runtimeId: options.runtimeId,
    ...(options.store ? { history: { store: options.store } } : {}),
  });

  async function send<T = Record<string, unknown>>(command: RuntimeCommand, actor: RuntimeActor = ALICE): Promise<Reply<T>> {
    const reply = (await host.execute(actor, command as never)) as unknown as Reply<T>;
    // As the route does: history is written before the response.
    await host.settleHistory();
    return reply;
  }

  async function start(provider: AgentProviderId = "gemini", snapshot: typeof RESEARCH | typeof PRIVATE = RESEARCH, actor: RuntimeActor = ALICE) {
    await send(
      {
        name: "authorize_projects",
        projects: [
          { id: "p1", name: "Launch", path: "C:/work/launch", providers, permissions: { scopes: ["read_workspace", "read_project", "write_workspace"], projectId: "p1", grantedAt: 1 } },
        ],
      } as never,
      actor
    );
    const created = await send<RuntimeSessionView>(
      { name: "create_session", provider, projectId: "p1", workspaceId: snapshot.workspace.id, title: "Organise pricing", contextSnapshot: snapshot } as never,
      actor
    );
    if (!created.ok) throw new Error(`create_session failed: ${created.error?.code}`);
    return created.value!.sessionId;
  }

  /** The credential Hubble handed this agent in `session/new` — what a real agent connects with. */
  async function agentClient(provider: AgentProviderId = "gemini"): Promise<Client> {
    const created = agents.get(provider)!.received.filter((message) => message.method === "session/new").at(-1);
    const entry = (created?.params as { mcpServers?: { url: string; headers: { value: string }[] }[] }).mcpServers![0]!;
    const client = new Client({ name: provider, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: entry.headers[0]!.value } } }));
    return client;
  }

  async function snapshotOf(sessionId: string, actor: RuntimeActor = ALICE) {
    const view = await send<{ session: RuntimeSessionView; approvals: RuntimeApprovalView[] }>({ name: "get_session", sessionId } as never, actor);
    const events = await send<{ events: SequencedControlEvent[] }>({ name: "get_events", sessionId, afterSequence: 0 } as never, actor);
    return { session: view.value!.session, approvals: view.value!.approvals, events: events.value!.events };
  }

  return { host, registry, agents, send, start, agentClient, snapshotOf, finishTurn: () => releaseTurn?.() };
}

/**
 * The approval-to-applied loop exactly as the Command Centre runs it: the
 * agent proposes over MCP, the person approves, the Command Centre applies
 * the change to its collections and reports it — `complete_context_action`
 * to the runtime, `record_workspace_change` to history.
 */
export async function approveAndApply(runtime: HistoryRuntime, sessionId: string, client: Client) {
  const proposal = client.callTool({ name: "create_collection", arguments: { name: "Pricing", tabIds: ["t1", "t2"] } });
  let approvalId = "";
  await until(async () => {
    approvalId = (await runtime.snapshotOf(sessionId)).approvals[0]?.approvalId ?? "";
    return Boolean(approvalId);
  });
  const granted = await runtime.send({ name: "respond_to_approval", approvalId, decision: "granted" } as never);
  if (!granted.ok) throw new Error("approval failed");

  let actionId = "";
  await until(async () => {
    actionId = (await runtime.snapshotOf(sessionId)).session.context?.pendingActions[0]?.actionId ?? "";
    return Boolean(actionId);
  });

  const created: Collection = { id: "c-new", workspaceId: "w-research", name: "Pricing", tabIds: ["t1", "t2"], createdAt: 5, updatedAt: 5 };
  const before = [SOURCES];
  const after = [SOURCES, created];
  const recorded = await runtime.send({
    name: "record_workspace_change",
    sessionId,
    change: { id: actionId, at: Date.now(), ok: true, steps: [{ kind: "created", collectionId: "c-new", name: "Pricing", tabCount: 2 }], before, after },
  } as never);
  await runtime.send({ name: "complete_context_action", sessionId, actionId, outcome: { ok: true, collectionId: "c-new" } } as never);
  await proposal;
  return { approvalId, actionId, before, after, recorded };
}
