import { describe, expect, it } from "vitest";
import {
  assistantText,
  assistantThinking,
  assistantToolUse,
  createScriptedRuntime,
  resultError,
  resultSuccess,
  systemInit,
  toolResult,
} from "./__fixtures__/scripted-runtime";
import {
  CLAUDE_CODE_CONTROL_CAPABILITIES,
  createClaudeCodeControlAdapter,
  readApprovalDetails,
} from "./adapter";
import { createGrant } from "../../permissions";
import { createProject } from "../../projects";
import type { AgentControlEvent } from "../../events";
import type { AgentPermissionGrant, AgentPermissionScope } from "../../permissions";
import type { AgentProject } from "../../projects";

/**
 * The Claude adapter, driven end to end against a real implementation of the
 * runtime contract.
 *
 * Nothing here is `vi.mock`ed. The scripted runtime satisfies the same
 * interface the SDK-backed one does, so every lifecycle assertion below is a
 * claim about behaviour the production path also has — see the note in
 * ./__fixtures__/scripted-runtime.ts.
 */

const T0 = 1_700_000_000_000;
const SESSION = "s1";
const CLAUDE_SESSION = "claude-uuid-1";

function project(over: Partial<AgentProject> = {}): AgentProject {
  const made = createProject(
    {
      id: "p1",
      name: "Research",
      path: "C:/work/research",
      providers: ["claude-code"],
    },
    T0
  );
  if (!made.ok) throw new Error("fixture failed");
  return { ...made.project, ...over };
}

function grantOf(scopes: readonly AgentPermissionScope[]): AgentPermissionGrant {
  const grant = createGrant(scopes, T0, "p1");
  if (!grant) throw new Error("fixture failed");
  return grant;
}

function setup(over: { grant?: AgentPermissionGrant; project?: AgentProject } = {}) {
  const runtime = createScriptedRuntime();
  let counter = 0;

  const adapter = createClaudeCodeControlAdapter({
    runtime,
    now: () => T0,
    createId: () => `id-${++counter}`,
  });

  const events: AgentControlEvent[] = [];
  adapter.subscribeToEvents((event) => events.push(event));

  return {
    runtime,
    adapter,
    events,
    grant: over.grant ?? grantOf(["read_project", "write_project"]),
    project: over.project ?? project(),
  };
}

