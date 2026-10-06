import { describe, expect, it } from "vitest";
import { AgentError, createFakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import { createFakeCodex, THREAD_ID, TURN_ID } from "@/lib/agents/control/providers/codex-app-server/__fixtures__/fake-codex";
import type { FakeCodexHandler } from "@/lib/agents/control/providers/codex-app-server/__fixtures__/fake-codex";
import { createNativeLoginState } from "@/lib/agents/launch/native-auth";
import { createDesktopRuntime } from "./desktop";
import { createMemoryProjectHost } from "@/lib/agents/project/__fixtures__/memory-project-host";
import { handleDesktopLine } from "./desktop-protocol";
import type { FakeAgent } from "@/lib/agents/control/providers/acp/__fixtures__/fake-agent";
import type { NativeOperation } from "@/lib/agents/launch/process";
import type { RuntimeCommand, SequencedControlEvent } from "./protocol";

/**
 * The desktop app's agent runtime (Phase J.1), end to end in-process.
 *
 * Everything real except the two things that would touch the machine: the
 * Claude Agent SDK is a scripted stand-in that behaves like the real one (it
 * streams messages, and asks `canUseTool` before a write), and `claude auth`
 * is a scripted runner. The host, the control service, the approval broker,
 * the Claude adapter and the native sign-in wrapper are the production code.
 */

const PROJECT_ROOT = "C:/work/research";

type ScriptedSdk = { query(params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): unknown };

function scriptedSdk(record: { options?: Record<string, unknown>; decisions: string[]; aborted: boolean }): ScriptedSdk {
  return {
    query({ prompt, options }) {
      record.options = options;
      const abort = options.abortController as AbortController;
      abort.signal.addEventListener("abort", () => {
        record.aborted = true;
      });
      const canUseTool = options.canUseTool as (
        tool: string,
        input: Record<string, unknown>,
        meta: Record<string, unknown>
      ) => Promise<{ behavior: string }>;

      async function* run() {
        yield { type: "system", subtype: "init", session_id: "claude-session-1" };
        for await (const raw of prompt) {
          const text = String((raw as { message: { content: string } }).message.content);
          if (text.includes("write")) {
            const decision = await canUseTool(
              "Write",
              { file_path: `${PROJECT_ROOT}/notes.md`, content: "hello" },
              { toolUseID: "tool-1", requestId: "req-1", signal: abort.signal }
            );
            record.decisions.push(decision.behavior);
          }
          yield {
            type: "assistant",
            session_id: "claude-session-1",
            message: { content: [{ type: "text", text: `Done.\nDecision: ${record.decisions.at(-1) ?? "none"}` }] },
          };
          yield { type: "result", subtype: "success", is_error: false, session_id: "claude-session-1" };
        }
      }

      const iterator = run();
      return Object.assign(iterator, { interrupt: async () => undefined });
    },
  };
}

/**
 * `claude auth status` as the scripted CLI prints it. `account` stands for a
 * permitted first-party sign-in (a Console account) — any `authMethod` other
 * than the verified subscription marker, with no plan; `subscription` is the
 * verified Claude.ai shape, which Hubble must refuse.
 */
function build(loggedIn: { value: boolean }, kind: "account" | "subscription" = "account") {
  const operations: NativeOperation[] = [];
  const record = { decisions: [] as string[], aborted: false } as {
    options?: Record<string, unknown>;
    decisions: string[];
    aborted: boolean;
  };
  const login = createNativeLoginState({
    run: async (operation) => {
      operations.push(operation);
      if (operation.kind === "login") loggedIn.value = true;
      const signedIn =
        kind === "subscription"
          ? { authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }
          : { authMethod: "not-a-subscription", apiProvider: "firstParty" };
      return {
        ok: true,
        exitCode: loggedIn.value ? 0 : 1,
        stdout: JSON.stringify({ loggedIn: loggedIn.value, email: "a@b.c", ...(loggedIn.value ? signedIn : {}) }),
      };
    },
  });
  const runtime = createDesktopRuntime({
    // The project folder exists (Hubble 1.6 checks before starting an agent in it).
    projects: createMemoryProjectHost({ [PROJECT_ROOT]: {} }),
    env: { PATH: "C:/Tools", USERPROFILE: "C:/Users/alice", ANTHROPIC_API_KEY: "sk-must-not-pass" },
    claudeExecutable: "C:/Tools/claude.exe",
    claudeLogin: login,
    loadClaudeSdk: async () => scriptedSdk(record),
    detect: () => [{ provider: "claude-code", installed: true, transport: "sdk", launchable: false }],
    runtimeId: "desktop-1",
  });

  async function send(command: RuntimeCommand) {
    return (await runtime.handle({ runtimeId: "desktop-1", command })) as {
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string };
    };
  }
  return { runtime, send, operations, record };
}

