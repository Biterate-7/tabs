// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createFakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { FOCUS_NOTE } from "@/lib/agents/session-context/focus";
import { createRuntimeHost } from "./host";
import { launchEntryFor } from "@/lib/agents/launch/allowlist";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { RuntimeCommand, RuntimeSessionView } from "./protocol";
import type { SessionContextServer } from "@/lib/agents/session-context/http";
import type { AgentAttachedContext } from "@/lib/agents/control/context";

/**
 * Workspace ↔ agent focus through the whole runtime.
 *
 * What the user points a session at (the tabs and collections they selected
 * when they asked) crosses as ordinary attached context. The runtime checks
 * it against the session's own workspace, reports it on the view by id, and
 * lets the agent read it back through the session's MCP server — and refuses
 * anything that reaches into another workspace, before it is recorded.
 *
 * Real host, control service, registry, loopback MCP server and ACP adapter;
 * the agent is a scripted ACP process that hands the test the credential an
 * agent would get, and nothing else.
 */

const LOCAL: ExecutionGateResult = {
  allowed: true,
  environment: "local",
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};
const ALICE: RuntimeActor = { id: "local" };
const ROOT = "C:/work/research";

const RESEARCH = {
  workspace: {
    id: "w-research",
    name: "Research",
    createdAt: 1,
    updatedAt: 2,
    tabs: [
      { id: "t1", url: "https://arxiv.org/abs/1", normalizedUrl: "https://arxiv.org/abs/1", domain: "arxiv.org", title: "Relativity paper" },
      { id: "t2", url: "https://home.cern/news", normalizedUrl: "https://home.cern/news", domain: "home.cern", title: "CERN article" },
      { id: "t3", url: "https://notes.example/rel", normalizedUrl: "https://notes.example/rel", domain: "notes.example", title: "relativity-notes" },
    ],
  },
  collections: [{ id: "c-physics", workspaceId: "w-research", name: "Physics", tabIds: ["t1", "t2"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
};

const PERSONAL = {
  workspace: {
    id: "w-personal",
    name: "Personal finances",
    createdAt: 1,
    updatedAt: 2,
    tabs: [{ id: "p1-tab", url: "https://bank.example/statement", normalizedUrl: "https://bank.example/statement", domain: "bank.example", title: "Bank statement" }],
  },
  collections: [{ id: "c-bank", workspaceId: "w-personal", name: "Bank", tabIds: ["p1-tab"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
};

function attachment(kind: "tab" | "collection" | "workspace", id: string, label = id) {
  return { kind, id, label };
}

function context(attachments: ReturnType<typeof attachment>[], snapshotId = `snap-${Math.random()}`): AgentAttachedContext {
  return { snapshotId, capturedAt: 1, attachments };
}

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
    runtimeId: "rt-focus",
  });

  async function send<T = RuntimeSessionView>(command: RuntimeCommand) {
    const result = await host.execute(ALICE, command as never);
    return result as unknown as { ok: boolean; value?: T; error?: { code: string } };
  }

  async function authorize() {
    await send({
      name: "authorize_projects",
      projects: [
        {
          id: "p1",
          name: "Research",
          path: ROOT,
          providers: ["gemini"],
          permissions: { scopes: ["read_workspace", "read_project", "write_workspace"], projectId: "p1", grantedAt: 1 },
        },
      ],
    } as never);
  }

  async function start(snapshot: typeof RESEARCH, extra: Record<string, unknown> = {}) {
    await authorize();
    return send<RuntimeSessionView>({
      name: "create_session",
      provider: "gemini",
      projectId: "p1",
      workspaceId: snapshot.workspace.id,
      contextSnapshot: snapshot,
      ...extra,
    } as never);
  }

  function credential(): { url: string; token: string } {
    const created = agent.received.filter((message) => message.method === "session/new").at(-1);
    const entry = (created?.params as { mcpServers: { url: string; headers: { value: string }[] }[] }).mcpServers[0]!;
    return { url: entry.url, token: entry.headers[0]!.value.replace(/^Bearer /, "") };
  }

  async function view(sessionId: string): Promise<RuntimeSessionView> {
    const got = await send<{ session: RuntimeSessionView }>({ name: "get_session", sessionId } as never);
    return got.value!.session;
  }

  return { host, registry, send, start, credential, view };
}

async function mcp(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

const text = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

describe("focus inside the session's workspace", () => {
  it("is reported on the view by id, delivered with the next message, and readable by the agent", async () => {
    const h = build();
    const created = await h.start(RESEARCH);
    const sessionId = created.value!.sessionId;
    expect(created.value!.focus).toBeUndefined();

    const attached = await h.send({
      name: "attach_context",
      sessionId,
      context: context([attachment("collection", "c-physics", "Physics"), attachment("tab", "t3", "relativity-notes")]),
    } as never);
    expect(attached.ok).toBe(true);
    expect(attached.value!.focus).toEqual({ tabIds: ["t3"], collectionIds: ["c-physics"], delivered: false });

    const client = await mcp(h.credential().url, h.credential().token);
    const summary = text(await client.callTool({ name: "get_workspace_summary", arguments: {} }));
    expect(summary.focus).toEqual({
      tabs: [{ tabId: "t3", title: "relativity-notes", domain: "notes.example" }],
      collections: [{ collectionId: "c-physics", name: "Physics", tabCount: 2 }],
      note: FOCUS_NOTE,
    });
    expect(text(await client.callTool({ name: "get_context_status", arguments: {} })).focus.collections).toHaveLength(1);

    // Focus is attention, not content: it never moves the context version.
    expect(summary.contextVersion).toBe(1);
    expect(h.registry.binding(sessionId)?.version).toBe(1);

    await h.send({ name: "send_message", sessionId, text: "Compare these sources." } as never);
    expect((await h.view(sessionId)).focus?.delivered).toBe(true);
    await client.close();
  });

  it("is cleared by detaching, for the view and for the agent", async () => {
    const h = build();
    const sessionId = (await h.start(RESEARCH)).value!.sessionId;
    await h.send({ name: "attach_context", sessionId, context: context([attachment("tab", "t1")]) } as never);
    await h.send({ name: "detach_context", sessionId } as never);

    expect((await h.view(sessionId)).focus).toBeUndefined();
    const client = await mcp(h.credential().url, h.credential().token);
    expect(text(await client.callTool({ name: "get_workspace_summary", arguments: {} })).focus).toBeUndefined();
    await client.close();
  });

  it("is looked up live: a tab renamed in Hubble reads under its new name, a removed one drops out", async () => {
    const h = build();
    const sessionId = (await h.start(RESEARCH)).value!.sessionId;
    await h.send({ name: "attach_context", sessionId, context: context([attachment("tab", "t1"), attachment("tab", "t2")]) } as never);

    const renamed = structuredClone(RESEARCH);
    renamed.workspace.tabs = [{ ...renamed.workspace.tabs[0]!, title: "Special relativity (1905)" }, renamed.workspace.tabs[2]!];
    renamed.collections[0]!.tabIds = ["t1"];
    await h.send({ name: "sync_session_context", sessionId, snapshot: renamed } as never);

    const client = await mcp(h.credential().url, h.credential().token);
    const focus = text(await client.callTool({ name: "get_workspace_summary", arguments: {} })).focus;
    expect(focus.tabs).toEqual([{ tabId: "t1", title: "Special relativity (1905)", domain: "arxiv.org" }]);
    await client.close();
  });

  it("starts with a new session when the session is created with context from its own workspace", async () => {
    const h = build();
    const created = await h.start(RESEARCH, { context: context([attachment("tab", "t2", "CERN article")]) });
    expect(created.ok).toBe(true);
    expect(created.value!.focus).toMatchObject({ tabIds: ["t2"], collectionIds: [] });
    const client = await mcp(h.credential().url, h.credential().token);
    expect(text(await client.callTool({ name: "get_workspace_summary", arguments: {} })).focus.tabs[0].title).toBe("CERN article");
    await client.close();
  });
});

describe("cross-workspace isolation", () => {
  it("refuses context naming another workspace's tab, and records nothing", async () => {
    const h = build();
    const sessionId = (await h.start(RESEARCH)).value!.sessionId;
    await h.send({ name: "attach_context", sessionId, context: context([attachment("tab", "t1")], "first") } as never);

    const refused = await h.send({
      name: "attach_context",
      sessionId,
      context: context([attachment("tab", "t2"), attachment("tab", "p1-tab", "Bank statement")], "foreign"),
    } as never);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("context_invalid");

    const after = await h.view(sessionId);
    expect(after.focus).toMatchObject({ tabIds: ["t1"] });
    expect(after.contextSnapshotId).toBe("first");
    expect(h.registry.focus(sessionId)).toEqual({ tabIds: ["t1"], collectionIds: [] });
  });

  it("refuses another workspace's collection, and a workspace attachment that is not its own", async () => {
    const h = build();
    const sessionId = (await h.start(RESEARCH)).value!.sessionId;
    for (const foreign of [attachment("collection", "c-bank", "Bank"), attachment("workspace", "w-personal", "Personal finances")]) {
      const refused = await h.send({ name: "attach_context", sessionId, context: context([foreign]) } as never);
      expect(refused.error?.code).toBe("context_invalid");
    }
    expect((await h.view(sessionId)).focus).toBeUndefined();
    // Its own workspace, by name, is fine.
    expect((await h.send({ name: "attach_context", sessionId, context: context([attachment("workspace", "w-research", "Research")]) } as never)).ok).toBe(true);
  });

  it("refuses to start a session whose starting context reaches into another workspace", async () => {
    const h = build();
    const created = await h.start(RESEARCH, { context: context([attachment("tab", "p1-tab", "Bank statement")]) });
    expect(created.ok).toBe(false);
    expect(created.error?.code).toBe("context_invalid");
    expect((await h.send<{ sessions: unknown[] }>({ name: "list_sessions" } as never)).value!.sessions).toHaveLength(0);
    expect(h.registry.activeCount()).toBe(0);
  });

  it("keeps Workspace A's session out of Workspace B — at the server, whatever it asks for", async () => {
    const h = build();
    const research = (await h.start(RESEARCH)).value!.sessionId;
    const researchCredential = h.credential();
    const personal = (await h.start(PERSONAL as unknown as typeof RESEARCH)).value!.sessionId;
    const personalCredential = h.credential();
    await h.send({ name: "attach_context", sessionId: personal, context: context([attachment("tab", "p1-tab")]) } as never);

    const client = await mcp(researchCredential.url, researchCredential.token);
    // Named directly, the other workspace is refused.
    const denied = await client.callTool({ name: "get_workspace", arguments: { workspaceId: "w-personal" } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain("Bank statement");
    // Enumerated, only its own exists.
    const listed = JSON.stringify(await client.callTool({ name: "list_workspaces", arguments: {} }));
    expect(listed).toContain("Research");
    expect(listed).not.toContain("Personal finances");
    // Another session's focus is not this session's.
    const summary = text(await client.callTool({ name: "get_workspace_summary", arguments: {} }));
    expect(summary.focus).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain("Bank");
    // A tab id from the other workspace is never echoed back.
    const tabs = JSON.stringify(await client.callTool({ name: "get_tabs", arguments: { tabIds: ["p1-tab"] } }));
    expect(tabs).not.toContain("Bank statement");
    await client.close();

    // And the other way round.
    const other = await mcp(personalCredential.url, personalCredential.token);
    expect((await other.callTool({ name: "get_workspace", arguments: { workspaceId: "w-research" } })).isError).toBe(true);
    expect(text(await other.callTool({ name: "get_workspace_summary", arguments: {} })).focus.tabs[0].title).toBe("Bank statement");
    await other.close();
    expect(research).not.toBe(personal);
  });

  it("forgets the focus with the session: after dispose the credential is refused and nothing is left", async () => {
    const h = build();
    const sessionId = (await h.start(RESEARCH)).value!.sessionId;
    const { url, token } = h.credential();
    await h.send({ name: "attach_context", sessionId, context: context([attachment("tab", "t1")]) } as never);
    await h.send({ name: "dispose_session", sessionId } as never);
    expect(h.registry.focus(sessionId)).toBeUndefined();
    await expect(mcp(url, token)).rejects.toThrow();
  });
});
