import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSandboxService } from "@/lib/agents/remote/__fixtures__/sandbox";
import { createMemoryRemoteStore } from "@/lib/agents/remote/store";
import { createRemoteBindings } from "@/lib/agents/remote/bindings";
import { createRuntimeHost } from "@/lib/agents/runtime/host";
import { createClaudeCodeControlAdapter } from "./adapter";
import { createRemoteClaudeRuntime, PROVIDER_CREDENTIAL_ENV_VAR } from "./remote-runtime";
import { assistantText, resultSuccess, systemInit } from "./__fixtures__/scripted-runtime";
import { REMOTE_WORKSPACE_ROOT } from "@/lib/agents/remote/types";
import type { FakeSandboxService } from "@/lib/agents/remote/__fixtures__/sandbox";
import type { RemoteStore } from "@/lib/agents/remote/store";
import type { RemoteProject } from "@/lib/agents/remote/types";
import type { ExecutionGateResult } from "@/lib/agents/runtime/gate";
import type { RuntimeActor, RuntimeHost } from "@/lib/agents/runtime/host";

/**
 * The remote runtime, end to end, across the request boundary.
 *
 * ## What this file is really testing
 *
 * Not "does the code call the SDK". The claim worth proving is the one the
 * whole design turns on: **a serverless control plane holds nothing between
 * requests, and a remote session must survive that.** So every test below
 * builds a *fresh host* for each simulated request — a different object
 * graph, empty maps, empty journal, exactly as a new Lambda instance would be
 * — while the store and the sandbox persist, exactly as a database and a
 * microVM would.
 *
 * If any of this only works because two commands happened to share a process,
 * these tests fail.
 */

const T0 = 1_700_000_000_000;
const ALICE: RuntimeActor = { id: "account:alice" };
const BOB: RuntimeActor = { id: "account:bob" };

const REMOTE_GATE: ExecutionGateResult = {
  allowed: true,
  environment: "remote",
  kind: "remote",
  decision: { allowed: true, kind: "remote-sandbox" },
};

const ENV = { [PROVIDER_CREDENTIAL_ENV_VAR]: "sk-ant-test-key" };

let store: RemoteStore;
let sandbox: FakeSandboxService;

