import { expect } from "vitest";
import { readHistoryDetail, readHistoryPage, reconstructHistorySession } from "@/lib/agents/activity/history";
import { inspectActivityEntry } from "@/lib/agents/activity/inspector";
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline";
import { RESEARCH, SOURCES, approveAndApply, startRuntime, until } from "./history-rig";
import type { AgentHistoryStore } from "@/lib/agents/activity/history-store";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { Collection } from "@/lib/collections/types";
import type { SessionContextServer } from "@/lib/agents/session-context/http";
import type { RuntimeCommandResults, RuntimeHandoffPreview } from "../protocol";

/**
 * The definition of done for an explicit handoff, as one journey through two
 * real runtimes sharing nothing but a history store:
 *
 *     Gemini works in Research → an approved change is applied → its turn ends
 *       → the person continues with Grok → Grok is told, structured
 *       → Grok reads the workspace and asks to change it → approval → applied
 *       → the person undoes it → the runtime restarts
 *       → history still shows Gemini → Grok, both timelines and the inspector work
 *
 * The real host, control service, approval broker, session registry,
 * loopback MCP server and ACP adapters, with scripted ACP agents speaking the
 * real wire — every event is something an agent or the person did.
 */

type Reply<T> = { ok: boolean; value?: T; error?: { code: string } };