async function settle(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the desktop runtime", () => {
  it("is a local, executable runtime that can say what is installed", async () => {
    const { runtime, send } = build({ value: false });
    const status = (await runtime.handle({ command: { name: "get_status" } })) as {
      value: { environment: string; executable: boolean; providers: { provider: string }[] };
    };
    expect(status.value.environment).toBe("local");
    expect(status.value.executable).toBe(true);
    expect(status.value.providers.map((provider) => provider.provider)).toEqual([
      "claude-code",
      "gemini",
      "openai-codex",
      "grok",
    ]);
    expect(await send({ name: "detect_providers" })).toMatchObject({ ok: true, value: { thisMachine: true } });
  });

  it("refuses a request for a different runtime generation, and a malformed one", async () => {
    const { runtime } = build({ value: false });
    expect(await runtime.handle({ runtimeId: "stale", command: { name: "list_sessions" } })).toMatchObject({
      ok: false,
      error: { code: "runtime_disconnected" },
    });
    expect(await runtime.handle({ command: { name: "rm -rf" } })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });
});

describe("Claude Code signs in with its own login", () => {
  it("reports sign-in required, offers only the Console sign-in, and signs in through `claude auth login --console`", async () => {
    const loggedIn = { value: false };
    const { send, operations } = build(loggedIn);

    const connected = await send({ name: "connect_provider", provider: "claude-code" });
    expect(connected).toMatchObject({
      ok: true,
      value: {
        connection: "configuration_required",
        authentication: "required",
        nativeSignIn: true,
        authMethods: [{ id: "console", name: "Sign in with Anthropic Console" }],
      },
    });
    expect(await send({ name: "create_session", provider: "claude-code" })).toMatchObject({
      ok: false,
      error: { code: "authentication_required" },
    });

    const signedIn = await send({ name: "authenticate_provider", provider: "claude-code", methodId: "console" });
    expect(signedIn).toMatchObject({
      ok: true,
      value: { connection: "connected", authentication: "authenticated", authKind: "account" },
    });
    expect((signedIn.value as { authIssue?: string }).authIssue).toBeUndefined();
    expect(operations).toContainEqual({ kind: "login", methodId: "console" });
    // The account the CLI printed never leaves the runtime.
    expect(JSON.stringify(signedIn)).not.toContain("a@b.c");
  });

  it("refuses a Claude subscription sign-in: signed in, not permitted, and no session starts on it", async () => {
    const { send, operations } = build({ value: true }, "subscription");

    const connected = await send({ name: "connect_provider", provider: "claude-code" });
    expect(connected).toMatchObject({
      ok: true,
      value: {
        connection: "configuration_required",
        authentication: "authenticated",
        authKind: "subscription",
        authIssue: "method_not_permitted",
      },
    });
    const status = (await send({ name: "get_status" })) as { value?: { providers: Record<string, unknown>[] } };
    expect(status.value?.providers.find((entry) => entry.provider === "claude-code")).toMatchObject({
      authIssue: "method_not_permitted",
    });

    // Refused before anything starts, and nothing is switched for the user.
    expect(await send({ name: "create_session", provider: "claude-code" })).toMatchObject({
      ok: false,
      error: { code: "authentication_required" },
    });
    expect(operations.some((operation) => operation.kind === "login")).toBe(false);
    // The subscription login cannot be started through Hubble either.
    expect(
      await send({ name: "authenticate_provider", provider: "claude-code", methodId: "claudeai" })
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(JSON.stringify(connected)).not.toMatch(/a@b\.c|claude\.ai|"pro"/);
  });

  it("refuses a sign-in method that is not in the allowlist, and runs nothing for it", async () => {
    const { send, operations } = build({ value: false });
    await send({ name: "connect_provider", provider: "claude-code" });
    const before = operations.length;
    expect(
      await send({ name: "authenticate_provider", provider: "claude-code", methodId: "--dangerously-skip" })
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(operations.slice(before).some((operation) => operation.kind === "login")).toBe(false);
  });
});

describe("a desktop session, end to end", () => {
  it("starts in the authorized project and workspace, streams the reply, and surfaces a real approval", async () => {
    const { send, record } = build({ value: true });
    await send({ name: "connect_provider", provider: "claude-code" });

    const authorized = await send({
      name: "authorize_projects",
      projects: [
        {
          id: "p1",
          name: "Research",
          path: PROJECT_ROOT,
          providers: ["claude-code"],
          permissions: { scopes: ["read_workspace", "read_project", "write_project"], projectId: "p1", grantedAt: 1 },
        },
      ],
    });
    expect(authorized).toMatchObject({ ok: true, value: { accepted: ["p1"], rejected: [] } });

    const created = await send({ name: "create_session", provider: "claude-code", projectId: "p1", workspaceId: "w1" });
    expect(created).toMatchObject({ ok: true, value: { projectId: "p1", workspaceId: "w1" } });
    const sessionId = String(created.value!.sessionId);

    // The agent runs the user's installed Claude Code, in the project, with
    // an environment that carries no key.
    expect(record.options?.pathToClaudeCodeExecutable).toBe("C:/Tools/claude.exe");
    expect(record.options?.cwd).toBe(PROJECT_ROOT);
    expect(JSON.stringify(record.options?.env)).not.toContain("sk-must-not-pass");

    await send({ name: "send_message", sessionId, text: "please write the notes" });
    await settle();

    const waiting = await send({ name: "get_session", sessionId });
    const approvals = (waiting.value as { approvals: { approvalId: string; targets: string[]; action: string }[] })
      .approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ action: "create_files", targets: ["notes.md"] });

    await send({ name: "respond_to_approval", approvalId: approvals[0].approvalId, decision: "granted" });
    await settle();
    expect(record.decisions).toEqual(["allow"]);

    const read = await send({ name: "get_events", sessionId });
    const events = (read.value as { events: SequencedControlEvent[] }).events;
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("message_sent");
    expect(kinds).toContain("approval_requested");
    // Answered: nothing is pending any more, and the agent carried on.
    const after = await send({ name: "get_session", sessionId });
    expect((after.value as { approvals: unknown[] }).approvals).toEqual([]);
    expect(events.find((event) => event.kind === "message_received")?.text).toBe("Done.\nDecision: allow");
  });

  it("ends every session and releases the agent when disposed", async () => {
    const { runtime, send, record } = build({ value: true });
    await send({ name: "connect_provider", provider: "claude-code" });
    const created = await send({ name: "create_session", provider: "claude-code" });
    expect(created.ok).toBe(true);

    await runtime.dispose();
    await runtime.dispose();
    expect(record.aborted).toBe(true);
  });
});

