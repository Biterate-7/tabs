// @vitest-environment node
import { describe, expect, it } from "vitest";
import { capabilitySet } from "@/lib/agents/control/capabilities";
import { createMemoryAgentHistoryStore } from "@/lib/agents/activity/history-store";
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline";
import { inspectActivityEntry } from "@/lib/agents/activity/inspector";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { createRuntimeHost } from "./host";
import { FIXTURE_CAPABILITIES, createScriptedAdapter } from "./__fixtures__/adapter";
import type { AgentHistoryDetail, AgentHistoryPage } from "@/lib/agents/activity/history";
import type { AgentHistoryStore } from "@/lib/agents/activity/history-store";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { ControlResult } from "@/lib/agents/control/types";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type {
  RuntimeCommand,
  RuntimeCommandResults,
  RuntimeHandoffPreview,
  RuntimeSessionView,
  SequencedControlEvent,
} from "./protocol";
import type { ScriptedAdapter } from "./__fixtures__/adapter";

/**
 * Explicit agent handoff through the runtime (Hubble 1.4): the real host,
 * control service, approval broker and session registry, with scripted
 * adapters standing in for Claude Code and Codex. What the runtime checks,
 * what it starts, what the target is told, what each stream says, and what
 * history keeps — including every way it refuses or fails.
 *
 * The same journey against a real ACP agent and the real MCP server is
 * handoff-flow.test.ts; against real PostgreSQL across a restart,
 * history-restart.pg.test.ts.
 */

const T0 = 1_700_000_000_000;
const GATE: ExecutionGateResult = { allowed: true, environment: "local", kind: "local", decision: { allowed: true, kind: "local-server" } };
const ALICE: RuntimeActor = { id: "account:alice" };
const BOB: RuntimeActor = { id: "account:bob" };
const CONTEXT_CAPABILITIES = capabilitySet(...FIXTURE_CAPABILITIES, "workspace_context");