async function started(over: Parameters<typeof setup>[0] = {}) {
  const context = setup(over);
  const result = await context.adapter.createSession({
    sessionId: SESSION,
    project: context.project,
    permissions: context.grant,
    attachments: [],
  });
  return { ...context, result };
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

describe("capabilities", () => {
  it("declares only what is implemented, and never MCP", () => {
    // TabDump configures no MCP servers, so there is nothing to declare —
    // advertising it because the provider has a flag is exactly what the
    // capability model forbids.
    expect([...CLAUDE_CODE_CONTROL_CAPABILITIES].sort()).toEqual([
      "additional_directories",
      "approvals",
      "cancel_run",
      "create_session",
      "message",
      "read_files",
      "resume_session",
      "run_commands",
      "stream_events",
      "working_directory",
      "write_files",
    ]);
    expect(CLAUDE_CODE_CONTROL_CAPABILITIES.has("mcp")).toBe(false);
    expect(CLAUDE_CODE_CONTROL_CAPABILITIES.has("observe")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

describe("connecting", () => {
  it("reports unavailable when the runtime is not there", async () => {
    const { adapter, runtime } = setup();
    runtime.setAvailable(false);

    const result = await adapter.connect();

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(adapter.getConnectionStatus().kind).toBe("unavailable");
  });

  it("reports connected when it is", async () => {
    const { adapter } = setup();
    expect((await adapter.connect()).ok).toBe(true);
    expect(adapter.getConnectionStatus().kind).toBe("connected");
  });
});

/* ------------------------------------------------------------------ *
 * Session creation and scope
 * ------------------------------------------------------------------ */

describe("creating a session", () => {
  it("starts a run with the project's directory and nothing else", async () => {
    const { runtime, result } = await started();

    expect(result.ok).toBe(true);
    expect(runtime.latest().options.cwd).toBe("C:/work/research");
    expect(runtime.latest().options.additionalDirectories).toEqual([]);
  });

  it("passes exactly the additional directories the project authorized", async () => {
    const scoped = createProject(
      {
        id: "p1",
        name: "Research",
        path: "C:/work/research",
        providers: ["claude-code"],
        additionalDirectories: ["C:/work/shared-data"],
      },
      T0
    );
    if (!scoped.ok) throw new Error("fixture failed");

    const { runtime } = await started({ project: scoped.project });

    expect(runtime.latest().options.additionalDirectories).toEqual(["C:/work/shared-data"]);
  });

  it("gives the runtime no directory at all when there is no project", async () => {
    // Not the server's cwd. Inheriting it would silently authorize wherever
    // TabDump happens to be running.
    const { adapter, runtime, grant } = setup();
    await adapter.createSession({ sessionId: SESSION, permissions: grant, attachments: [] });

    expect(runtime.latest().options.cwd).toBeUndefined();
    expect(runtime.latest().options.additionalDirectories).toEqual([]);
  });

  it("denies ungranted tools outright and leaves granted ones to the callback", async () => {
    // The subtle part: a granted tool appears in NEITHER list. A bare name in
    // `allowedTools` auto-approves it before `canUseTool` runs, which would
    // suppress the prompt entirely.
    const readOnly = await started({ grant: grantOf(["read_project"]) });
    const options = readOnly.runtime.latest().options;

    expect(options.disallowedTools).toContain("Edit");
    expect(options.disallowedTools).toContain("Bash");

    expect(options.allowedTools).not.toContain("Read");
    expect(options.disallowedTools).not.toContain("Read");

    expect(options.permissionMode).toBe("default");
  });

  it("auto-allows only tools with no effect on the machine", async () => {
    const { runtime } = await started({
      grant: grantOf(["read_project", "write_project", "run_commands"]),
    });

    // The entire auto-approved set, for every grant.
    expect(runtime.latest().options.allowedTools).toEqual(["TodoWrite"]);
  });

  it("never sends a mode that would answer an approval on TabDump's behalf", async () => {
    // `acceptEdits` auto-accepts file edits, which means `canUseTool` is
    // never called for them — TabDump would show no prompt and Claude would
    // write the file. It is the most dangerous mode precisely because it
    // looks harmless.
    for (const scopes of [
      [],
      ["read_project"],
      ["read_project", "write_project"],
      ["read_project", "write_project", "run_commands"],
    ] as const) {
      const { runtime } = await started({ grant: grantOf([...scopes] as AgentPermissionScope[]) });
      const mode = runtime.latest().options.permissionMode;

      expect(mode).not.toBe("acceptEdits");
      expect(mode).not.toBe("bypassPermissions");
      expect(["default", "dontAsk"]).toContain(mode);
    }
  });

  it("surfaces a runtime failure as a control error", async () => {
    const { adapter, runtime, grant, project: scoped } = setup();
    runtime.failNextStart({ code: "not-installed" });

    const result = await adapter.createSession({
      sessionId: SESSION,
      project: scoped,
      permissions: grant,
      attachments: [],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("maps an authentication failure to configuration rather than to unknown", async () => {
    const { adapter, runtime, grant } = setup();
    runtime.failNextStart({ code: "authentication", detail: "oauth token expired" });

    const result = await adapter.createSession({
      sessionId: SESSION,
      permissions: grant,
      attachments: [],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "configuration" } });
    // The provider's own text never becomes the user-facing message.
    if (!result.ok) expect(result.error.message).not.toContain("oauth");
  });
});

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

describe("streaming", () => {
  it("emits events as messages arrive, not only at the end", async () => {
    const { runtime, events } = await started();
    const run = runtime.latest();

    run.emit(systemInit(CLAUDE_SESSION));
    expect(events.map((e) => e.kind)).toEqual(["session_started"]);

    run.emit(assistantText(CLAUDE_SESSION, "Looking at the parser."));
    expect(events.map((e) => e.kind)).toEqual(["session_started", "message_received"]);

    run.emit(resultSuccess(CLAUDE_SESSION));
    expect(events.map((e) => e.kind)).toEqual([
      "session_started",
      "message_received",
      "run_completed",
    ]);
  });

  it("captures the provider's session id from the first frame that has one", async () => {
    const { runtime, adapter, events } = await started();
    runtime.latest().emit(systemInit(CLAUDE_SESSION));

    // Proven through a resume, which is the only thing the id is for.
    await adapter.cancelRun(SESSION);
    expect(events.some((e) => e.kind === "run_cancelled")).toBe(true);
  });

  it("reports a tool call and the file it named", async () => {
    const { runtime, events } = await started();

    runtime
      .latest()
      .emit(
        assistantToolUse(CLAUDE_SESSION, "Edit", { file_path: "C:/work/research/src/parser.ts" })
      );

    expect(events.map((e) => e.kind)).toEqual(["tool_started", "file_modified"]);
    expect(events[1].file).toEqual({ relativePath: "src/parser.ts", projectId: "p1" });
  });

  it("reports a command without ever carrying the command", async () => {
    const { runtime, events } = await started({
      grant: grantOf(["read_project", "run_commands"]),
    });

    runtime
      .latest()
      .emit(assistantToolUse(CLAUDE_SESSION, "Bash", { command: "rm -rf / --no-preserve-root" }));

    expect(events.map((e) => e.kind)).toEqual(["command_started"]);
    expect(JSON.stringify(events)).not.toContain("rm -rf");
    expect(events[0].tool).toMatchObject({ name: "Bash" });
  });

  it("drops a file outside the project rather than emitting an absolute path", async () => {
    const { runtime, events } = await started();

    runtime
      .latest()
      .emit(assistantToolUse(CLAUDE_SESSION, "Read", { file_path: "C:/Users/alice/.ssh/id_rsa" }));

    // The tool call is still reported; the file is not.
    expect(events.map((e) => e.kind)).toEqual(["tool_started"]);
    expect(JSON.stringify(events)).not.toContain("id_rsa");
  });

  it("carries no thinking content", async () => {
    const { runtime, events } = await started();
    runtime.latest().emit(assistantThinking(CLAUDE_SESSION));

    expect(events.map((e) => e.kind)).toEqual(["thinking"]);
    expect(JSON.stringify(events)).not.toContain("secret reasoning");
  });

  it("carries no tool result content", async () => {
    const { runtime, events } = await started();
    runtime.latest().emit(toolResult(CLAUDE_SESSION));

    expect(events.map((e) => e.kind)).toEqual(["tool_finished"]);
    expect(JSON.stringify(events)).not.toContain("file contents");
  });

  it("reports a failed result as an error", async () => {
    const { runtime, events } = await started();
    runtime.latest().emit(resultError(CLAUDE_SESSION));

    expect(events.map((e) => e.kind)).toEqual(["error"]);
  });

  it("carries no run id until one is bound, and every one after", async () => {
    // The control plane does not mint domain runs. Until something
    // correlates the two planes, an event genuinely belongs to no run, and
    // saying so is what keeps `toDomainEventInput` from writing orphans into
    // the durable log.
    const { runtime, events, adapter } = await started();

    runtime.latest().emit(assistantText(CLAUDE_SESSION, "before"));
    expect(events[0].runId).toBeUndefined();

    adapter.bindRun(SESSION, "run-1");
    runtime.latest().emit(assistantText(CLAUDE_SESSION, "after"));

    expect(events[1].runId).toBe("run-1");
  });

  it("ignores a message shape it does not recognise", async () => {
    // A newer Claude than this build was written against is ordinary, not an
    // error.
    const { runtime, events } = await started();
    runtime.latest().emit({ type: "some_future_frame", session_id: CLAUDE_SESSION });
    runtime.latest().emit({ nonsense: true });

    expect(events).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Multi-turn
 * ------------------------------------------------------------------ */

describe("multi-turn", () => {
  it("sends further messages into the same run", async () => {
    const { adapter, runtime } = await started();

    expect((await adapter.sendMessage({ sessionId: SESSION, text: "first", context: { attachments: [] } })).ok).toBe(true);
    expect((await adapter.sendMessage({ sessionId: SESSION, text: "second", context: { attachments: [] } })).ok).toBe(true);

    // One run, two turns — not a process per message.
    expect(runtime.runs).toHaveLength(1);
    expect(runtime.latest().sent).toEqual(["first", "second"]);
  });

  it("refuses a message for an unknown session", async () => {
    const { adapter } = await started();

    expect(
      await adapter.sendMessage({ sessionId: "nope", text: "hi", context: { attachments: [] } })
    ).toMatchObject({ ok: false, error: { code: "invalid-session" } });
  });

  it("refuses a message once the run has ended", async () => {
    const { adapter, runtime } = await started();
    runtime.latest().finish();

    expect(
      await adapter.sendMessage({ sessionId: SESSION, text: "hi", context: { attachments: [] } })
    ).toMatchObject({ ok: false, error: { code: "invalid-session" } });
  });
});

/* ------------------------------------------------------------------ *
 * Resume
 * ------------------------------------------------------------------ */

describe("resume", () => {
  it("reattaches to the provider's own session rather than starting a new one", async () => {
    const { adapter, runtime } = setup();

    const result = await adapter.resumeSession({
      sessionId: "s2",
      providerSessionId: CLAUDE_SESSION,
      project: project(),
      permissions: grantOf(["read_project"]),
    });

    expect(result.ok).toBe(true);
    expect(runtime.latest().options.resume).toBe(CLAUDE_SESSION);
    if (result.ok) expect(result.value.providerSessionId).toBe(CLAUDE_SESSION);
  });

  it("carries the same scope rules a fresh session would", async () => {
    const { adapter, runtime } = setup();

    await adapter.resumeSession({
      sessionId: "s2",
      providerSessionId: CLAUDE_SESSION,
      project: project(),
      permissions: grantOf(["read_project"]),
    });

    expect(runtime.latest().options.allowedTools).not.toContain("Edit");
    expect(runtime.latest().options.cwd).toBe("C:/work/research");
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------ */

describe("cancellation", () => {
  it("reaches the runtime rather than only local state", async () => {
    const { adapter, runtime, events } = await started();

    const result = await adapter.cancelRun(SESSION);

    expect(result.ok).toBe(true);
    expect(runtime.latest().interrupts).toBe(1);
    expect(events.map((e) => e.kind)).toContain("run_cancelled");
  });

  it("refuses to cancel an unknown session", async () => {
    const { adapter } = await started();
    expect(await adapter.cancelRun("nope")).toMatchObject({
      ok: false,
      error: { code: "invalid-session" },
    });
  });
});

/* ------------------------------------------------------------------ *
 * Approvals — the heart of the phase
 * ------------------------------------------------------------------ */

describe("approvals", () => {
  it("blocks the provider until a decision arrives", async () => {
    const { adapter, runtime, events } = await started();

    const decision = runtime.latest().requestPermission({
      toolName: "Edit",
      title: "Claude wants to edit parser.ts",
      input: { file_path: "C:/work/research/src/parser.ts" },
    });

    let settled = false;
    void decision.then(() => {
      settled = true;
    });

    // The request has surfaced...
    const requested = events.find((event) => event.kind === "approval_requested");
    expect(requested).toBeDefined();

    // ...and nothing has been decided yet.
    await Promise.resolve();
    expect(settled).toBe(false);

    await adapter.respondToApproval(requested!.approvalId!, "granted");
    expect(await decision).toEqual({ behavior: "allow" });
  });

  it("denies when denied", async () => {
    const { adapter, runtime, events } = await started();
    const decision = runtime.latest().requestPermission();

    const requested = events.find((event) => event.kind === "approval_requested")!;
    await adapter.respondToApproval(requested.approvalId!, "denied");

    expect(await decision).toMatchObject({ behavior: "deny" });
  });

  it("uses the provider's own sentence, and invents none when it gives none", async () => {
    const { runtime, events } = await started();

    void runtime.latest().requestPermission({ title: "Claude wants to edit parser.ts" });
    expect(events[0].summary).toBe("Claude wants to edit parser.ts");

    events.length = 0;
    void runtime.latest().requestPermission({ toolName: "Write", title: undefined });
    expect(events[0].summary).toBe("Write");
  });

  it("denies a tool whose scope was never granted, without asking the user", async () => {
    // Asking about something that is refused anyway would train someone to
    // click through prompts that never mattered.
    const { runtime, events } = await started({ grant: grantOf(["read_project"]) });

    const decision = await runtime.latest().requestPermission({ toolName: "Bash" });

    expect(decision).toMatchObject({ behavior: "deny" });
    expect(events.filter((event) => event.kind === "approval_requested")).toEqual([]);
  });

  it("denies an unknown tool", async () => {
    const { runtime } = await started({
      grant: grantOf(["read_project", "write_project", "run_commands"]),
    });

    expect(await runtime.latest().requestPermission({ toolName: "SomeFutureTool" })).toMatchObject(
      { behavior: "deny" }
    );
  });

  it("denies an MCP tool while TabDump configures no servers", async () => {
    const { runtime } = await started({
      grant: grantOf(["read_project", "write_project", "run_commands", "mcp_tools"]),
    });

    expect(
      await runtime.latest().requestPermission({ toolName: "mcp__github__create_issue" })
    ).toMatchObject({ behavior: "deny" });
  });

  it("denies a subagent spawn whatever the grant says", async () => {
    // A subagent's tool use cannot be attributed or gated at the point of
    // use, so the parent's grant would silently become the child's.
    const { runtime } = await started({
      grant: grantOf(["read_project", "write_project", "run_commands"]),
    });

    expect(await runtime.latest().requestPermission({ toolName: "Task" })).toMatchObject({
      behavior: "deny",
    });
  });

  it("carries project-relative targets and the provider's reason", async () => {
    const { runtime, events, adapter } = await started();

    void runtime.latest().requestPermission({
      toolName: "Edit",
      input: { file_path: "C:/work/research/src/parser.ts" },
      description: "Rewriting the import resolver",
    });

    const requested = events.find((event) => event.kind === "approval_requested")!;
    const details = readApprovalDetails(adapter, requested.approvalId!);

    expect(details).toMatchObject({
      toolName: "Edit",
      scope: "write_project",
      projectId: "p1",
      targets: ["src/parser.ts"],
      reason: "Rewriting the import resolver",
    });
  });

  it("names the tool when no path reduces inside the project", async () => {
    const { runtime, events, adapter } = await started({
      grant: grantOf(["read_project", "run_commands"]),
    });

    void runtime.latest().requestPermission({ toolName: "Bash", input: {} });

    const requested = events.find((event) => event.kind === "approval_requested")!;
    expect(readApprovalDetails(adapter, requested.approvalId!)?.targets).toEqual(["Bash"]);
  });

  it("refuses a response for an unknown approval", async () => {
    const { adapter } = await started();
    expect(await adapter.respondToApproval("ghost", "granted")).toMatchObject({
      ok: false,
      error: { code: "invalid-request" },
    });
  });

  it("cannot be answered twice", async () => {
    const { adapter, runtime, events } = await started();
    void runtime.latest().requestPermission();

    const requested = events.find((event) => event.kind === "approval_requested")!;
    expect((await adapter.respondToApproval(requested.approvalId!, "granted")).ok).toBe(true);

    // A late second answer must not reach the provider again.
    expect(await adapter.respondToApproval(requested.approvalId!, "denied")).toMatchObject({
      ok: false,
      error: { code: "invalid-request" },
    });
  });

  it("denies a pending approval when the run is cancelled", async () => {
    const { adapter, runtime } = await started();
    const decision = runtime.latest().requestPermission();

    await adapter.cancelRun(SESSION);

    expect(await decision).toMatchObject({ behavior: "deny" });
  });

  it("denies every pending approval when the session ends", async () => {
    // No promise left dangling, no provider left blocked.
    const { runtime } = await started();
    const first = runtime.latest().requestPermission({ toolUseId: "a" });
    const second = runtime.latest().requestPermission({ toolUseId: "b" });

    runtime.latest().finish();

    expect(await first).toMatchObject({ behavior: "deny" });
    expect(await second).toMatchObject({ behavior: "deny" });
  });

  it("does not auto-approve when nobody answers", async () => {
    const { runtime } = await started();
    const decision = runtime.latest().requestPermission();

    let settled = false;
    void decision.then(() => {
      settled = true;
    });

    // Several microtask turns, and a macrotask for good measure.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

describe("lifecycle", () => {
  it("emits an error event when the run fails", async () => {
    const { runtime, events } = await started();
    runtime.latest().finish({ code: "process-failed", detail: "exit 1" });

    const error = events.find((event) => event.kind === "error");
    expect(error).toBeDefined();
    // The diagnostic detail never becomes the user-facing string.
    expect(error!.summary).not.toContain("exit 1");
  });

  it("emits nothing extra when the run ends cleanly", async () => {
    const { runtime, events } = await started();
    runtime.latest().finish();

    expect(events.filter((event) => event.kind === "error")).toEqual([]);
  });

  it("disposes every live run on disconnect", async () => {
    const { adapter, runtime } = await started();

    await adapter.disconnect();

    expect(runtime.latest().disposed).toBe(true);
    expect(adapter.getConnectionStatus().kind).toBe("disconnected");
  });

  it("leaves no run active after dispose", async () => {
    const { adapter, runtime } = await started();

    adapter.dispose();

    expect(runtime.latest().disposed).toBe(true);
  });

  it("stops delivering events after the listener detaches", async () => {
    const { runtime, adapter } = await started();
    const seen: AgentControlEvent[] = [];
    const unsubscribe = adapter.subscribeToEvents((event) => seen.push(event));

    runtime.latest().emit(assistantText(CLAUDE_SESSION, "one"));
    unsubscribe();
    runtime.latest().emit(assistantText(CLAUDE_SESSION, "two"));

    expect(seen).toHaveLength(1);
  });
});