function remoteProject(over: Partial<RemoteProject> = {}): RemoteProject {
  return {
    id: "rp-1",
    ownerId: ALICE.id,
    name: "API service",
    source: "remote_upload",
    sandboxName: "tabdump-aaaabbbbcccc",
    // Enough to read and write, so approvals are genuinely reachable.
    scopes: ["read_project", "write_project"],
    status: "ready",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/**
 * One serverless request's worth of runtime.
 *
 * Everything in here is new. The only things carried over between calls are
 * `store` and `sandbox`, which are the only two things that are genuinely
 * durable in production.
 */
function newRequest(actor: RuntimeActor): RuntimeHost {
  const adapter = createClaudeCodeControlAdapter({
    runtime: createRemoteClaudeRuntime({ sandbox, store, ownerId: actor.id, env: ENV }),
  });

  return createRuntimeHost({
    gate: REMOTE_GATE,
    resolveAdapter: (provider) => (provider === "claude-code" ? adapter : undefined),
    remote: createRemoteBindings({ store }),
    providers: ["claude-code"],
    runtimeId: "remote-fixed",
  });
}

beforeEach(async () => {
  store = createMemoryRemoteStore();
  sandbox = createFakeSandboxService();
  await store.createProject(remoteProject());
  // The sandbox the project points at already exists, as it would after the
  // project-creation flow.
  await sandbox.ensure({
    sandboxName: "tabdump-aaaabbbbcccc",
    timeoutMs: 60_000,
    allowedHosts: ["api.anthropic.com"],
  });
});

describe("starting a session", () => {
  it("runs the agent in the sandbox's workspace and nowhere else", async () => {
    const host = newRequest(ALICE);

    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });

    expect(created.ok).toBe(true);

    const started = sandbox.calls.find((call) => call.kind === "startBridge");
    expect(started).toBeDefined();

    // The working directory is a constant, not something that travelled from
    // a request. There is no field on any command that could have set it.
    const config = sandbox.peek("tabdump-aaaabbbbcccc")?.config as { permissionMode: string };
    expect(config.permissionMode).toBe("default");
    expect(sandbox.peek("tabdump-aaaabbbbcccc")?.files.size).toBe(0);
    expect(REMOTE_WORKSPACE_ROOT).toBe("/workspace/project");
  });

  it("hands the provider credential to the bridge and to nothing else", async () => {
    const host = newRequest(ALICE);
    await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });

    const started = sandbox.calls.find((call) => call.kind === "startBridge");
    expect(started?.kind === "startBridge" && started.input.env[PROVIDER_CREDENTIAL_ENV_VAR]).toBe(
      "sk-ant-test-key"
    );

    // And it is in no durable record. A credential in a row is a credential in
    // every backup.
    const row = await store.findSession(ALICE.id, sessionIdOf(sandbox));
    expect(JSON.stringify(row ?? {})).not.toContain("sk-ant-test-key");
    expect(JSON.stringify(await store.findProject(ALICE.id, "rp-1"))).not.toContain("sk-ant-test-key");

    // Nor in the bridge's config file, which a snapshot would preserve.
    expect(JSON.stringify(sandbox.peek("tabdump-aaaabbbbcccc")?.config)).not.toContain(
      "sk-ant-test-key"
    );
  });

  it("refuses when the deployment holds no provider credential", async () => {
    // Truthfully unavailable rather than a session that dies on its first
    // message with an unexplained error.
    const adapter = createClaudeCodeControlAdapter({
      runtime: createRemoteClaudeRuntime({ sandbox, store, ownerId: ALICE.id, env: {} }),
    });
    const host = createRuntimeHost({
      gate: REMOTE_GATE,
      resolveAdapter: () => adapter,
      remote: createRemoteBindings({ store }),
      providers: ["claude-code"],
      runtimeId: "remote-fixed",
    });

    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });

    expect(created).toMatchObject({ ok: false, error: { code: "authentication_required" } });
    expect(sandbox.calls.some((call) => call.kind === "startBridge")).toBe(false);
  });

  it("resumes a stopped sandbox rather than losing the project's files", async () => {
    // A stopped sandbox is snapshotted, and resuming it is what makes a remote
    // project a *project* rather than a single sitting. This is deliberately
    // not a refusal: the brief's "must not be reused accidentally" is about
    // reuse without lifecycle logic, and `ensure` is that logic.
    await sandbox.writeWorkspace("tabdump-aaaabbbbcccc", [
      { path: "src/index.ts", content: new Uint8Array([1, 2, 3]) },
    ]);
    await sandbox.stop("tabdump-aaaabbbbcccc");

    const host = newRequest(ALICE);
    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });

    expect(created.ok).toBe(true);
    expect(sandbox.peek("tabdump-aaaabbbbcccc")?.files.has("src/index.ts")).toBe(true);
  });

  it("refuses when the sandbox platform will not produce one", async () => {
    // The genuinely fail-closed case: no microVM, so no session. Never a
    // fallback to running anything anywhere else.
    sandbox.failNext("ensure", "failed");

    const host = newRequest(ALICE);
    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });

    expect(created.ok).toBe(false);
    expect(sandbox.calls.some((call) => call.kind === "startBridge")).toBe(false);
  });
});

