import { beforeEach, describe, expect, it } from "vitest";
import { capabilitySet } from "@/lib/agents/control/capabilities";
import { createRuntimeHost, LOCAL_ACTOR } from "./host";
import { createScriptedAdapter } from "./__fixtures__/adapter";
import type { AgentControlAdapter } from "@/lib/agents/control/types";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor } from "./host";
import type { AuthorizedProjectInput, RuntimeCommand } from "./protocol";
import type { ScriptedAdapter } from "./__fixtures__/adapter";

const T0 = 1_700_000_000_000;

const ALLOWED: ExecutionGateResult = {
  allowed: true,
  kind: "local",
  decision: { allowed: true, kind: "local-server" },
};

const REFUSED: ExecutionGateResult = {
  allowed: false,
  kind: "hosted",
  decision: { allowed: false, kind: "hosted", reason: "hosted-platform" },
  detail: "Agents cannot run on a hosted TabDump deployment.",
};

const ALICE: RuntimeActor = { id: "account:alice" };
const BOB: RuntimeActor = { id: "account:bob" };

function project(over: Partial<AuthorizedProjectInput> = {}): AuthorizedProjectInput {
  return {
    id: "p1",
    name: "Research",
    path: "C:/work/research",
    providers: ["claude-code"],
    additionalDirectories: [],
    permissions: {
      scopes: ["read_project", "write_project", "run_commands"],
      projectId: over.id ?? "p1",
      grantedAt: T0,
    },
    ...over,
  };
}

function build(
  adapter: AgentControlAdapter | undefined,
  gate: ExecutionGateResult = ALLOWED
) {
  let counter = 0;
  return createRuntimeHost({
    gate,
    resolveAdapter: () => adapter,
    providers: ["claude-code"],
    now: () => T0,
    createId: () => `id${++counter}`,
    runtimeId: "runtime-1",
  });
}

let adapter: ScriptedAdapter;

beforeEach(() => {
  adapter = createScriptedAdapter({ now: () => T0 });
});