export async function runHandoffScenario(options: {
  /** The store the first runtime writes. */
  store: AgentHistoryStore;
  /** The store the restarted runtime reads — the same database through a new connection, or the same memory. */
  storeAfterRestart: () => Promise<AgentHistoryStore> | AgentHistoryStore;
  servers: SessionContextServer[];
  /**
   * How each agent's context calls are proven — the launch allowlist's entry,
   * passed in by the test so this support module does not import the launch
   * layer (launch/security.test.ts), exactly as history-rig.ts takes it.
   */
  contextIdentity: Parameters<typeof startRuntime>[0]["contextIdentity"];
}) {
  const providers: AgentProviderId[] = ["gemini", "grok"];
  const first = await startRuntime({ store: options.store, runtimeId: "rt-1", providers, servers: options.servers, contextIdentity: options.contextIdentity });

  /* ---------------- Agent A works, and finishes. */

  const geminiId = await first.start("gemini");
  await first.send({ name: "send_message", sessionId: geminiId, text: "Research pricing and group what matters." } as never);
  await until(async () => (await first.snapshotOf(geminiId)).session.status === "running");
  const gemini = await first.agentClient("gemini");
  await approveAndApply(first, geminiId, gemini);
  first.finishTurn();
  await until(async () => (await first.snapshotOf(geminiId)).session.status === "ready");

  /* ---------------- The person continues with Grok. */

  const prepared = await first.send<RuntimeHandoffPreview>({
    name: "prepare_handoff",
    sourceSessionId: geminiId,
    targetProvider: "grok",
    contextSnapshot: RESEARCH,
  } as never);
  expect(prepared.ok).toBe(true);
  const preview = prepared.value!;
  expect(preview.context.previousResult?.lines).toEqual([{ title: "Created collection “Pricing”", description: "2 tabs" }]);
  expect(preview.context.workspace).toEqual({ tabs: 3, collections: 1 });

  const started = await first.send<RuntimeCommandResults["start_handoff"]>({
    name: "start_handoff",
    sourceSessionId: geminiId,
    targetProvider: "grok",
    contextSnapshot: RESEARCH,
    fingerprint: preview.fingerprint,
    include: { workspace: true, previousResult: true },
    instruction: "Turn the Pricing collection into an implementation plan.",
    projectId: "p1",
  } as never);
  expect(started.ok).toBe(true);
  const { handoff, session } = started.value!;
  expect(handoff.status).toBe("ready");
  const grokId = session!.sessionId;

  // What Grok's process actually received: the envelope as its first prompt —
  // and, in session/new, its own context server like any session's.
  const grokAgent = first.agents.get("grok")!;
  const prompts = grokAgent.received.filter((message) => message.method === "session/prompt");
  expect(prompts).toHaveLength(1);
  const told = ((prompts[0]!.params as { prompt: { text: string }[] }).prompt[0]!.text);
  expect(told.split("\n")[0]).toBe("HUBBLE HANDOFF");
  expect(told).toContain("Workspace: Research");
  expect(told).toContain("Previous agent: Gemini CLI");
  expect(told).toContain("- Created collection “Pricing” (2 tabs)");
  expect(told).toContain("Workspace context: 3 tabs · 1 collection");
  expect(told).toContain("Turn the Pricing collection into an implementation plan.");
  // Never Gemini's words, never a credential, never a protocol detail.
  const newSession = grokAgent.received.find((message) => message.method === "session/new")!;
  const grokCredential = (newSession.params as { mcpServers: { headers: { value: string }[] }[] }).mcpServers[0]!.headers[0]!.value;
  const geminiCredential = (first.agents.get("gemini")!.received.find((message) => message.method === "session/new")!.params as {
    mcpServers: { headers: { value: string }[] }[];
  }).mcpServers[0]!.headers[0]!.value;
  for (const secret of ["REPLY-SECRET", grokCredential, geminiCredential, "jsonrpc", "Authorization"]) {
    expect(told).not.toContain(secret);
    expect(JSON.stringify(started)).not.toContain(secret);
  }

  /* ---------------- Grok works in the same workspace, through the normal approval. */

  const grok = await first.agentClient("grok");
  const summary = await grok.callTool({ name: "get_workspace_summary", arguments: {} });
  expect(JSON.stringify(summary)).toContain("Research");
  const proposal = grok.callTool({ name: "create_collection", arguments: { name: "Implementation", tabIds: ["t3"] } });
  let approvalId = "";
  await until(async () => {
    approvalId = (await first.snapshotOf(grokId)).approvals[0]?.approvalId ?? "";
    return Boolean(approvalId);
  });
  // The handoff granted nothing: Grok's write waits on the person like any other.
  expect((await first.snapshotOf(grokId)).session.status).toBe("waiting_for_approval");
  expect((await first.send({ name: "respond_to_approval", approvalId, decision: "granted" } as never)).ok).toBe(true);
  let actionId = "";
  await until(async () => {
    actionId = (await first.snapshotOf(grokId)).session.context?.pendingActions[0]?.actionId ?? "";
    return Boolean(actionId);
  });
  const implementation: Collection = { id: "c-impl", workspaceId: "w-research", name: "Implementation", tabIds: ["t3"], createdAt: 9, updatedAt: 9 };
  const pricing: Collection = { id: "c-new", workspaceId: "w-research", name: "Pricing", tabIds: ["t1", "t2"], createdAt: 5, updatedAt: 5 };
  const before = [SOURCES, pricing];
  const after = [SOURCES, pricing, implementation];
  await first.send({
    name: "record_workspace_change",
    sessionId: grokId,
    change: { id: actionId, at: Date.now(), ok: true, steps: [{ kind: "created", collectionId: "c-impl", name: "Implementation", tabCount: 1 }], before, after },
  } as never);
  await first.send({ name: "complete_context_action", sessionId: grokId, actionId, outcome: { ok: true, collectionId: "c-impl" } } as never);
  await proposal;
  // The person undoes Grok's change — the change, not the handoff.
  expect((await first.send({ name: "record_workspace_undo", workspaceId: "w-research", sessionId: grokId, changeId: actionId, at: Date.now() } as never)).ok).toBe(true);
  first.finishTurn();
  await until(async () => (await first.snapshotOf(grokId)).session.status === "ready");

  // Live: each stream says its half.
  const grokLive = await first.snapshotOf(grokId);
  const kinds = grokLive.events.map((event) => event.kind);
  expect(kinds.indexOf("handoff_received")).toBeLessThan(kinds.indexOf("context_loaded"));
  expect(kinds).toContain("approval_requested");
  expect((await first.snapshotOf(geminiId)).events.filter((event) => event.kind === "handoff_sent")).toHaveLength(1);

  /* ---------------- The runtime goes away, abruptly; another starts. */

  const second = await startRuntime({
    store: await options.storeAfterRestart(),
    runtimeId: "rt-2",
    providers,
    servers: options.servers,
    contextIdentity: options.contextIdentity,
  });
  // Nothing live survived.
  expect(((await second.send<{ sessions: unknown[] }>({ name: "list_sessions" } as never)).value!).sessions).toEqual([]);

  const page = readHistoryPage(JSON.parse(JSON.stringify((await second.send({ name: "list_history", workspaceId: "w-research" } as never)).value)))!;
  const byId = new Map(page.sessions.map((entry) => [entry.sessionId, entry]));
  expect(byId.get(geminiId)?.handoff).toEqual({ to: [{ handoffId: handoff.handoffId, sessionId: grokId, provider: "grok", status: "ready" }] });
  expect(byId.get(grokId)?.handoff).toEqual({ from: { handoffId: handoff.handoffId, sessionId: geminiId, provider: "gemini", status: "ready" } });

  /* ---------------- Either session opens into its timeline and inspector. */

  async function open(sessionId: string, agentName: string) {
    const reply = (await second.send({ name: "get_history", workspaceId: "w-research", sessionId } as never)) as Reply<unknown>;
    expect(reply.ok).toBe(true);
    const history = reconstructHistorySession(readHistoryDetail(JSON.parse(JSON.stringify(reply.value)))!);
    const base = {
      session: history.session,
      events: history.events,
      approvals: [],
      knownApprovals: history.knownApprovals,
      changes: history.changes,
      planOutcomes: history.planOutcomes,
      handoffs: history.handoffs,
      agentName,
      workspaceName: "Research",
    };
    const entries = buildAgentActivityTimeline({ ...base, now: Date.now() });
    return { history, entries, inspect: (entryId: string) => inspectActivityEntry(entryId, { ...base, entries, canUndo: () => true }) };
  }

  const source = await open(geminiId, "Gemini CLI");
  const sent = source.entries.find((entry) => entry.kind === "handoff_sent")!;
  expect(sent).toMatchObject({ title: "Handed off to Grok Build", action: { kind: "open_session", sessionId: grokId } });
  expect(source.inspect(sent.id)).toMatchObject({
    action: "Handoff",
    status: "completed",
    handoff: {
      from: { provider: "gemini" },
      to: { provider: "grok" },
      context: ["3 tabs · 1 collection"],
      previousResult: ["Finished", "Created collection “Pricing” · 2 tabs"],
      instruction: "Turn the Pricing collection into an implementation plan.",
    },
  });

  const target = await open(grokId, "Grok Build");
  const titles = target.entries.map((entry) => entry.title);
  expect(titles.slice(0, 3)).toEqual(["Grok Build connected", "Handoff received", "Workspace context loaded"]);
  // Grok's own action, its approval and its undo — the existing inspector, unchanged.
  const created = target.entries.find((entry) => entry.refs?.changeId === actionId && entry.kind === "created")!;
  expect(created.title).toBe("Created collection “Implementation”");
  expect(target.inspect(created.id)).toMatchObject({ status: "undone", chain: expect.arrayContaining([expect.objectContaining({ key: "decision", label: "Approved" })]) });
  expect(titles).toContain("Undid creation of “Implementation”");
  // The handoff itself was never a workspace change.
  const received = target.entries.find((entry) => entry.kind === "handoff_received")!;
  expect(target.inspect(received.id)?.undo).toMatchObject({ kind: "unavailable" });

  return { first, second, geminiId, grokId, handoff };
}