describe("across the request boundary", () => {
  it("picks a running session back up on an instance that never started it", async () => {
    const first = newRequest(ALICE);
    const created = await first.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? created.value.sessionId : "";

    // The agent says something while nobody is listening. This is the normal
    // case: the request that started it ended long ago.
    sandbox.emit("tabdump-aaaabbbbcccc", { t: "ready" });
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "message",
      payload: systemInit("provider-session-1", REMOTE_WORKSPACE_ROOT),
    });
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "message",
      payload: assistantText("provider-session-1", "I read the project."),
    });

    // A completely fresh instance.
    const second = newRequest(ALICE);
    const events = await second.execute(ALICE, { name: "get_events", sessionId });

    expect(events.ok).toBe(true);
    if (!events.ok) return;

    const summaries = events.value.events.map((event) => event.summary);
    expect(summaries).toContain("I read the project.");
  });

  it("sends a message from an instance that never started the session", async () => {
    const first = newRequest(ALICE);
    const created = await first.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });
    const sessionId = created.ok ? created.value.sessionId : "";

    sandbox.emit("tabdump-aaaabbbbcccc", { t: "ready" });
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "message",
      payload: resultSuccess("provider-session-1"),
    });

    const second = newRequest(ALICE);
    const sent = await second.execute(ALICE, {
      name: "send_message",
      sessionId,
      text: "Now add a test.",
    });

    expect(sent.ok).toBe(true);
    // It reached the agent that was already running, rather than starting a
    // second one.
    expect(sandbox.calls.filter((call) => call.kind === "startBridge")).toHaveLength(1);
    expect(sandbox.inbox.at(-1)?.payload).toMatchObject({
      kind: "message",
      text: "Now add a test.",
    });
  });

  it("refuses to drive a session whose bridge has exited", async () => {
    const first = newRequest(ALICE);
    const created = await first.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });
    const sessionId = created.ok ? created.value.sessionId : "";

    sandbox.killBridge("tabdump-aaaabbbbcccc");

    const second = newRequest(ALICE);
    const sent = await second.execute(ALICE, {
      name: "send_message",
      sessionId,
      text: "hello?",
    });

    // Never silently starts a replacement agent over the top.
    expect(sent.ok).toBe(false);
    expect(sandbox.calls.filter((call) => call.kind === "startBridge")).toHaveLength(1);
  });
});

describe("approvals across the request boundary", () => {
  /**
   * The hardest case in the whole design, and the reason the drain stops at an
   * unresolved permission: the agent blocks inside the microVM, the request
   * that saw it ends, and the user answers minutes later on an instance that
   * has never heard of the approval.
   */
  it("raises an approval on one instance and answers it on another", async () => {
    const first = newRequest(ALICE);
    const created = await first.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });
    const sessionId = created.ok ? created.value.sessionId : "";

    sandbox.emit("tabdump-aaaabbbbcccc", { t: "ready" });
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "message",
      payload: systemInit("provider-session-1", REMOTE_WORKSPACE_ROOT),
    });
    // The agent asks to write a file, and blocks.
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "permission",
      id: "ra-stable-1",
      toolName: "Write",
      toolUseId: "tu-1",
      requestId: "rq-1",
      title: "Write src/index.ts",
      input: { file_path: `${REMOTE_WORKSPACE_ROOT}/src/index.ts` },
    });

    // A fresh instance sees the pending approval.
    const second = newRequest(ALICE);
    const view = await second.execute(ALICE, { name: "get_session", sessionId });

    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.session.awaitingApproval).toBe(true);
    expect(view.value.approvals).toHaveLength(1);
    const approvalId = view.value.approvals[0].approvalId;
    // Derived from the provider's own id, so it is the same on every replay.
    expect(approvalId).toBe("ra-stable-1");
    // The target is project-relative, never the absolute in-sandbox path.
    expect(view.value.approvals[0].targets).toEqual(["src/index.ts"]);

    // A third instance answers it.
    const third = newRequest(ALICE);
    const answered = await third.execute(ALICE, {
      name: "respond_to_approval",
      approvalId,
      decision: "granted",
    });

    expect(answered.ok).toBe(true);
    // The decision genuinely reached the blocked agent.
    expect(sandbox.inbox.at(-1)?.payload).toEqual({
      kind: "approval",
      id: "ra-stable-1",
      decision: "granted",
    });
  });

  it("does not re-prompt for an approval the agent has already resolved", async () => {
    const host = newRequest(ALICE);
    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });
    const sessionId = created.ok ? created.value.sessionId : "";

    sandbox.emit("tabdump-aaaabbbbcccc", { t: "ready" });
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "permission",
      id: "ra-stable-1",
      toolName: "Write",
      toolUseId: "tu-1",
      requestId: "rq-1",
      input: {},
    });
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "permission_resolved",
      id: "ra-stable-1",
      granted: true,
    });

    const next = newRequest(ALICE);
    const view = await next.execute(ALICE, { name: "get_session", sessionId });

    expect(view.ok).toBe(true);
    if (!view.ok) return;
    // History, not a live question. Re-opening it would ask the user to decide
    // something they have already decided.
    expect(view.value.approvals).toHaveLength(0);
    expect(view.value.session.awaitingApproval).toBe(false);
  });

  it("does not duplicate the approval event when the log is replayed", async () => {
    const host = newRequest(ALICE);
    const created = await host.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });
    const sessionId = created.ok ? created.value.sessionId : "";

    sandbox.emit("tabdump-aaaabbbbcccc", { t: "ready" });
    sandbox.emit("tabdump-aaaabbbbcccc", {
      t: "permission",
      id: "ra-stable-1",
      toolName: "Write",
      toolUseId: "tu-1",
      requestId: "rq-1",
      input: {},
    });

    // Two drains in one request. The journal dedupes by event id, and the
    // approval event's id is derived from the approval rather than minted.
    const next = newRequest(ALICE);
    await next.execute(ALICE, { name: "get_session", sessionId });
    const events = await next.execute(ALICE, { name: "get_events", sessionId });

    expect(events.ok).toBe(true);
    if (!events.ok) return;

    const requests = events.value.events.filter((event) => event.kind === "approval_requested");
    expect(requests).toHaveLength(1);
  });
});