const tab = (id: string, title: string) => ({ id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", title });
const DEVELOPMENT = {
  workspace: { id: "w-dev", name: "Development", createdAt: 1, updatedAt: 2, tabs: [tab("t1", "Spec"), tab("t2", "API docs"), tab("t3", "Issue")] },
  collections: [{ id: "c1", workspaceId: "w-dev", name: "Reading", tabIds: ["t1"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
  truncated: false,
};
const PRIVATE = {
  workspace: { id: "w-private", name: "Private", createdAt: 1, updatedAt: 2, tabs: [tab("p1", "Bank")] },
  collections: [],
  dependencies: [],
  truncated: false,
};

type Rig = Awaited<ReturnType<typeof rig>>;

async function rig(
  options: {
    targetCreate?: ControlResult<never>;
    targetSendFails?: boolean;
    targetStatus?: "connected" | "configuration_required" | "unavailable";
    store?: AgentHistoryStore;
    targetCapabilities?: ReturnType<typeof capabilitySet>;
  } = {}
) {
  const claude = createScriptedAdapter({ provider: "claude-code", capabilities: CONTEXT_CAPABILITIES, now: () => T0 });
  const codex = createScriptedAdapter({
    provider: "openai-codex",
    capabilities: options.targetCapabilities ?? CONTEXT_CAPABILITIES,
    now: () => T0,
    ...(options.targetCreate ? { failCreate: options.targetCreate } : {}),
  });
  if (options.targetSendFails) {
    codex.sendMessage = async () => ({ ok: false, error: { code: "unreachable", message: "pipe closed" } });
  }
  if (options.targetStatus) {
    const kind = options.targetStatus;
    codex.getConnectionStatus = () => ({ kind, since: T0 }) as never;
  }
  const adapters: Partial<Record<AgentProviderId, ScriptedAdapter>> = { "claude-code": claude, "openai-codex": codex };
  const registry = createSessionContextRegistry({});
  let counter = 0;
  const host = createRuntimeHost({
    gate: GATE,
    resolveAdapter: (provider) => adapters[provider],
    providers: ["claude-code", "openai-codex", "gemini"],
    sessionContext: { registry, url: async () => "http://127.0.0.1:1/mcp" },
    now: () => T0 + counter * 10,
    createId: () => `id${++counter}`,
    runtimeId: "rt",
    ...(options.store ? { history: { store: options.store } } : {}),
  });

  async function send<N extends RuntimeCommand["name"]>(command: Extract<RuntimeCommand, { name: N }>, actor: RuntimeActor = ALICE) {
    const reply = await host.execute(actor, command);
    await host.settleHistory();
    return reply as { ok: true; value: RuntimeCommandResults[N] } | { ok: false; error: { code: string } };
  }

  async function authorize(actor: RuntimeActor = ALICE, scopes: string[] = ["read_workspace", "read_project", "write_workspace"]) {
    const reply = await send(
      {
        name: "authorize_projects",
        projects: [
          { id: "p1", name: "Dev", path: "C:/work/dev", providers: ["claude-code", "openai-codex"], permissions: { scopes, projectId: "p1", grantedAt: T0 } },
          { id: "p-claude-only", name: "Claude only", path: "C:/work/claude", providers: ["claude-code"], permissions: { scopes, projectId: "p-claude-only", grantedAt: T0 } },
        ],
      },
      actor
    );
    expect(reply.ok).toBe(true);
  }

  async function source(actor: RuntimeActor = ALICE, snapshot = DEVELOPMENT) {
    await authorize(actor);
    const created = await send(
      { name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: snapshot.workspace.id, title: "Research the API", contextSnapshot: snapshot },
      actor
    );
    if (!created.ok) throw new Error(created.error.code);
    return created.value.sessionId;
  }

  async function events(sessionId: string, actor: RuntimeActor = ALICE): Promise<SequencedControlEvent[]> {
    const reply = await send({ name: "get_events", sessionId }, actor);
    return reply.ok ? [...reply.value.events] : [];
  }

  async function prepare(sourceSessionId: string, targetProvider: AgentProviderId = "openai-codex", actor: RuntimeActor = ALICE, snapshot: typeof DEVELOPMENT | undefined = DEVELOPMENT) {
    return send({ name: "prepare_handoff", sourceSessionId, targetProvider, ...(snapshot ? { contextSnapshot: snapshot } : {}) }, actor);
  }

  async function start(
    preview: RuntimeHandoffPreview,
    over: Partial<Extract<RuntimeCommand, { name: "start_handoff" }>> = {},
    actor: RuntimeActor = ALICE
  ) {
    return send(
      {
        name: "start_handoff",
        sourceSessionId: preview.sourceSessionId,
        targetProvider: preview.targetProvider,
        contextSnapshot: DEVELOPMENT,
        fingerprint: preview.fingerprint,
        include: { workspace: true, previousResult: true },
        instruction: "Implement the plan from the previous agent.",
        projectId: "p1",
        ...over,
      },
      actor
    );
  }

  return { host, registry, claude, codex, send, authorize, source, events, prepare, start };
}

/** The source does some work the Command Centre applied: a collection, as `record_workspace_change` reports it. */
async function didWork(r: Rig, sessionId: string) {
  r.claude.emit({ sessionId, kind: "file_created", file: { relativePath: "docs/plan.md", projectId: "p1" } });
  await r.send({
    name: "record_workspace_change",
    sessionId,
    change: { id: "chg-1", at: T0 + 5, ok: true, steps: [{ kind: "created", collectionId: "c-plan", name: "Implementation Plan", tabCount: 2 }] },
  });
  r.claude.emit({ sessionId, kind: "run_completed" });
}

async function preview(r: Rig, sourceSessionId: string) {
  const prepared = await r.prepare(sourceSessionId);
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared.value;
}

describe("preparing a handoff", () => {
  it("previews exactly what would be passed: the workspace in counts, the focus, and the source's results", async () => {
    const r = await rig();
    const sourceId = await r.source();
    await r.send({ name: "attach_context", sessionId: sourceId, context: { snapshotId: "snap", capturedAt: T0, attachments: [{ kind: "tab", id: "t1", label: "Spec" }] } });
    await didWork(r, sourceId);

    const value = await preview(r, sourceId);
    expect(value).toMatchObject({
      sourceSessionId: sourceId,
      sourceProvider: "claude-code",
      targetProvider: "openai-codex",
      workspaceId: "w-dev",
      contextTools: true,
      context: {
        // The tab the source was pointed at is carried over, as a count.
        workspace: { tabs: 3, collections: 1, focus: { tabs: 1, collections: 0 } },
        previousResult: { outcome: "finished", more: 0 },
      },
    });
    // Its results, in the timeline's words: the file it wrote and the collection the Command Centre applied.
    expect(value.context.previousResult!.lines).toEqual(
      expect.arrayContaining([
        { title: "Created plan.md", description: "docs/plan.md" },
        { title: "Created collection “Implementation Plan”", description: "2 tabs" },
      ])
    );
    expect(value.context.previousResult!.lines).toHaveLength(2);
    expect(value.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // Starts nothing, records nothing.
    expect(r.codex.calls).not.toContain("createSession");
    expect((await r.events(sourceId)).some((event) => event.kind === "handoff_sent")).toBe(false);
  });

  it("refuses a session that does not exist, or is someone else's", async () => {
    const r = await rig();
    const sourceId = await r.source();
    expect(await r.prepare("nope")).toMatchObject({ ok: false, error: { code: "session_not_found" } });
    await r.authorize(BOB);
    expect(await r.prepare(sourceId, "openai-codex", BOB)).toMatchObject({ ok: false, error: { code: "ownership_denied" } });
  });

  it("refuses a session that is still working, or waiting on a decision", async () => {
    const r = await rig();
    const sourceId = await r.source();
    r.claude.emit({ sessionId: sourceId, kind: "tool_started", tool: { name: "Edit" } });
    expect(await r.prepare(sourceId)).toMatchObject({ ok: false, error: { code: "invalid_session_state" } });
  });

  it("refuses a session that works in no workspace — there is nothing to hand on in", async () => {
    const r = await rig();
    await r.authorize();
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1" });
    expect(created.ok).toBe(true);
    const sessionId = (created as { value: RuntimeSessionView }).value.sessionId;
    expect(await r.prepare(sessionId, "openai-codex", ALICE, undefined)).toMatchObject({ ok: false, error: { code: "invalid_session_state" } });
  });

  it("refuses an agent this runtime cannot start, or one not signed in", async () => {
    const r = await rig();
    const sourceId = await r.source();
    expect(await r.prepare(sourceId, "gemini")).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });

    const signedOut = await rig({ targetStatus: "configuration_required" });
    const fromSignedOut = await signedOut.source();
    expect(await signedOut.prepare(fromSignedOut)).toMatchObject({ ok: false, error: { code: "authentication_required" } });

    const missing = await rig({ targetStatus: "unavailable" });
    const fromMissing = await missing.source();
    expect(await missing.prepare(fromMissing)).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
  });

  it("never reaches another workspace: a snapshot of any workspace but the source's is refused", async () => {
    const r = await rig();
    const sourceId = await r.source();
    expect(await r.prepare(sourceId, "openai-codex", ALICE, PRIVATE as never)).toMatchObject({ ok: false, error: { code: "context_invalid" } });
  });
});

describe("starting a handoff", () => {
  it("creates the target session in the same workspace, tells it exactly what was chosen, and links the two", async () => {
    const r = await rig();
    const sourceId = await r.source();
    await didWork(r, sourceId);
    const value = await preview(r, sourceId);

    const started = await r.start(value);
    expect(started.ok).toBe(true);
    const { handoff, session, error } = (started as { value: RuntimeCommandResults["start_handoff"] }).value;
    expect(error).toBeUndefined();
    expect(handoff).toMatchObject({
      workspaceId: "w-dev",
      sourceSessionId: sourceId,
      sourceProvider: "claude-code",
      targetProvider: "openai-codex",
      status: "ready",
      instruction: "Implement the plan from the previous agent.",
      context: { workspace: { tabs: 3, collections: 1 }, previousResult: { outcome: "finished" } },
    });
    // Two sessions, two identities.
    expect(session!.sessionId).not.toBe(sourceId);
    expect(handoff.targetSessionId).toBe(session!.sessionId);
    expect(session).toMatchObject({ provider: "openai-codex", workspaceId: "w-dev", projectId: "p1", title: "Research the API" });
    expect(session!.context?.workspaceId).toBe("w-dev");
    expect(session!.handoff).toEqual({ from: { handoffId: handoff.handoffId, sessionId: sourceId, provider: "claude-code", status: "ready" } });

    // What Codex was told: the structured envelope, as its first message.
    const told = r.codex.lastMessage()!.text;
    expect(told.split("\n")[0]).toBe("HUBBLE HANDOFF");
    expect(told).toContain("Workspace: Development");
    expect(told).toContain("Previous agent: Claude Code");
    expect(told).toContain("- Created collection “Implementation Plan” (2 tabs)");
    expect(told).toContain("Workspace context: 3 tabs · 1 collection");
    expect(told).toContain("Implement the plan from the previous agent.");

    // Each stream says its half, in order.
    const target = await r.events(session!.sessionId);
    expect(target.map((event) => event.kind)).toEqual(["message_sent", "handoff_received", "context_loaded"]);
    expect(target[0]!.handoff?.handoffId).toBe(handoff.handoffId);
    expect(target[1]!.handoff).toMatchObject({ peerProvider: "claude-code", peerSessionId: sourceId });
    const sent = (await r.events(sourceId)).filter((event) => event.kind === "handoff_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.handoff).toMatchObject({ outcome: "ready", peerProvider: "openai-codex", peerSessionId: session!.sessionId });

    // The source is untouched — still its own session, still where it was.
    const sourceView = await r.send({ name: "get_session", sessionId: sourceId });
    expect(sourceView.ok && sourceView.value.session).toMatchObject({ status: "ready", provider: "claude-code" });
    expect(sourceView.ok && sourceView.value.session.handoff?.to?.[0]).toMatchObject({ provider: "openai-codex", sessionId: session!.sessionId });
    expect(sourceView.ok && sourceView.value.handoffs?.[0]?.handoffId).toBe(handoff.handoffId);

    // And the list shows both, linked.
    const list = await r.send({ name: "list_sessions" });
    expect(list.ok && list.value.sessions.map((entry) => entry.handoff)).toEqual(
      expect.arrayContaining([expect.objectContaining({ to: expect.any(Array) }), expect.objectContaining({ from: expect.any(Object) })])
    );
  });

  it("passes only the modes the person kept", async () => {
    const r = await rig();
    const sourceId = await r.source();
    await didWork(r, sourceId);
    const value = await preview(r, sourceId);
    const started = await r.start(value, { include: { workspace: false, previousResult: false }, instruction: undefined });
    const { handoff, session } = (started as { value: RuntimeCommandResults["start_handoff"] }).value;
    expect(handoff.context).toEqual({});
    expect(handoff.instruction).toBeUndefined();
    // No workspace chosen: the target is not given the workspace at all.
    expect(session!.context).toBeUndefined();
    const told = r.codex.lastMessage()!.text;
    expect(told).toContain("Workspace context: not shared for this handoff.");
    expect(told).not.toContain("Implementation Plan");
  });

  it("refuses to send anything the person did not see", async () => {
    const r = await rig();
    const sourceId = await r.source();
    const value = await preview(r, sourceId);
    await didWork(r, sourceId); // the source's result changed after the preview
    expect(await r.start(value)).toMatchObject({ ok: false, error: { code: "context_invalid" } });
    expect(r.codex.calls).not.toContain("createSession");
  });

  it("refuses a project the target agent is not authorized for, before anything starts", async () => {
    const r = await rig();
    const sourceId = await r.source();
    const value = await preview(r, sourceId);
    expect(await r.start(value, { projectId: "p-claude-only" })).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
    expect(await r.start(value, { projectId: "someone-elses" })).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
    expect(r.codex.calls).not.toContain("createSession");
    expect((await r.events(sourceId)).some((event) => event.kind === "handoff_sent")).toBe(false);
  });

  it("cannot hand off into another person's session or workspace", async () => {
    const r = await rig();
    const alices = await r.source();
    const bobs = await r.source(BOB);
    const value = await preview(r, alices);
    // Bob replays Alice's preview: the source is not his.
    expect(await r.start(value, {}, BOB)).toMatchObject({ ok: false, error: { code: "ownership_denied" } });
    // Alice names Bob's session as the source.
    expect(await r.start({ ...value, sourceSessionId: bobs })).toMatchObject({ ok: false, error: { code: "ownership_denied" } });
    // Alice sends another workspace's snapshot with her own source.
    expect(await r.start(value, { contextSnapshot: PRIVATE as never })).toMatchObject({ ok: false, error: { code: "context_invalid" } });
  });

  it("grants nothing: the target gets its project's permissions, and writes still ask", async () => {
    const r = await rig();
    await r.authorize(ALICE, ["read_workspace", "read_project"]);
    const created = await r.send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w-dev", contextSnapshot: DEVELOPMENT });
    const sourceId = (created as { value: RuntimeSessionView }).value.sessionId;
    const value = await preview(r, sourceId);
    const started = await r.start(value);
    const session = (started as { value: RuntimeCommandResults["start_handoff"] }).value.session!;
    // A read-only project gives a read-only workspace, whatever the source had or the handoff said.
    expect(session.context?.capabilities).not.toContain("collections.write");
    expect(r.registry.binding(session.sessionId)?.access).toBe("read");
  });

  it("an adapter cannot raise a handoff, or claim to have received one", async () => {
    const r = await rig();
    const sourceId = await r.source();
    r.claude.emit({ sessionId: sourceId, kind: "handoff_sent", handoff: { handoffId: "fake", workspaceId: "w-dev", peerProvider: "gemini", outcome: "ready" } });
    r.claude.emit({ sessionId: sourceId, kind: "message_sent", text: "x", handoff: { handoffId: "fake", workspaceId: "w-dev", peerProvider: "gemini" } });
    expect((await r.events(sourceId)).some((event) => event.handoff !== undefined)).toBe(false);
  });

  it("hands no credential, header, token or transcript to anyone", async () => {
    const r = await rig();
    const sourceId = await r.source();
    r.claude.emit({ sessionId: sourceId, kind: "message_received", text: "PRIVATE-REASONING: secret plan", messageId: "m1" });
    r.claude.emit({ sessionId: sourceId, kind: "run_completed" });
    const value = await preview(r, sourceId);
    const started = await r.start(value, { instruction: "Use key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX please" });
    const reply = JSON.stringify(started);
    const told = r.codex.lastMessage()!.text;
    const targetId = (started as { value: RuntimeCommandResults["start_handoff"] }).value.session!.sessionId;
    // The target is bound to its workspace — and its credential reached no reply, no message and no event.
    expect(r.registry.binding(targetId)?.workspaceId).toBe("w-dev");
    for (const text of [reply, told, JSON.stringify(await r.events(targetId))]) {
      expect(text).not.toContain("PRIVATE-REASONING");
      expect(text).not.toContain("sk-ant-api03");
      expect(text).not.toMatch(/authorization|bearer|127\.0\.0\.1/i);
    }
    expect(told).toContain("[redacted]");
  });
});

describe("when a handoff fails", () => {
  it("cannot start the target: nothing is created, the source is untouched, and the failure is said and kept", async () => {
    const store = createMemoryAgentHistoryStore();
    const r = await rig({ targetCreate: { ok: false, error: { code: "unreachable", message: "no agent" } } as never, store });
    const sourceId = await r.source();
    await didWork(r, sourceId);
    const started = await r.start(await preview(r, sourceId));
    expect(started.ok).toBe(true);
    const { handoff, session, error } = (started as { value: RuntimeCommandResults["start_handoff"] }).value;
    expect(handoff).toMatchObject({ status: "failed", failure: "session_not_created" });
    expect(handoff.targetSessionId).toBeUndefined();
    expect(session).toBeUndefined();
    expect(error?.code).toBe("provider_error");
    // No second session exists anywhere.
    const list = await r.send({ name: "list_sessions" });
    expect(list.ok && list.value.sessions.map((entry) => entry.sessionId)).toEqual([sourceId]);
    // The source says so, and stays ready to retry.
    const sent = (await r.events(sourceId)).filter((event) => event.kind === "handoff_sent");
    expect(sent.map((event) => event.handoff)).toEqual([expect.objectContaining({ outcome: "failed", failure: "session_not_created" })]);
    const view = await r.send({ name: "get_session", sessionId: sourceId });
    expect(view.ok && view.value.session.status).toBe("ready");
    // History keeps the failure — never a success.
    const detail = await store.readSession(ALICE.id, "w-dev", sourceId);
    expect(detail?.records.handoffs).toEqual([expect.objectContaining({ status: "failed", failure: "session_not_created" })]);
    // A retry is simply another handoff.
    expect((await r.prepare(sourceId)).ok).toBe(true);
  });

  it("cannot deliver it: the session exists, but it is not said to have received anything", async () => {
    const r = await rig({ targetSendFails: true });
    const sourceId = await r.source();
    const started = await r.start(await preview(r, sourceId));
    const { handoff, session, error } = (started as { value: RuntimeCommandResults["start_handoff"] }).value;
    expect(handoff).toMatchObject({ status: "failed", failure: "context_not_delivered" });
    expect(session?.sessionId).toBe(handoff.targetSessionId);
    expect(error).toBeDefined();
    const target = await r.events(session!.sessionId);
    expect(target.some((event) => event.kind === "handoff_received" || event.kind === "message_sent")).toBe(false);
    expect((await r.events(sourceId)).find((event) => event.kind === "handoff_sent")?.handoff).toMatchObject({
      outcome: "failed",
      failure: "context_not_delivered",
      peerSessionId: session!.sessionId,
    });
    // The target is not shown as having been handed anything.
    expect(session!.handoff).toBeUndefined();
  });
});

describe("activity and history", () => {
  it("each session's timeline says its half, the inspector tells the handoff, and history keeps the relationship", async () => {
    const store = createMemoryAgentHistoryStore();
    const r = await rig({ store });
    const sourceId = await r.source();
    await didWork(r, sourceId);
    const started = await r.start(await preview(r, sourceId));
    const { handoff, session } = (started as { value: RuntimeCommandResults["start_handoff"] }).value;
    const targetId = session!.sessionId;

    const timelineOf = async (sessionId: string, agentName: string) => {
      const view = await r.send({ name: "get_session", sessionId });
      if (!view.ok) throw new Error("no session");
      const events = await r.events(sessionId);
      const entries = buildAgentActivityTimeline({ session: view.value.session, events, handoffs: view.value.handoffs ?? [], agentName, now: T0 + 10_000 });
      return { entries, view: view.value, events };
    };

    const source = await timelineOf(sourceId, "Claude Code");
    const sentEntry = source.entries.find((entry) => entry.kind === "handoff_sent")!;
    expect(sentEntry).toMatchObject({
      title: "Handed off to Codex",
      description: "Workspace context · Previous result · Your instruction",
      action: { kind: "open_session", sessionId: targetId, provider: "openai-codex" },
    });

    const target = await timelineOf(targetId, "Codex");
    expect(target.entries.map((entry) => entry.title).slice(0, 3)).toEqual(["Codex session started", "Handoff received", "Workspace context loaded"]);
    // The delivering message is the handoff, not "You sent a message".
    expect(target.entries.some((entry) => entry.kind === "message_sent")).toBe(false);

    const inspection = inspectActivityEntry(sentEntry.id, {
      entries: source.entries,
      session: source.view.session,
      events: source.events,
      handoffs: source.view.handoffs ?? [],
      agentName: "Claude Code",
      workspaceName: "Development",
    })!;
    expect(inspection).toMatchObject({
      title: "Handed off to Codex",
      status: "completed",
      action: "Handoff",
      handoff: {
        direction: "sent",
        from: { provider: "claude-code", name: "Claude Code" },
        to: { provider: "openai-codex", name: "Codex" },
        workspaceName: "Development",
        context: ["3 tabs · 1 collection"],
        instruction: "Implement the plan from the previous agent.",
        peer: { sessionId: targetId, provider: "openai-codex" },
      },
      undo: { kind: "unavailable" },
    });
    expect(inspection.handoff!.previousResult![0]).toBe("Finished");
    expect(inspection.handoff!.previousResult).toEqual(
      expect.arrayContaining(["Created plan.md · docs/plan.md", "Created collection “Implementation Plan” · 2 tabs"])
    );

    // History: both sessions, linked by the record, and the handoff itself.
    const page = (await r.send({ name: "list_history", workspaceId: "w-dev" })) as { value: AgentHistoryPage };
    const byId = new Map(page.value.sessions.map((entry) => [entry.sessionId, entry]));
    expect(byId.get(sourceId)?.handoff?.to).toEqual([{ handoffId: handoff.handoffId, sessionId: targetId, provider: "openai-codex", status: "ready" }]);
    expect(byId.get(targetId)?.handoff?.from).toEqual({ handoffId: handoff.handoffId, sessionId: sourceId, provider: "claude-code", status: "ready" });
    const detail = (await r.send({ name: "get_history", workspaceId: "w-dev", sessionId: targetId })) as { value: AgentHistoryDetail };
    expect(detail.value.records.handoffs).toEqual([expect.objectContaining({ handoffId: handoff.handoffId, instruction: "Implement the plan from the previous agent." })]);
    expect(detail.value.records.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["handoff_received", "context_loaded"]));
    // What history kept of the delivering message: that it was sent — never what it said.
    const delivered = detail.value.records.events.find((event) => event.kind === "message_sent");
    expect(delivered?.text).toBeUndefined();
    expect(delivered?.handoff?.handoffId).toBe(handoff.handoffId);
    // Another account's history has none of it.
    expect(((await r.send({ name: "list_history", workspaceId: "w-dev" }, BOB)) as { value: AgentHistoryPage }).value.sessions).toEqual([]);
  });

  it("supports a chain, each step its own handoff", async () => {
    const r = await rig();
    const first = await r.source();
    const one = (await r.start(await preview(r, first))) as { value: RuntimeCommandResults["start_handoff"] };
    const codexId = one.value.session!.sessionId;
    r.codex.emit({ sessionId: codexId, kind: "run_completed" });
    // Codex → Claude Code, chosen by the person again.
    const back = await r.prepare(codexId, "claude-code");
    expect(back.ok).toBe(true);
    const two = (await r.start((back as { value: RuntimeHandoffPreview }).value, { projectId: "p1" })) as { value: RuntimeCommandResults["start_handoff"] };
    expect(two.value.handoff.status).toBe("ready");
    const middle = await r.send({ name: "get_session", sessionId: codexId });
    expect(middle.ok && middle.value.session.handoff).toEqual({
      from: expect.objectContaining({ sessionId: first, provider: "claude-code" }),
      to: [expect.objectContaining({ sessionId: two.value.session!.sessionId, provider: "claude-code" })],
    });
  });
});

describe("the project in a handoff (Hubble 1.6)", () => {
  it("is described to the target under the target's own permissions, never the source's", async () => {
    // The target can read files and nothing else; the project's grant allows reading too.
    const r = await rig({ targetCapabilities: capabilitySet("message", "create_session", "stream_events", "read_files", "approvals", "workspace_context") });
    const sourceId = await r.source();
    await didWork(r, sourceId);
    const started = await r.start(await preview(r, sourceId));
    expect(started.ok).toBe(true);

    const told = r.codex.lastMessage()!;
    const project = told.context.attachments.find((attachment) => attachment.kind === "project");
    expect(project).toMatchObject({ kind: "project", id: "p1", label: "Dev" });
    expect(project!.detail).toContain("You may read files");
    expect(project!.detail).not.toMatch(/modify files|run commands/);
    // The file the source wrote travels as a project-relative name, not a path on this machine.
    expect(told.context.attachments).toContainEqual({ kind: "file", id: "docs/plan.md", label: "docs/plan.md", detail: "created by earlier work" });
    expect(JSON.stringify(told)).not.toContain("C:/work");
  });

  it("is refused for a target agent the project was not authorized for", async () => {
    const r = await rig();
    const sourceId = await r.source();
    await didWork(r, sourceId);
    const refused = await r.start(await preview(r, sourceId), { projectId: "p-claude-only" });
    expect(refused).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
  });

  it("cannot point a session at another project through attached context", async () => {
    const r = await rig();
    const sourceId = await r.source();
    const pointed = await r.send({
      name: "attach_context",
      sessionId: sourceId,
      context: { snapshotId: "snap", capturedAt: T0, attachments: [{ kind: "project", id: "p-claude-only", label: "Claude only" }] },
    });
    expect(pointed).toMatchObject({ ok: false, error: { code: "context_invalid" } });
    const own = await r.send({
      name: "attach_context",
      sessionId: sourceId,
      context: { snapshotId: "snap", capturedAt: T0, attachments: [{ kind: "project", id: "p1", label: "Dev" }, { kind: "file", id: "src/a.ts", label: "src/a.ts" }] },
    });
    expect(own.ok).toBe(true);
  });
});