/** Authorizes a project and starts a session on it, the normal opening sequence. */
async function startSession(
  host: ReturnType<typeof build>,
  actor: RuntimeActor,
  over: Partial<AuthorizedProjectInput> = {}
) {
  const authorized = await host.execute(actor, {
    name: "authorize_projects",
    projects: [project(over)],
  });
  expect(authorized.ok).toBe(true);

  const started = await host.execute(actor, {
    name: "create_session",
    provider: "claude-code",
    projectId: over.id ?? "p1",
  });

  if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
  return started.value;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

describe("a host that may not execute", () => {
  it("still answers get_status, and says it cannot", async () => {
    const host = build(adapter, REFUSED);
    const status = await host.execute(LOCAL_ACTOR, { name: "get_status" });

    expect(status.ok).toBe(true);
    expect(status.ok && status.value).toMatchObject({
      environment: "hosted",
      executable: false,
    });
    // A UI that cannot ask "why not" can only show a blank screen.
    expect(status.ok && status.value.detail).toBeTruthy();
  });

  it("refuses every other command without reaching the adapter", async () => {
    const host = build(adapter, REFUSED);

    const commands: RuntimeCommand[] = [
      { name: "list_sessions" },
      { name: "create_session", provider: "claude-code" },
      { name: "resume_session", provider: "claude-code", providerSessionId: "p" },
      { name: "send_message", sessionId: "s", text: "hi" },
      { name: "cancel_run", sessionId: "s" },
      { name: "respond_to_approval", approvalId: "a", decision: "granted" },
      { name: "authorize_projects", projects: [project()] },
      { name: "dispose_session", sessionId: "s" },
    ];

    for (const command of commands) {
      const result = await host.execute(LOCAL_ACTOR, command as never);
      expect(result).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    }

    expect(adapter.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

describe("project authorization", () => {
  it("revalidates a synced path rather than trusting it", async () => {
    const host = build(adapter);

    const result = await host.execute(ALICE, {
      name: "authorize_projects",
      projects: [
        project(),
        project({ id: "root", path: "C:/" }),
        project({ id: "home", path: "C:/Users/someone" }),
        project({ id: "up", path: "C:/work/../../" }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.accepted).toEqual(["p1"]);
    expect(result.ok && result.value.rejected.map((entry) => entry.id).sort()).toEqual([
      "home",
      "root",
      "up",
    ]);
  });

  it("refuses a session on a project that was never authorized", async () => {
    const host = build(adapter);

    const started = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "never-authorized",
    });

    expect(started).toMatchObject({
      ok: false,
      error: { code: "project_scope_violation" },
    });
    expect(adapter.calls).not.toContain("createSession");
  });

  it("refuses a project another actor authorized", async () => {
    const host = build(adapter);
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });

    const started = await host.execute(BOB, {
      name: "create_session",
      provider: "claude-code",
      projectId: "p1",
    });

    expect(started).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
  });

  it("replaces rather than merges, so a revoked project stops working", async () => {
    const host = build(adapter);
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });
    await host.execute(ALICE, { name: "authorize_projects", projects: [] });

    const started = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "p1",
    });

    expect(started).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
  });

  it("refuses a grant written for a different project", async () => {
    const host = build(adapter);

    const result = await host.execute(ALICE, {
      name: "authorize_projects",
      projects: [
        {
          ...project(),
          permissions: { scopes: ["write_project"], projectId: "somewhere-else", grantedAt: T0 },
        },
      ],
    });

    expect(result.ok && result.value.accepted).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

describe("session lifecycle", () => {
  it("starts a session and reports it as ready with a run in flight", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    expect(view.status).toBe("ready");
    expect(view.projectId).toBe("p1");
    expect(view.runIds).toHaveLength(1);
    expect(view.activeRunId).toBe(view.runIds[0]);
    expect(adapter.calls).toContain("createSession");
  });

  it("refuses everything about a session that does not exist", async () => {
    const host = build(adapter);

    for (const command of [
      { name: "get_session", sessionId: "ghost" },
      { name: "send_message", sessionId: "ghost", text: "hi" },
      { name: "cancel_run", sessionId: "ghost" },
      { name: "detach_context", sessionId: "ghost" },
      { name: "dispose_session", sessionId: "ghost" },
    ] as const) {
      const result = await host.execute(ALICE, command as never);
      expect(result).toMatchObject({ ok: false, error: { code: "session_not_found" } });
    }
  });

  it("refuses a message to a disposed session", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    await host.execute(ALICE, { name: "dispose_session", sessionId: view.sessionId });

    const sent = await host.execute(ALICE, {
      name: "send_message",
      sessionId: view.sessionId,
      text: "hi",
    });

    expect(sent).toMatchObject({ ok: false, error: { code: "session_not_found" } });
  });

  it("refuses a message to a session the provider has failed", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.emit({ sessionId: view.sessionId, kind: "error", summary: "provider died" });

    const sent = await host.execute(ALICE, {
      name: "send_message",
      sessionId: view.sessionId,
      text: "hi",
    });

    expect(sent).toMatchObject({ ok: false, error: { code: "session_not_found" } });
  });

  it("reports a failed create rather than a phantom session", async () => {
    const failing = createScriptedAdapter({
      now: () => T0,
      failCreate: { ok: false, error: { code: "configuration", message: "not signed in" } },
    });
    const host = build(failing);

    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });
    const started = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "p1",
    });

    // The startup path, distinguished from a successful turn: this is an
    // authentication failure reported as one, not a run that produced nothing.
    expect(started).toMatchObject({ ok: false, error: { code: "authentication_required" } });

    const listed = await host.execute(ALICE, { name: "list_sessions" });
    expect(listed.ok && listed.value.sessions).toEqual([]);
  });

  it("refuses a provider it has no adapter for", async () => {
    const host = build(undefined);

    const started = await host.execute(ALICE, {
      name: "create_session",
      provider: "gemini",
    });

    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("refuses a capability the adapter never declared", async () => {
    const limited = createScriptedAdapter({
      now: () => T0,
      capabilities: capabilitySet("create_session"),
    });
    const host = build(limited);

    const started = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
    });
    expect(started.ok).toBe(true);

    const cancelled = await host.execute(ALICE, {
      name: "cancel_run",
      sessionId: started.ok ? started.value.sessionId : "",
    });

    expect(cancelled).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(limited.calls).not.toContain("cancelRun");
  });
});

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

