// @vitest-environment node
import { describe, expect, it } from "vitest";
import { capabilitySet } from "@/lib/agents/control/capabilities";
import { createMemoryAgentHistoryStore } from "@/lib/agents/activity/history-store";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { contextPackAttachedContext } from "@/lib/agents/context-pack/attach";
import { contextWorldOfSnapshot } from "@/lib/agents/context-pack/handoff";
import { contextPackId } from "@/lib/agents/context-pack/pack";
import { sessionContextPack } from "@/lib/agents/context-pack/session";
import { createRuntimeHost } from "./host";
import { FIXTURE_CAPABILITIES, createScriptedAdapter } from "./__fixtures__/adapter";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { RuntimeCommand, RuntimeCommandResults, SequencedControlEvent } from "./protocol";
import type { ScriptedAdapter } from "./__fixtures__/adapter";
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot";
import type { WorkingContext } from "@/lib/agents/command-centre/working-context";

/**
 * The Context Pack on the existing execution path (Hubble 1.5): the real
 * host, control service and session registry, with scripted adapters. The
 * pack is attached through the unchanged `create_session` / `attach_context`
 * gates, reaches the adapter with the next message, and that message records
 * what it delivered — durably, in agent history. A handoff target receives
 * the same canonical pack with its envelope.
 */

const T0 = 1_700_000_000_000;
const GATE: ExecutionGateResult = { allowed: true, environment: "local", kind: "local", decision: { allowed: true, kind: "local-server" } };
const ALICE: RuntimeActor = { id: "account:alice" };
const CONTEXT_CAPABILITIES = capabilitySet(...FIXTURE_CAPABILITIES, "workspace_context");