describe("the line protocol", () => {
  const runtime = {
    handle: async (request: unknown) => ({ ok: true, value: request }),
    dispose: async () => {},
  };

  it("answers each line with its id", async () => {
    const reply = await handleDesktopLine(runtime, JSON.stringify({ id: 7, request: { command: { name: "get_status" } } }));
    expect(JSON.parse(reply.out!)).toEqual({ id: 7, response: { ok: true, value: { command: { name: "get_status" } } } });
    expect(reply.shutdown).toBe(false);
  });

  it("ignores garbage, lines without an id, and oversized lines", async () => {
    for (const line of ["", "not json", "[]", JSON.stringify({ request: {} }), JSON.stringify({ id: -1 }), "x".repeat(2 * 1024 * 1024)]) {
      expect(await handleDesktopLine(runtime, line)).toEqual({ out: null, shutdown: false });
    }
  });

  it("shuts down on request, disposing first", async () => {
    let disposed = false;
    const reply = await handleDesktopLine(
      { handle: runtime.handle, dispose: async () => void (disposed = true) },
      JSON.stringify({ id: 9, shutdown: true })
    );
    expect(disposed).toBe(true);
    expect(reply.shutdown).toBe(true);
  });

  it("never forwards a thrown error's text", async () => {
    const reply = await handleDesktopLine(
      {
        handle: async () => {
          throw new Error("C:/Users/alice/secret.txt: ENOENT");
        },
        dispose: async () => {},
      },
      JSON.stringify({ id: 3, request: {} })
    );
    expect(reply.out).not.toContain("alice");
    expect(JSON.parse(reply.out!)).toMatchObject({ id: 3, response: { ok: false, error: { code: "provider_error" } } });
  });
});