describe("run correlation", () => {
  it("binds the run to the adapter, so its events carry it", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    expect(adapter.boundRun(view.sessionId)).toBe(view.activeRunId);
  });

  it("records the provider's own session id when the stream reveals it", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    // The real sequence: the id is not known when `createSession` resolves.
    expect(host.correlations.byControlSession(view.sessionId)[0]?.providerSessionId).toBeUndefined();

    adapter.revealProviderSession(view.sessionId, "prov-abc");
    adapter.emit({ sessionId: view.sessionId, kind: "session_started" });

    const record = host.correlations.byControlSession(view.sessionId)[0];
    expect(record?.providerSessionId).toBe("prov-abc");
    expect(record?.controlRunId).toBe(view.activeRunId);
  });

  it("lets observation resolve a control run through the provider session id", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.revealProviderSession(view.sessionId, "prov-abc");
    adapter.emit({ sessionId: view.sessionId, kind: "session_started" });

    // What the observation plane knows: a provider session id off a
    // transcript, and nothing about control.
    expect(host.correlations.controlRunFor("claude-code", "prov-abc")).toBe(view.activeRunId);
  });

  it("starts a new run for the next turn once the previous one ended", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);
    const first = view.activeRunId;

    adapter.emit({ sessionId: view.sessionId, kind: "run_completed" });

    const sent = await host.execute(ALICE, {
      name: "send_message",
      sessionId: view.sessionId,
      text: "next",
    });

    expect(sent.ok).toBe(true);
    expect(sent.ok && sent.value.activeRunId).not.toBe(first);
    expect(sent.ok && sent.value.runIds).toHaveLength(2);
  });

  it("refuses a second turn while one is in flight", async () => {
    // Explicit serialization. One provider process holds one conversation,
    // and two interleaved runs on one event stream could not be untangled.
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.emit({ sessionId: view.sessionId, kind: "message_received" });

    const second = await host.execute(ALICE, {
      name: "send_message",
      sessionId: view.sessionId,
      text: "again",
    });

    expect(second).toMatchObject({ ok: false, error: { code: "invalid_session_state" } });
  });

  it("links an observed run without inventing one", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    const linked = await host.execute(ALICE, {
      name: "link_observation",
      sessionId: view.sessionId,
      observationAgentId: "agent-1",
      observationRunId: "run-7",
    });

    expect(linked.ok && linked.value).toMatchObject({
      observationAgentId: "agent-1",
      observationRunId: "run-7",
      controlRunId: view.activeRunId,
      origin: "control",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

describe("events", () => {
  it("sequences events and serves them from a cursor", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.emit({ sessionId: view.sessionId, kind: "thinking" });
    adapter.emit({ sessionId: view.sessionId, kind: "message_received" });

    const all = await host.execute(ALICE, { name: "get_events", sessionId: view.sessionId });
    expect(all.ok && all.value.events.map((event) => event.sequence)).toEqual([1, 2]);

    const after = await host.execute(ALICE, {
      name: "get_events",
      sessionId: view.sessionId,
      afterSequence: 1,
    });
    expect(after.ok && after.value.events).toHaveLength(1);
  });

  it("drops a replayed event before any subscriber sees it", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    const seen: number[] = [];
    host.subscribe((event) => seen.push(event.sequence));

    adapter.emit({ id: "dup", sessionId: view.sessionId, kind: "run_completed" });
    adapter.emit({ id: "dup", sessionId: view.sessionId, kind: "run_completed" });

    expect(seen).toEqual([1]);
  });

  it("drops a malformed event at the boundary", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    // A file event whose path escapes the project. The control service
    // refuses it before the journal ever sees it.
    adapter.emit({
      sessionId: view.sessionId,
      kind: "file_modified",
      file: { relativePath: "../../etc/passwd", projectId: "p1" },
    });

    const events = await host.execute(ALICE, { name: "get_events", sessionId: view.sessionId });
    expect(events.ok && events.value.events).toEqual([]);
  });

  it("forgets a disposed session's events", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);
    adapter.emit({ sessionId: view.sessionId, kind: "thinking" });

    await host.execute(ALICE, { name: "dispose_session", sessionId: view.sessionId });

    expect(host.journal.read(view.sessionId).events).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Ownership
 * ------------------------------------------------------------------ */

describe("ownership", () => {
  it("refuses another account's session by id", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    for (const command of [
      { name: "get_session", sessionId: view.sessionId },
      { name: "get_events", sessionId: view.sessionId },
      { name: "send_message", sessionId: view.sessionId, text: "hi" },
      { name: "cancel_run", sessionId: view.sessionId },
      { name: "detach_context", sessionId: view.sessionId },
      { name: "dispose_session", sessionId: view.sessionId },
      {
        name: "link_observation",
        sessionId: view.sessionId,
        observationAgentId: "a",
        observationRunId: "r",
      },
    ] as const) {
      const result = await host.execute(BOB, command as never);
      expect(result).toMatchObject({ ok: false, error: { code: "ownership_denied" } });
    }
  });

  it("hides another account's sessions from a listing", async () => {
    const host = build(adapter);
    await startSession(host, ALICE);

    const listed = await host.execute(BOB, { name: "list_sessions" });
    expect(listed.ok && listed.value.sessions).toEqual([]);
  });

  it("does not let an approval id alone reach another account's session", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.stageApproval("ap1", {
      sessionId: view.sessionId,
      action: "modify_files",
      scope: "write_project",
      projectId: "p1",
      targets: ["src/index.ts"],
    });
    adapter.emit({
      sessionId: view.sessionId,
      kind: "approval_requested",
      approvalId: "ap1",
      summary: "wants to modify files",
    });

    const answered = await host.execute(BOB, {
      name: "respond_to_approval",
      approvalId: "ap1",
      decision: "granted",
    });

    // `invalid_request`, not `ownership_denied`, and the difference is the
    // point: Bob's commands resolve against Bob's own control service, which
    // holds no record of this approval at all. There is no lookup that finds
    // it and then refuses — it is not reachable, so he cannot distinguish
    // "not yours" from "never existed".
    expect(answered).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(adapter.answered("ap1")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

describe("approvals", () => {
  it("mints a broker record from the adapter's detail, and blocks the session", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.stageApproval("ap1", {
      sessionId: view.sessionId,
      action: "modify_files",
      scope: "write_project",
      projectId: "p1",
      targets: ["src/index.ts"],
      reason: "Updating the export",
    });
    adapter.emit({
      sessionId: view.sessionId,
      kind: "approval_requested",
      approvalId: "ap1",
      summary: "wants to modify files",
    });

    const session = await host.execute(ALICE, { name: "get_session", sessionId: view.sessionId });
    expect(session.ok && session.value.session.status).toBe("waiting_for_approval");
    expect(session.ok && session.value.session.awaitingApproval).toBe(true);
    expect(session.ok && session.value.approvals[0]).toMatchObject({
      approvalId: "ap1",
      action: "modify_files",
      targets: ["src/index.ts"],
    });
  });

  it("carries a denial back to the provider", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.stageApproval("ap1", {
      sessionId: view.sessionId,
      action: "run_command",
      scope: "run_commands",
      projectId: "p1",
      targets: ["Bash"],
    });
    adapter.emit({ sessionId: view.sessionId, kind: "approval_requested", approvalId: "ap1" });

    const answered = await host.execute(ALICE, {
      name: "respond_to_approval",
      approvalId: "ap1",
      decision: "denied",
    });

    expect(answered.ok).toBe(true);
    expect(adapter.answered("ap1")).toBe("denied");
  });

  it("does not answer a replayed request on the user's behalf", async () => {
    // An adapter reconnecting to a provider stream can re-emit the request it
    // raised a moment ago. The first record is still live and still on screen;
    // answering the replay would resolve a decision nobody made.
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.stageApproval("ap1", {
      sessionId: view.sessionId,
      action: "run_command",
      scope: "run_commands",
      projectId: "p1",
      targets: ["Bash"],
    });

    adapter.emit({ id: "ev1", sessionId: view.sessionId, kind: "approval_requested", approvalId: "ap1" });
    adapter.emit({ id: "ev2", sessionId: view.sessionId, kind: "approval_requested", approvalId: "ap1" });

    expect(adapter.answered("ap1")).toBeUndefined();

    const session = await host.execute(ALICE, { name: "get_session", sessionId: view.sessionId });
    expect(session.ok && session.value.approvals).toHaveLength(1);
  });

  it("refuses an approval id that names nothing", async () => {
    const host = build(adapter);
    await startSession(host, ALICE);

    const answered = await host.execute(ALICE, {
      name: "respond_to_approval",
      approvalId: "never-existed",
      decision: "granted",
    });

    expect(answered).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("will not talk over a session waiting on a decision", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.stageApproval("ap1", {
      sessionId: view.sessionId,
      action: "modify_files",
      scope: "write_project",
      projectId: "p1",
      targets: ["src/index.ts"],
    });
    adapter.emit({ sessionId: view.sessionId, kind: "approval_requested", approvalId: "ap1" });

    const sent = await host.execute(ALICE, {
      name: "send_message",
      sessionId: view.sessionId,
      text: "never mind",
    });

    expect(sent).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });
});

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

describe("context", () => {
  const CONTEXT = {
    snapshotId: "snap-1",
    capturedAt: T0,
    attachments: [
      { kind: "tab" as const, id: "t1", label: "A tab", detail: "example.com" },
    ],
  };

  it("attaches a snapshot without touching what the session may do", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    const attached = await host.execute(ALICE, {
      name: "attach_context",
      sessionId: view.sessionId,
      context: CONTEXT,
    });

    expect(attached.ok && attached.value.contextSnapshotId).toBe("snap-1");
    // Context is not permission and not project scope. Nothing about either
    // moved, and the status did not change either — attaching is not a
    // lifecycle event.
    expect(attached.ok && attached.value.projectId).toBe("p1");
    expect(attached.ok && attached.value.status).toBe(view.status);
  });

  it("refuses a malformed snapshot rather than dropping it silently", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    const attached = await host.execute(ALICE, {
      name: "attach_context",
      sessionId: view.sessionId,
      context: { snapshotId: "snap-2", capturedAt: T0, attachments: [{ bad: true }] as never },
    });

    expect(attached).toMatchObject({ ok: false, error: { code: "context_invalid" } });
  });

  it("carries a mid-session attachment into the next message", async () => {
    // The control plane stores what a session holds and deliberately does not
    // deliver it — attaching dispatches nothing. Something has to say it, and
    // this is the layer that knows both the attachment and the message.
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    await host.execute(ALICE, {
      name: "attach_context",
      sessionId: view.sessionId,
      context: CONTEXT,
    });

    adapter.emit({ sessionId: view.sessionId, kind: "run_completed" });
    const sent = await host.execute(ALICE, {
      name: "send_message",
      sessionId: view.sessionId,
      text: "what do you see?",
    });

    expect(sent.ok).toBe(true);
    expect(adapter.lastMessage()?.context.attachments).toEqual(CONTEXT.attachments);
  });

  it("states a snapshot once rather than on every turn", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    await host.execute(ALICE, {
      name: "attach_context",
      sessionId: view.sessionId,
      context: CONTEXT,
    });

    adapter.emit({ sessionId: view.sessionId, kind: "run_completed" });
    await host.execute(ALICE, { name: "send_message", sessionId: view.sessionId, text: "one" });
    adapter.emit({ sessionId: view.sessionId, kind: "run_completed" });
    await host.execute(ALICE, { name: "send_message", sessionId: view.sessionId, text: "two" });

    // Restating it would grow the conversation without adding to it, and would
    // make a later refresh ambiguous about which version the model is using.
    expect(adapter.lastMessage()?.context.attachments).toEqual([]);
  });

  it("never says a snapshot that was detached before it was delivered", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    await host.execute(ALICE, {
      name: "attach_context",
      sessionId: view.sessionId,
      context: CONTEXT,
    });
    await host.execute(ALICE, { name: "detach_context", sessionId: view.sessionId });

    adapter.emit({ sessionId: view.sessionId, kind: "run_completed" });
    await host.execute(ALICE, { name: "send_message", sessionId: view.sessionId, text: "hi" });

    expect(adapter.lastMessage()?.context.attachments).toEqual([]);
  });

  it("detaches without ending the session", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    await host.execute(ALICE, {
      name: "attach_context",
      sessionId: view.sessionId,
      context: CONTEXT,
    });
    const detached = await host.execute(ALICE, {
      name: "detach_context",
      sessionId: view.sessionId,
    });

    expect(detached.ok && detached.value.contextSnapshotId).toBeUndefined();
    expect(detached.ok && detached.value.status).toBe("ready");
  });

  it("does not let context authorize a project", async () => {
    // A session with no project at all, given a snapshot that names one.
    const host = build(adapter);
    await host.execute(ALICE, { name: "authorize_projects", projects: [project()] });

    const started = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      context: {
        snapshotId: "snap-3",
        capturedAt: T0,
        attachments: [{ kind: "project", id: "p1", label: "Research" }],
      },
    });

    expect(started.ok && started.value.projectId).toBeUndefined();
    expect(started.ok && started.value.contextSnapshotId).toBe("snap-3");
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation and cleanup
 * ------------------------------------------------------------------ */

describe("cancellation", () => {
  it("reaches the provider rather than marking a status", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    expect(adapter.live()).toEqual([view.sessionId]);

    const cancelled = await host.execute(ALICE, {
      name: "cancel_run",
      sessionId: view.sessionId,
    });

    expect(cancelled.ok && cancelled.value.status).toBe("cancelled");
    // The fixture drops the session when it is interrupted, exactly as a real
    // adapter releases the provider handle. A cancel that only changed a
    // status here would leave it live.
    expect(adapter.live()).toEqual([]);
  });

  it("clears the active run so a cancelled session is not seen as busy", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    const cancelled = await host.execute(ALICE, {
      name: "cancel_run",
      sessionId: view.sessionId,
    });

    expect(cancelled.ok && cancelled.value.activeRunId).toBeUndefined();
  });
});