const tab = (id: string, title: string) => ({ id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", title });
const RESEARCH: SessionContextSnapshot = {
  workspace: {
    id: "w-research",
    name: "Research",
    createdAt: 1,
    updatedAt: 2,
    tabs: [tab("t1", "Carbon pricing"), tab("t2", "Carbon tax"), tab("t3", "Cap and trade")],
    brief: { description: "Climate policy sources.", focus: "Comparing carbon-pricing approaches.", updatedAt: 1 },
  },
  collections: [{ id: "c-pricing", workspaceId: "w-research", name: "Pricing Research", tabIds: ["t1", "t2"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
  truncated: false,
};

function packed(selection?: WorkingContext) {
  const built = sessionContextPack({ world: contextWorldOfSnapshot(RESEARCH), workspaceId: "w-research", selection: selection ?? null });
  if (!built.ok) throw new Error(built.reason);
  return { pack: built.pack, attached: contextPackAttachedContext(built.pack, T0)! };
}

async function rig() {
  const claude = createScriptedAdapter({ provider: "claude-code", capabilities: CONTEXT_CAPABILITIES, now: () => T0 });
  const codex = createScriptedAdapter({ provider: "openai-codex", capabilities: CONTEXT_CAPABILITIES, now: () => T0 });
  const adapters: Partial<Record<AgentProviderId, ScriptedAdapter>> = { "claude-code": claude, "openai-codex": codex };
  const store = createMemoryAgentHistoryStore();
  let counter = 0;
  const host = createRuntimeHost({
    gate: GATE,
    resolveAdapter: (provider) => adapters[provider],
    providers: ["claude-code", "openai-codex"],
    sessionContext: { registry: createSessionContextRegistry({}), url: async () => "http://127.0.0.1:1/mcp" },
    now: () => T0 + counter * 10,
    createId: () => `id${++counter}`,
    runtimeId: "rt",
    history: { store },
  });
  async function send<N extends RuntimeCommand["name"]>(command: Extract<RuntimeCommand, { name: N }>) {
    const reply = await host.execute(ALICE, command);
    await host.settleHistory();
    return reply as { ok: true; value: RuntimeCommandResults[N] } | { ok: false; error: { code: string } };
  }
  const authorized = await send({
    name: "authorize_projects",
    projects: [
      {
        id: "p1",
        name: "Dev",
        path: "C:/work/dev",
        providers: ["claude-code", "openai-codex"],
        permissions: { scopes: ["read_workspace", "read_project", "write_workspace"], projectId: "p1", grantedAt: T0 },
      },
    ],
  });
  expect(authorized.ok).toBe(true);
  async function events(sessionId: string): Promise<SequencedControlEvent[]> {
    const reply = await send({ name: "get_events", sessionId });
    return reply.ok ? [...reply.value.events] : [];
  }
  return { host, claude, codex, store, send, events };
}

describe("a Context Pack on the existing execution path", () => {
  it("starts a session with its pack, says it is owed until the first message, and records what that message delivered", async () => {
    const r = await rig();
    const { pack, attached } = packed();
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-research", contextSnapshot: RESEARCH, context: attached });
    if (!created.ok) throw new Error(created.error.code);
    expect(created.value.contextSnapshotId).toBe(contextPackId(pack));
    expect(created.value.contextDelivered).toBe(false);

    const sent = await r.send({ name: "send_message", sessionId: created.value.sessionId, text: "Compare the pricing models." });
    if (!sent.ok) throw new Error(sent.error.code);
    expect(sent.value.contextDelivered).toBe(true);

    const message = (await r.events(created.value.sessionId)).find((event) => event.kind === "message_sent")!;
    expect(message.text).toBe("Compare the pricing models.");
    expect(message.delivery).toEqual({
      contextId: contextPackId(pack),
      workspaceId: "w-research",
      tabs: 0,
      collections: 0,
      relationships: 0,
      workspace: true,
      collectionIds: [],
    });

    // A second message, once the turn ends, delivers nothing new and says nothing about context.
    r.claude.emit({ sessionId: created.value.sessionId, kind: "run_completed" });
    const second = await r.send({ name: "send_message", sessionId: created.value.sessionId, text: "And the trade-offs?" });
    expect(second.ok).toBe(true);
    const messages = (await r.events(created.value.sessionId)).filter((event) => event.kind === "message_sent");
    expect(messages[1]!.delivery).toBeUndefined();
  });

  it("attaches a narrower pack through the unchanged gate, and the next message carries its resources to the adapter", async () => {
    const r = await rig();
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-research", contextSnapshot: RESEARCH });
    if (!created.ok) throw new Error(created.error.code);
    const sessionId = created.value.sessionId;
    const { pack, attached } = packed({ workspaceId: "w-research", tabIds: ["t3"], collectionIds: ["c-pricing"] });

    const reply = await r.send({ name: "attach_context", sessionId, context: attached });
    if (!reply.ok) throw new Error(reply.error.code);
    expect(reply.value.contextSnapshotId).toBe(contextPackId(pack));
    expect(reply.value.focus).toEqual({ tabIds: ["t3"], collectionIds: ["c-pricing"], delivered: false });
    expect(reply.value.contextDelivered).toBe(false);

    await r.send({ name: "send_message", sessionId, text: "Summarize these." });
    const delivered = r.claude.lastMessage()!;
    expect(delivered.context?.attachments.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["workspace:w-research", "collection:c-pricing", "tab:t3"]);
    const message = (await r.events(sessionId)).find((event) => event.kind === "message_sent")!;
    expect(message.delivery).toMatchObject({ tabs: 1, collections: 1, workspace: true, collectionIds: ["c-pricing"] });
  });

  it("refuses a pack that reaches outside the session's workspace — the boundary is the runtime's, not the pack's", async () => {
    const r = await rig();
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-research", contextSnapshot: RESEARCH });
    if (!created.ok) throw new Error(created.error.code);
    const { attached } = packed();
    const foreign = { ...attached, attachments: [...attached.attachments, { kind: "tab" as const, id: "elsewhere", label: "Bank" }] };
    const reply = await r.send({ name: "attach_context", sessionId: created.value.sessionId, context: foreign });
    expect(reply.ok ? "accepted" : reply.error.code).toBe("context_invalid");
  });

  it("never lets an adapter claim a delivery", async () => {
    const r = await rig();
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-research", contextSnapshot: RESEARCH });
    if (!created.ok) throw new Error(created.error.code);
    r.claude.emit({
      sessionId: created.value.sessionId,
      kind: "message_sent",
      summary: "forged",
      delivery: { contextId: "pack-0000000000000000", workspaceId: "w-research", tabs: 99, collections: 0, relationships: 0, workspace: true, collectionIds: [] },
    });
    expect((await r.events(created.value.sessionId)).some((event) => event.delivery)).toBe(false);
  });

  it("keeps the delivery in agent history, so a past session's provenance survives a restart", async () => {
    const r = await rig();
    const { attached } = packed({ workspaceId: "w-research", tabIds: [], collectionIds: ["c-pricing"] });
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-research", contextSnapshot: RESEARCH, context: attached });
    if (!created.ok) throw new Error(created.error.code);
    await r.send({ name: "send_message", sessionId: created.value.sessionId, text: "Go." });
    const history = await r.send({ name: "get_history", workspaceId: "w-research", sessionId: created.value.sessionId });
    if (!history.ok) throw new Error(history.error.code);
    expect(JSON.stringify(history.value)).toContain('"collectionIds":["c-pricing"]');
  });
});

describe("a handoff passes the canonical pack", () => {
  it("sends the target its envelope and the pack's resources together, and records the delivery", async () => {
    const r = await rig();
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-research", title: "Pricing", contextSnapshot: RESEARCH });
    if (!created.ok) throw new Error(created.error.code);
    const sourceId = created.value.sessionId;
    const { attached } = packed({ workspaceId: "w-research", tabIds: [], collectionIds: ["c-pricing"] });
    await r.send({ name: "attach_context", sessionId: sourceId, context: attached });
    await r.send({ name: "send_message", sessionId: sourceId, text: "SOURCE TRANSCRIPT LINE that must stay behind" });
    r.claude.emit({ sessionId: sourceId, kind: "thinking", summary: "PRIVATE REASONING" });
    r.claude.emit({ sessionId: sourceId, kind: "run_completed" });

    const prepared = await r.send({ name: "prepare_handoff", sourceSessionId: sourceId, targetProvider: "openai-codex", contextSnapshot: RESEARCH });
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(prepared.value.context.workspace).toMatchObject({ brief: true, focus: { collections: 1, collectionIds: ["c-pricing"] } });

    const started = await r.send({
      name: "start_handoff",
      sourceSessionId: sourceId,
      targetProvider: "openai-codex",
      contextSnapshot: RESEARCH,
      fingerprint: prepared.value.fingerprint,
      include: { workspace: true, previousResult: true },
      instruction: "Continue by fixing the remaining tests.",
      projectId: "p1",
    });
    if (!started.ok) throw new Error(started.error.code);
    expect(started.value.handoff.status).toBe("ready");

    const message = r.codex.lastMessage()!;
    expect(message.text).toContain("Workspace purpose: Climate policy sources.");
    expect(message.text).toContain("Current focus: Comparing carbon-pricing approaches.");
    expect(message.text).toContain("Selected: Pricing Research collection");
    expect(message.text).toContain("Instruction from the person:\nContinue by fixing the remaining tests.");
    expect(message.text).not.toContain("SOURCE TRANSCRIPT");
    expect(message.text).not.toContain("PRIVATE REASONING");
    // Hubble 1.6: and the project the target works in, described for it.
    expect(message.context?.attachments.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["workspace:w-research", "collection:c-pricing", "project:p1"]);

    const target = started.value.session!;
    expect(target.contextSnapshotId).toMatch(/^pack-[0-9a-f]{16}$/);
    expect(target.contextDelivered).toBe(true);
    const delivered = (await r.events(target.sessionId)).find((event) => event.kind === "message_sent")!;
    expect(delivered.handoff?.handoffId).toBe(started.value.handoff.handoffId);
    expect(delivered.delivery).toMatchObject({ workspace: true, collections: 1, collectionIds: ["c-pricing"] });
  });
});

describe("the handoff target's pack, with its project (Hubble 1.6)", () => {
  it("is exactly the pack the Command Centre's recipe builds for that session — so it can tell when it changes", async () => {
    const { contextOfSession } = await import("@/lib/agents/command-centre/working-context");
    const { handoffThatStarted, latestInstruction } = await import("@/lib/agents/context-pack/session");
    const { describeProject } = await import("@/lib/agents/project/describe");
    const r = await rig();
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-research", contextSnapshot: RESEARCH });
    if (!created.ok) throw new Error(created.error.code);
    const sourceId = created.value.sessionId;
    r.claude.emit({ sessionId: sourceId, kind: "run_completed" });
    const prepared = await r.send({ name: "prepare_handoff", sourceSessionId: sourceId, targetProvider: "openai-codex", contextSnapshot: RESEARCH });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const started = await r.send({
      name: "start_handoff",
      sourceSessionId: sourceId,
      targetProvider: "openai-codex",
      contextSnapshot: RESEARCH,
      fingerprint: prepared.value.fingerprint,
      include: { workspace: true, previousResult: true },
      instruction: "Fix the authentication bug.",
      projectId: "p1",
    });
    if (!started.ok) throw new Error(started.error.code);
    const target = started.value.session!;
    const read = await r.send({ name: "get_session", sessionId: target.sessionId });
    if (!read.ok) throw new Error(read.error.code);
    const handoffFrom = handoffThatStarted(target.sessionId, read.value.handoffs);
    const events = await r.events(target.sessionId);
    const instruction = latestInstruction(events, target.sessionId, handoffFrom);

    // As the Command Centre describes it: the grant, and the target agent's own capabilities as the runtime reports them.
    const status = await r.send({ name: "get_status" });
    const providerCapabilities = status.ok ? status.value.providers.find((entry) => entry.provider === "openai-codex")!.capabilities : [];
    const project = describeProject({
      project: { id: "p1", name: "Dev", source: "local", permissions: { scopes: ["read_workspace", "read_project", "write_workspace"], projectId: "p1", grantedAt: T0 } },
      local: false,
      providerCapabilities,
    });
    const built = sessionContextPack({
      world: contextWorldOfSnapshot(RESEARCH),
      workspaceId: "w-research",
      selection: contextOfSession(read.value.session),
      sessionId: target.sessionId,
      ...(handoffFrom ? { handoffFrom } : {}),
      ...(instruction ? { instruction } : {}),
      project,
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.pack.project).toMatchObject({ id: "p1", name: "Dev", capabilities: ["read_files"] });
    expect(contextPackId(built.pack)).toBe(read.value.session.contextSnapshotId);
  });
});