describe("the desktop gate cannot be reached from the web", () => {
  it("is asserted only by the desktop wiring, which nothing the web serves imports", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const SRC = path.resolve(__dirname, "../../..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full);
        return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
      });
    const files = walk(SRC).map((file) => ({ file: path.relative(SRC, file).split(path.sep).join("/"), code: readFileSync(file, "utf8") }));

    const asserting = files.filter(({ file, code }) => file !== "lib/agents/runtime/gate.ts" && code.includes("allowDesktopExecution("));
    expect(asserting.map(({ file }) => file)).toEqual(["lib/agents/runtime/desktop.ts"]);

    const importers = files.filter(({ code }) => /from\s+["'][^"']*runtime\/desktop["']/.test(code));
    expect(importers.map(({ file }) => file)).toEqual(["desktop-runtime/main.ts"]);
    expect(files.some(({ file, code }) => file.startsWith("app/") && code.includes("desktop-runtime"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Phase J.2 — every ACP agent through the same desktop runtime
 * ------------------------------------------------------------------ */

describe("ACP agents in the desktop runtime (Phase J.2)", () => {
  function buildAcp(options: {
    signedIn: boolean;
    platform?: NodeJS.Platform;
    codexHandlers?: Record<string, FakeCodexHandler>;
  }) {
    const agents = new Map<string, FakeAgent>();
    const agentFor = (provider: string) => {
      let agent = agents.get(provider);
      if (!agent) {
        agent = createFakeAgent({
          "session/new": () => {
            if (!options.signedIn) throw new AgentError(-32000);
            return { sessionId: `${provider}-1`, modes: { currentModeId: "default", availableModes: [{ id: "default" }] } };
          },
          "session/prompt": async (params, context) => {
            const id = params.sessionId as string;
            context.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Editing." } });
            context.update(id, {
              sessionUpdate: "tool_call",
              toolCallId: "t1",
              kind: "edit",
              status: "pending",
              locations: [{ path: `${PROJECT_ROOT}/notes.md` }],
            });
            const answer = await context.ask("session/request_permission", {
              sessionId: id,
              toolCall: { toolCallId: "t1", kind: "edit" },
              options: [
                { optionId: "once", kind: "allow_once" },
                { optionId: "always", kind: "allow_always" },
                { optionId: "no", kind: "reject_once" },
              ],
            });
            const chose = (answer.result as { outcome?: { optionId?: string } })?.outcome?.optionId ?? "cancelled";
            context.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Chose ${chose}.` } });
            return { stopReason: "end_turn" };
          },
        });
        agents.set(provider, agent);
      }
      return agent;
    };
    // Codex is an app-server agent: a scripted `codex app-server`.
    const codex = createFakeCodex({
      "account/read": () =>
        options.signedIn ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true },
      ...options.codexHandlers,
    });
    const runtime = createDesktopRuntime({
    // The project folder exists (Hubble 1.6 checks before starting an agent in it).
    projects: createMemoryProjectHost({ [PROJECT_ROOT]: {} }),
      env: { PATH: "C:/Tools", USERPROFILE: "C:/Users/alice" },
      claudeExecutable: null,
      acpLauncher: (provider) => agentFor(provider).launcher,
      appServerLauncher: () => codex.launcher,
      appServerLogin: () => async () => "failed",
      platform: options.platform ?? "win32",
      detect: () => [
        { provider: "gemini", installed: true, transport: "acp", launchable: true },
        { provider: "openai-codex", installed: true, transport: "app-server", launchable: true },
        { provider: "grok", installed: true, transport: "acp", launchable: true },
      ],
      runtimeId: "desktop-1",
    });
    async function send(command: RuntimeCommand) {
      return (await runtime.handle({ runtimeId: "desktop-1", command })) as {
        ok: boolean;
        value?: Record<string, unknown>;
        error?: { code: string };
      };
    }
    return { runtime, send, agentFor, codex };
  }

  it("declares sessions for every agent that asks — Codex where its approvals are verified, and nowhere else", async () => {
    const { send } = buildAcp({ signedIn: true });
    const status = await send({ name: "get_status" });
    const providers = (status.value as { providers: { provider: string; capabilities: string[] }[] }).providers;
    const capabilitiesOf = (provider: string) => providers.find((entry) => entry.provider === provider)!.capabilities;
    expect(capabilitiesOf("gemini")).toContain("create_session");
    expect(capabilitiesOf("grok")).toContain("create_session");
    expect(capabilitiesOf("openai-codex")).toEqual(expect.arrayContaining(["create_session", "approvals", "run_commands"]));

    const elsewhere = buildAcp({ signedIn: true, platform: "darwin" });
    const other = (await elsewhere.send({ name: "get_status" })).value as { providers: { provider: string; capabilities: string[] }[] };
    expect(other.providers.find((entry) => entry.provider === "openai-codex")!.capabilities).toEqual([]);
    expect(await elsewhere.send({ name: "create_session", provider: "openai-codex" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  it("runs a Codex session through the real host and broker: the approval carries the complete command, and Codex hears only accept or decline", async () => {
    const replies: unknown[] = [];
    const { send, codex } = buildAcp({
      signedIn: true,
      codexHandlers: {
        "turn/start": (_params, ctx) => {
          void (async () => {
            ctx.notify("item/started", { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "c1", status: "inProgress" } });
            const answer = await ctx.ask("item/commandExecution/requestApproval", {
              kind: "command", threadId: THREAD_ID, turnId: TURN_ID, itemId: "c1", startedAtMs: 1, environmentId: "local",
              command: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content notes.md'",
              cwd: "C:\\work\\research",
            });
            replies.push(answer.result);
            ctx.notify("item/completed", { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "c1", status: "declined" } });
            ctx.notify("turn/completed", { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", error: null } });
          })();
          return { turn: { id: TURN_ID, status: "inProgress" } };
        },
      },
    });
    expect(await send({ name: "connect_provider", provider: "openai-codex" })).toMatchObject({
      ok: true,
      value: { connection: "connected", authentication: "authenticated", nativeSignIn: true, authKind: "subscription" },
    });
    await send({
      name: "authorize_projects",
      projects: [
        {
          id: "p1",
          name: "Research",
          path: PROJECT_ROOT,
          providers: ["openai-codex"],
          permissions: { scopes: ["read_workspace", "read_project", "run_commands"], projectId: "p1", grantedAt: 1 },
        },
      ],
    });
    const created = await send({ name: "create_session", provider: "openai-codex", projectId: "p1", workspaceId: "w1" });
    expect(created).toMatchObject({ ok: true, value: { provider: "openai-codex", projectId: "p1" } });
    const sessionId = String(created.value!.sessionId);

    await send({ name: "send_message", sessionId, text: "read the notes" });
    await settle(40);
    const waiting = await send({ name: "get_session", sessionId });
    const approvals = (waiting.value as { approvals: Record<string, unknown>[] }).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      provider: "openai-codex",
      action: "run_command",
      scope: "run_commands",
      command: {
        commandLine: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content notes.md'",
        workingDirectory: ".",
        insideProject: true,
      },
    });

    await send({ name: "respond_to_approval", approvalId: String(approvals[0].approvalId), decision: "denied" });
    await settle(40);
    expect(replies).toEqual([{ decision: "decline" }]);
    // Found in real-agent QA: the session must leave "waiting for approval"
    // once answered — the run's end is otherwise refused as a transition.
    const after = await send({ name: "get_session", sessionId });
    expect((after.value as { session: { status: string } }).session.status).toBe("ready");

    expect(await send({ name: "dispose_session", sessionId })).toMatchObject({ ok: true });
    expect(codex.closed).toBeGreaterThan(0);
  });

  it("reports each agent's own sign-in answer on connect", async () => {
    const signedOut = buildAcp({ signedIn: false });
    for (const provider of ["gemini", "openai-codex", "grok"] as const) {
      expect(await signedOut.send({ name: "connect_provider", provider })).toMatchObject({
        ok: true,
        value: { connection: "connected", authentication: "required", nativeSignIn: true },
      });
    }
    const signedIn = buildAcp({ signedIn: true });
    expect(await signedIn.send({ name: "connect_provider", provider: "gemini" })).toMatchObject({
      ok: true,
      value: { authentication: "authenticated" },
    });
  });

  it("runs a session like Claude's: project, workspace, streamed reply, one-time approval, disconnect", async () => {
    const { send, agentFor } = buildAcp({ signedIn: true });
    await send({ name: "connect_provider", provider: "gemini" });
    await send({
      name: "authorize_projects",
      projects: [
        {
          id: "p1",
          name: "Research",
          path: PROJECT_ROOT,
          providers: ["gemini"],
          permissions: { scopes: ["read_workspace", "read_project", "write_project"], projectId: "p1", grantedAt: 1 },
        },
      ],
    });

    const created = await send({ name: "create_session", provider: "gemini", projectId: "p1", workspaceId: "w1" });
    expect(created).toMatchObject({ ok: true, value: { provider: "gemini", projectId: "p1", workspaceId: "w1" } });
    const sessionId = String(created.value!.sessionId);
    expect(agentFor("gemini").launches.at(-1)).toEqual({ projectPath: PROJECT_ROOT });

    await send({ name: "send_message", sessionId, text: "please edit the notes" });
    await settle(40);
    const waiting = await send({ name: "get_session", sessionId });
    const approvals = (waiting.value as { approvals: { approvalId: string; targets: string[]; action: string }[] })
      .approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ action: "modify_files", targets: ["notes.md"] });

    await send({ name: "respond_to_approval", approvalId: approvals[0].approvalId, decision: "granted" });
    await settle(40);

    const read = await send({ name: "get_events", sessionId });
    const events = (read.value as { events: SequencedControlEvent[] }).events;
    // The agent's own one-time option — never "always".
    expect(events.filter((event) => event.kind === "message_received").map((event) => event.text)).toEqual([
      "Editing.",
      "Chose once.",
    ]);

    const released = agentFor("gemini").released;
    expect(await send({ name: "disconnect_provider", provider: "gemini" })).toMatchObject({ ok: true });
    expect(agentFor("gemini").released).toBeGreaterThan(released);
    expect(await send({ name: "get_session", sessionId })).toMatchObject({ ok: false });
  });
});