describe("cleanup", () => {
  it("cancels a live session before forgetting it", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    await host.execute(ALICE, { name: "dispose_session", sessionId: view.sessionId });

    expect(adapter.calls).toContain("cancelRun");
    expect(adapter.live()).toEqual([]);
  });

  it("leaves no provider session behind on disposal", async () => {
    const host = build(adapter);
    await startSession(host, ALICE, { id: "p1" });
    await startSession(host, BOB, { id: "p1" });

    await host.dispose();

    expect(adapter.live()).toEqual([]);
    expect(host.correlations.size()).toBe(0);
  });

  it("does not try to cancel a session the provider already ended", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.emit({ sessionId: view.sessionId, kind: "error" });
    const before = adapter.calls.filter((call) => call === "cancelRun").length;

    await host.execute(ALICE, { name: "dispose_session", sessionId: view.sessionId });

    expect(adapter.calls.filter((call) => call === "cancelRun")).toHaveLength(before);
  });
});

/* ------------------------------------------------------------------ *
 * Isolation
 * ------------------------------------------------------------------ */

describe("multi-session isolation", () => {
  it("keeps two sessions' runs, events and correlations apart", async () => {
    const host = build(adapter);

    const a = await startSession(host, ALICE, { id: "p1", path: "C:/work/alpha" });
    const b = await startSession(host, ALICE, { id: "p1", path: "C:/work/beta" });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.activeRunId).not.toBe(b.activeRunId);

    adapter.revealProviderSession(a.sessionId, "prov-a");
    adapter.revealProviderSession(b.sessionId, "prov-b");
    adapter.emit({ sessionId: a.sessionId, kind: "thinking" });
    adapter.emit({ sessionId: b.sessionId, kind: "thinking" });
    adapter.emit({ sessionId: b.sessionId, kind: "message_received" });

    const eventsA = await host.execute(ALICE, { name: "get_events", sessionId: a.sessionId });
    const eventsB = await host.execute(ALICE, { name: "get_events", sessionId: b.sessionId });

    expect(eventsA.ok && eventsA.value.events).toHaveLength(1);
    expect(eventsB.ok && eventsB.value.events).toHaveLength(2);
    expect(eventsA.ok && eventsA.value.events.every((e) => e.sessionId === a.sessionId)).toBe(true);

    expect(host.correlations.controlRunFor("claude-code", "prov-a")).toBe(a.activeRunId);
    expect(host.correlations.controlRunFor("claude-code", "prov-b")).toBe(b.activeRunId);
  });

  it("keeps two accounts' approvals apart", async () => {
    const host = build(adapter);
    const a = await startSession(host, ALICE);
    const b = await startSession(host, BOB);

    adapter.stageApproval("ap-a", {
      sessionId: a.sessionId,
      action: "modify_files",
      scope: "write_project",
      projectId: "p1",
      targets: ["a.ts"],
    });
    adapter.emit({ sessionId: a.sessionId, kind: "approval_requested", approvalId: "ap-a" });

    const bobsView = await host.execute(BOB, { name: "get_session", sessionId: b.sessionId });
    expect(bobsView.ok && bobsView.value.approvals).toEqual([]);
    expect(bobsView.ok && bobsView.value.session.awaitingApproval).toBe(false);
  });

  it("does not let one session's cancellation touch another", async () => {
    const host = build(adapter);
    const a = await startSession(host, ALICE, { id: "p1", path: "C:/work/alpha" });
    const b = await startSession(host, ALICE, { id: "p1", path: "C:/work/beta" });

    await host.execute(ALICE, { name: "cancel_run", sessionId: a.sessionId });

    const still = await host.execute(ALICE, { name: "get_session", sessionId: b.sessionId });
    expect(still.ok && still.value.session.status).toBe("ready");
    expect(adapter.live()).toEqual([b.sessionId]);
  });
});

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