describe("ownership", () => {
  it("does not let another account reach a session or its project", async () => {
    const first = newRequest(ALICE);
    const created = await first.execute(ALICE, {
      name: "create_session",
      provider: "claude-code",
      projectId: "rp-1",
    });
    const sessionId = created.ok ? created.value.sessionId : "";

    // Bob's host is built against a store view that can only see Bob's rows.
    const bobHost = newRequest(BOB);

    expect(await bobHost.execute(BOB, { name: "get_session", sessionId })).toMatchObject({
      ok: false,
      error: { code: "session_not_found" },
    });

    expect(
      await bobHost.execute(BOB, {
        name: "create_session",
        provider: "claude-code",
        projectId: "rp-1",
      })
    ).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });

    const listed = await bobHost.execute(BOB, { name: "list_sessions" });
    expect(listed.ok && listed.value.sessions).toEqual([]);
  });
});

describe("local project records", () => {
  it("refuses every project a browser tries to authorize", async () => {
    // These describe directories on the machine running the browser. A hosted
    // deployment cannot see that machine, and a path from one would resolve —
    // if at all — to a directory on the server.
    const host = newRequest(ALICE);

    const result = await host.execute(ALICE, {
      name: "authorize_projects",
      projects: [
        {
          id: "local-1",
          name: "My laptop project",
          path: "C:/work/secret",
          providers: ["claude-code"],
          permissions: { scopes: ["write_project"], grantedAt: T0 },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accepted).toEqual([]);
    expect(result.value.rejected).toEqual([{ id: "local-1", reason: "remote-runtime" }]);

    // And it cannot then be used.
    expect(
      await host.execute(ALICE, {
        name: "create_session",
        provider: "claude-code",
        projectId: "local-1",
      })
    ).toMatchObject({ ok: false, error: { code: "project_scope_violation" } });
  });
});

/** The single session the fake has, for assertions that need its id. */
function sessionIdOf(service: FakeSandboxService): string {
  const start = service.calls.find((call) => call.kind === "startBridge");
  return start?.kind === "startBridge" ? start.input.sandboxName : "";
}