describe("runtime status", () => {
  it("reports availability, authentication and capability as three facts", async () => {
    const host = build(adapter);
    const status = await host.execute(ALICE, { name: "get_status" });

    const provider = status.ok ? status.value.providers[0] : undefined;
    expect(provider?.available).toBe(true);
    // An adapter that connected has not thereby proved anybody is signed in.
    expect(provider?.authentication).toBe("unknown");
    expect(provider?.capabilities).toContain("write_files");
  });

  it("reports a provider with no adapter as unavailable rather than absent", async () => {
    const host = build(undefined);
    const status = await host.execute(ALICE, { name: "get_status" });

    expect(status.ok && status.value.providers[0]).toMatchObject({
      provider: "claude-code",
      available: false,
      connection: "unavailable",
      capabilities: [],
    });
  });

  it("keeps a stable runtime identity for the life of the process", async () => {
    const host = build(adapter);
    const first = await host.execute(ALICE, { name: "get_status" });
    const second = await host.execute(ALICE, { name: "get_status" });

    expect(first.ok && first.value.runtimeId).toBe(host.runtimeId);
    expect(second.ok && second.value.runtimeId).toBe(host.runtimeId);
  });
});

/* ------------------------------------------------------------------ *
 * Reconnect
 * ------------------------------------------------------------------ */

describe("reconnect and resume", () => {
  it("survives a client disconnect without ending the provider session", async () => {
    // A browser refresh is not a signal to kill anything. Nothing in the host
    // is tied to a client's lifetime.
    const host = build(adapter);
    const view = await startSession(host, ALICE);
    adapter.emit({ sessionId: view.sessionId, kind: "thinking" });

    // The "reconnect": a fresh listing, as a reloaded page would make.
    const listed = await host.execute(ALICE, { name: "list_sessions" });

    expect(listed.ok && listed.value.sessions).toHaveLength(1);
    expect(listed.ok && listed.value.sessions[0].status).toBe("running");
    expect(adapter.live()).toEqual([view.sessionId]);
  });

  it("gives a reconnecting client everything after its cursor and no more", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    adapter.emit({ sessionId: view.sessionId, kind: "thinking" });
    const seen = await host.execute(ALICE, { name: "get_events", sessionId: view.sessionId });
    const cursor = seen.ok ? seen.value.latestSequence : 0;

    adapter.emit({ sessionId: view.sessionId, kind: "message_received" });

    const caught = await host.execute(ALICE, {
      name: "get_events",
      sessionId: view.sessionId,
      afterSequence: cursor,
    });

    expect(caught.ok && caught.value.events.map((e) => e.kind)).toEqual(["message_received"]);
  });

  it("reports a session as resumable only when both halves are true", async () => {
    const host = build(adapter);
    const view = await startSession(host, ALICE);

    // No provider session id yet, so nothing to resume, whatever the adapter
    // can do.
    expect(view.resumable).toBe(false);

    adapter.revealProviderSession(view.sessionId, "prov-abc");
    adapter.emit({ sessionId: view.sessionId, kind: "session_started" });

    const after = await host.execute(ALICE, { name: "get_session", sessionId: view.sessionId });
    expect(after.ok && after.value.session.resumable).toBe(true);
  });

  it("does not claim resumability an adapter cannot deliver", async () => {
    const limited = createScriptedAdapter({
      now: () => T0,
      capabilities: capabilitySet("create_session", "message"),
      providerSessionIdOnCreate: "prov-abc",
    });
    const host = build(limited);

    const started = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
    });

    expect(started.ok && started.value.providerSessionId).toBe("prov-abc");
    expect(started.ok && started.value.resumable).toBe(false);
  });

  it("resumes into a new control session carrying the same provider id", async () => {
    const host = build(adapter);

    const resumed = await host.execute(ALICE, {
      name: "resume_session",
      provider: "claude-code",
      providerSessionId: "prov-abc",
    });

    expect(resumed.ok && resumed.value.providerSessionId).toBe("prov-abc");
    expect(resumed.ok && resumed.value.runIds).toHaveLength(1);
    expect(host.correlations.controlRunFor("claude-code", "prov-abc")).toBe(
      resumed.ok ? resumed.value.activeRunId : undefined
    );
  });
});
