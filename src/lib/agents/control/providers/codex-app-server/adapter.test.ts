import { describe, expect, it } from "vitest";
import { CODEX_CAPABILITIES, CODEX_REACH_ONLY_CAPABILITIES, createCodexControlAdapter } from "./adapter";
import {
  askingThread,
  CodexError,
  commandApproval,
  commandItem,
  createFakeCodex,
  flush,
  itemNote,
  THREAD_ID,
  TURN_ID,
  turnCompleted,
} from "./__fixtures__/fake-codex";
import { isWellFormedControlEvent } from "../../events";
import { createGrant } from "../../permissions";
import { createProject } from "../../projects";
import type { AgentControlEvent } from "../../events";
import type { AgentPermissionScope } from "../../permissions";
import type { FakeCodexHandler } from "./__fixtures__/fake-codex";
import type { AppServerLogin } from "./launcher";
import type { SessionContextCapability } from "@/lib/agents/session-context/capabilities";

const T0 = 1_700_000_000_000;
const ROOT = "C:/work/research";
const SERVER_NAME = "tabdump_abcdefghijklmnop";
const CONTEXT_SERVER = {
  name: SERVER_NAME,
  url: "http://127.0.0.1:5123/mcp",
  token: "tdctx_session-credential",
  workspaceId: "ws-launch",
  capabilities: ["workspace.read", "tabs.read", "collections.read"] as readonly SessionContextCapability[],
};

function project(scopes: AgentPermissionScope[] = ["read_project", "write_project", "run_commands"]) {
  const grant = createGrant(scopes, T0, "p1");
  if (!grant) throw new Error("grant fixture failed");
  const made = createProject(
    { id: "p1", name: "Research", path: ROOT, providers: ["openai-codex"], permissions: grant },
    T0
  );
  if (!made.ok) throw new Error("project fixture failed");
  return made.project;
}

function setup(
  handlers: Record<string, FakeCodexHandler> = {},
  extra: Partial<Parameters<typeof createCodexControlAdapter>[0]> & { fail?: "not-installed" | "failed" | "unsafe-home" } = {}
) {
  const { fail, ...rest } = extra;
  const codex = createFakeCodex(handlers, fail ? { fail } : {});
  const logins: string[] = [];
  let id = 0;
  const adapter = createCodexControlAdapter({
    provider: "openai-codex",
    launch: codex.launcher,
    login: async (methodId) => {
      logins.push(methodId);
      return "completed";
    },
    loginMethods: [{ id: "chatgpt", name: "Sign in with ChatGPT" }],
    platformVerified: true,
    minimumVersion: "0.159.0",
    now: () => T0,
    createId: () => `id-${id++}`,
    ...rest,
  });
  const events: AgentControlEvent[] = [];
  adapter.subscribeToEvents((event) => events.push(event));
  return { codex, adapter, events, logins };
}

async function start(
  adapter: ReturnType<typeof createCodexControlAdapter>,
  options: { scopes?: AgentPermissionScope[]; context?: boolean } = {}
) {
  const proj = project(options.scopes);
  const started = await adapter.createSession({
    sessionId: "s1",
    project: proj,
    permissions: proj.permissions,
    attachments: [],
    ...(options.context ? { contextServer: CONTEXT_SERVER } : {}),
  });
  return started;
}

/** Sends a message, and runs `script` inside Codex's `turn/start`. */
function turnHandler(script: (ctx: import("./__fixtures__/fake-codex").FakeCodexContext) => Promise<void>): Record<string, FakeCodexHandler> {
  return {
    "turn/start": (_params, ctx) => {
      void Promise.resolve().then(() => script(ctx));
      return { turn: { id: TURN_ID, items: [], status: "inProgress", error: null } };
    },
  };
}

function sent(codex: ReturnType<typeof createFakeCodex>, method: string) {
  return codex.received.filter((message) => message.method === method);
}

describe("authentication", () => {
  it("reports a signed-out Codex as needing sign-in, from Codex's own answer", async () => {
    const { adapter, codex } = setup({ "account/read": () => ({ account: null, requiresOpenaiAuth: true }) });
    const connected = await adapter.connect();
    expect(connected.ok).toBe(true);
    expect(adapter.describeAuthentication()).toEqual({
      state: "required",
      methods: [{ id: "chatgpt", name: "Sign in with ChatGPT" }],
    });
    // Asked without refreshing anything, on a probe that is released at once.
    expect(sent(codex, "account/read")[0].params).toEqual({});
    expect(sent(codex, "thread/start")).toHaveLength(0);
    expect(codex.closed).toBe(1);
    expect(codex.released).toBe(1);
  });

  it("reports a ChatGPT sign-in as authenticated, keeping only the kind — never the email or plan", async () => {
    const { adapter } = setup();
    await adapter.connect();
    const described = adapter.describeAuthentication();
    expect(described.state).toBe("authenticated");
    expect(described.kind).toBe("subscription");
    expect(described.issue).toBeUndefined();
    expect(JSON.stringify(described)).not.toMatch(/example\.com|plus/);
  });

  it("does not use an API-key or cloud sign-in it did not put there", async () => {
    for (const type of ["apiKey", "amazonBedrock"]) {
      const { adapter } = setup({ "account/read": () => ({ account: { type }, requiresOpenaiAuth: true }) });
      await adapter.connect();
      expect(adapter.describeAuthentication().issue).toBe("method_not_permitted");
      const started = await start(adapter);
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.error.code).toBe("configuration");
    }
  });

  it("runs Codex's own sign-in for an offered method, then asks Codex again", async () => {
    let signedIn = false;
    const { adapter, logins } = setup(
      { "account/read": () => (signedIn ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true }) },
      {
        login: async () => {
          signedIn = true;
          return "completed";
        },
      }
    );
    await adapter.connect();
    expect(adapter.describeAuthentication().state).toBe("required");
    const result = await adapter.authenticate("chatgpt");
    expect(result.ok).toBe(true);
    expect(adapter.describeAuthentication().state).toBe("authenticated");
    expect(logins).toEqual([]); // the injected login above, not the default recorder
  });

  it("refuses a method Hubble does not offer — the id never reaches a sign-in program", async () => {
    const { adapter, logins } = setup();
    for (const methodId of ["apikey", "__proto__", "chatgpt --with-api-key"]) {
      const result = await adapter.authenticate(methodId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid-request");
    }
    expect(logins).toEqual([]);
  });

  it("maps a failed, cancelled or timed-out sign-in to a failure, never to signed in", async () => {
    const outcomes: [Awaited<ReturnType<AppServerLogin>>, string][] = [
      ["failed", "configuration"],
      ["timeout", "timeout"],
      ["unavailable", "unreachable"],
    ];
    for (const [outcome, code] of outcomes) {
      const { adapter } = setup(
        { "account/read": () => ({ account: null, requiresOpenaiAuth: true }) },
        { login: async () => outcome }
      );
      const result = await adapter.authenticate("chatgpt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
      expect(adapter.describeAuthentication().state).not.toBe("authenticated");
    }
  });

  it("will not start a session for a signed-out Codex, and opens no thread", async () => {
    const { adapter, codex } = setup({ "account/read": () => ({ account: null, requiresOpenaiAuth: true }) });
    const started = await start(adapter);
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.code).toBe("configuration");
    expect(sent(codex, "thread/start")).toHaveLength(0);
    expect(codex.closed).toBe(1);
  });

  it("marks the sign-in required when a turn fails as unauthorized", async () => {
    const { adapter, codex, events } = setup(
      turnHandler(async (ctx) => {
        ctx.notify("turn/completed", turnCompleted("failed", { message: "401", codexErrorInfo: "unauthorized", additionalDetails: null }));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "hi", context: { attachments: [] } } as never);
    await flush();
    expect(adapter.describeAuthentication().state).toBe("required");
    expect(events.at(-1)?.summary).toBe("The agent needs to be signed in again.");
    expect(codex.closed).toBe(0);
  });
});

describe("the handshake", () => {
  it("introduces itself on the stable protocol only", async () => {
    const { adapter, codex } = setup();
    await adapter.connect();
    const init = sent(codex, "initialize")[0].params as Record<string, unknown>;
    expect(init).toMatchObject({ clientInfo: { name: "hubble" }, capabilities: { experimentalApi: false } });
    expect(sent(codex, "initialized")).toHaveLength(1);
  });

  it("refuses a Codex older than the verified version, and one that does not say", async () => {
    for (const userAgent of ["hubble/0.158.9 (Windows)", "hubble (Windows)", ""]) {
      const { adapter, codex } = setup({ initialize: () => ({ userAgent }) });
      const connected = await adapter.connect();
      expect(connected.ok).toBe(false);
      expect(sent(codex, "account/read")).toHaveLength(0);
      expect(codex.closed).toBe(1);
    }
  });

  it("accepts a newer Codex — whose replies are still held to every check", async () => {
    const { adapter } = setup({ initialize: () => ({ userAgent: "hubble/0.160.0 (Windows)" }) });
    expect((await adapter.connect()).ok).toBe(true);
  });

  it("says plainly when Codex is not installed, and when Hubble's Codex folder is unsafe", async () => {
    const missing = setup({}, { fail: "not-installed" });
    await missing.adapter.connect();
    expect(missing.adapter.getConnectionStatus().kind).toBe("unavailable");

    const unsafe = setup({}, { fail: "unsafe-home" });
    const connected = await unsafe.adapter.connect();
    expect(connected.ok).toBe(false);
    expect(unsafe.adapter.getConnectionStatus().detail).toMatch(/approval rules/);
  });

  it("fails a handshake that never answers as a timeout, not a hang", async () => {
    const { adapter } = setup(
      { initialize: () => new Promise(() => {}) },
      {
        setTimer: (callback, ms) => (ms >= 30_000 ? (queueMicrotask(callback), 1) : setTimeout(callback, ms)),
        clearTimer: () => {},
      }
    );
    const connected = await adapter.connect();
    expect(connected.ok).toBe(false);
    if (!connected.ok) expect(connected.error.code).toBe("timeout");
    expect(adapter.getConnectionStatus().kind).toBe("error");
  });
});

describe("sessions", () => {
  it("declares sessions only where Hubble verified the approvals", () => {
    expect(setup().adapter.getCapabilities()).toBe(CODEX_CAPABILITIES);
    const unverified = setup({}, { platformVerified: false }).adapter;
    expect([...unverified.getCapabilities()]).toEqual([]);
    expect(unverified.getCapabilities()).toBe(CODEX_REACH_ONLY_CAPABILITIES);
  });

  it("refuses a session where the approvals are unverified, before launching anything", async () => {
    const { adapter, codex } = setup({}, { platformVerified: false });
    const started = await start(adapter);
    expect(started.ok).toBe(false);
    expect(codex.launches).toHaveLength(0);
  });

  it("starts the thread in the project with the asking settings, and checks Codex applied them", async () => {
    const { adapter, codex, events } = setup();
    const started = await start(adapter);
    expect(started).toEqual({ ok: true, value: { sessionId: "s1", providerSessionId: THREAD_ID, status: "ready" } });
    expect(codex.launches).toEqual([{ projectPath: ROOT }]);
    expect(sent(codex, "thread/start")[0].params).toEqual({
      cwd: ROOT,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ephemeral: true,
    });
    expect(events.map((event) => event.kind)).toEqual(["session_started"]);
  });

  it("never drives a thread whose settings Codex did not apply", async () => {
    for (const reply of [
      { ...askingThread(), approvalPolicy: "on-request" },
      { ...askingThread(), approvalPolicy: "never" },
      { ...askingThread(), approvalsReviewer: "auto_review" },
      { ...askingThread(), sandbox: { type: "dangerFullAccess" } },
      { ...askingThread(), sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: true } },
    ]) {
      const { adapter, codex } = setup({ "thread/start": () => reply });
      const started = await start(adapter);
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.error.code).toBe("approval-unenforceable");
      expect(codex.closed).toBe(1);
      expect(sent(codex, "turn/start")).toHaveLength(0);
    }
  });

  it("re-sends the asking settings on every turn", async () => {
    const { adapter, codex } = setup();
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "hello", context: { attachments: [] } } as never);
    expect(sent(codex, "turn/start")[0].params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("ends a session whose approval settings change underneath it", async () => {
    const { adapter, codex, events } = setup();
    await start(adapter);
    codex.context().notify("thread/settings/updated", {
      threadId: THREAD_ID,
      threadSettings: { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } },
    });
    await flush();
    expect(events.at(-1)).toMatchObject({ kind: "error", summary: "Codex's approval settings changed, so Hubble stopped it." });
    expect(codex.closed).toBe(1);
  });

  it("streams a reply and ends the turn", async () => {
    const { adapter, events } = setup(
      turnHandler(async (ctx) => {
        ctx.notify(...itemNote("item/started", { type: "agentMessage", id: "m1", text: "" }));
        ctx.notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId: TURN_ID, itemId: "m1", delta: "Hel" });
        ctx.notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId: TURN_ID, itemId: "m1", delta: "lo" });
        ctx.notify(...itemNote("item/completed", { type: "agentMessage", id: "m1", text: "Hello" }));
        ctx.notify("turn/completed", turnCompleted("completed"));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "hi", context: { attachments: [] } } as never);
    await flush(20);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("message_received");
    expect(kinds.at(-1)).toBe("run_completed");
    expect(events.find((event) => event.kind === "message_received")?.text).toBe("Hello");
    for (const event of events) expect(isWellFormedControlEvent(event)).toBe(true);
  });
});

describe("command approvals", () => {
  async function commandSession(decide: "granted" | "denied") {
    let reply: { result?: unknown } | undefined;
    const { adapter, codex, events } = setup(
      turnHandler(async (ctx) => {
        ctx.notify(...itemNote("item/started", commandItem("call_1", "inProgress")));
        reply = await ctx.ask("item/commandExecution/requestApproval", commandApproval("call_1"));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "read notes", context: { attachments: [] } } as never);
    await flush();
    const requested = events.find((event) => event.kind === "approval_requested");
    expect(requested?.approvalId).toBeDefined();
    const details = adapter.takeApprovalDetails(requested!.approvalId!);
    await adapter.respondToApproval(requested!.approvalId!, decide);
    await flush();
    return { adapter, codex, events, details, reply: () => reply };
  }

  it("raises a run_command approval carrying the complete command, exactly as Codex will run it", async () => {
    const { details } = await commandSession("denied");
    expect(details).toMatchObject({
      sessionId: "s1",
      action: "run_command",
      scope: "run_commands",
      projectId: "p1",
      command: {
        commandLine: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content notes.txt'",
        workingDirectory: ".",
        insideProject: true,
      },
    });
  });

  it("answers an approval with Codex's one-time accept, and a denial with decline — never a standing grant", async () => {
    const granted = await commandSession("granted");
    expect(granted.reply()?.result).toEqual({ decision: "accept" });
    expect(granted.events.some((event) => event.kind === "command_started")).toBe(true);

    const denied = await commandSession("denied");
    expect(denied.reply()?.result).toEqual({ decision: "decline" });
    expect(denied.events.some((event) => event.kind === "command_started")).toBe(false);
  });

  it("shows a command running outside the project with its full path, flagged", async () => {
    const { adapter, events } = setup(
      turnHandler(async (ctx) => {
        void ctx.ask("item/commandExecution/requestApproval", commandApproval("call_2", { cwd: "C:\\Users\\me" }));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush();
    const details = adapter.takeApprovalDetails(events.find((event) => event.kind === "approval_requested")!.approvalId!);
    expect(details).toMatchObject({ command: { workingDirectory: "C:\\Users\\me", insideProject: false } });
  });

  it("carries a network destination Codex asked for", async () => {
    const { adapter, events } = setup(
      turnHandler(async (ctx) => {
        void ctx.ask(
          "item/commandExecution/requestApproval",
          commandApproval("call_3", { networkApprovalContext: { host: "example.com", protocol: "https" } })
        );
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush();
    const details = adapter.takeApprovalDetails(events.find((event) => event.kind === "approval_requested")!.approvalId!);
    expect(details?.command?.network).toEqual({ host: "example.com", protocol: "https" });
  });

  it("declines, without asking anyone, a command outside the grant, input to a running process, or one too long to show", async () => {
    const cases: [AgentPermissionScope[], Record<string, unknown>][] = [
      [["read_project"], {}],
      [["read_project", "run_commands"], { kind: "writeStdin" }],
      [["read_project", "run_commands"], { command: "x".repeat(9_000) }],
      [["read_project", "run_commands"], { command: "" }],
    ];
    for (const [scopes, patch] of cases) {
      let reply: { result?: unknown } | undefined;
      const { adapter, events } = setup(
        turnHandler(async (ctx) => {
          reply = await ctx.ask("item/commandExecution/requestApproval", commandApproval("call_x", patch));
        })
      );
      await start(adapter, { scopes });
      await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
      await flush();
      expect(reply?.result).toEqual({ decision: "decline" });
      expect(events.some((event) => event.kind === "approval_requested")).toBe(false);
    }
  });

  it("carries no command line on any control event", async () => {
    const { events } = await commandSession("granted");
    for (const event of events) expect(JSON.stringify(event)).not.toContain("Get-Content");
  });
});

describe("enforcement: nothing runs without Hubble's approval", () => {
  async function running(script: (ctx: import("./__fixtures__/fake-codex").FakeCodexContext) => Promise<void>) {
    const setupResult = setup(turnHandler(script));
    await start(setupResult.adapter);
    await setupResult.adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush(20);
    return setupResult;
  }

  it("stops the session when a command produces output without an approval", async () => {
    const { events, codex } = await running(async (ctx) => {
      ctx.notify(...itemNote("item/started", commandItem("call_1", "inProgress")));
      ctx.notify("item/commandExecution/outputDelta", { threadId: THREAD_ID, turnId: TURN_ID, itemId: "call_1", delta: "aGk=" });
    });
    expect(events.at(-1)).toMatchObject({ kind: "error", summary: "Codex acted without your approval, so Hubble stopped it." });
    expect(codex.closed).toBe(1);
  });

  it("stops the session when a command completes without an approval — completed or failed", async () => {
    for (const status of ["completed", "failed"]) {
      const { events, codex } = await running(async (ctx) => {
        ctx.notify(...itemNote("item/started", commandItem("call_1", "inProgress")));
        ctx.notify(...itemNote("item/completed", commandItem("call_1", status, { exitCode: 0 })));
      });
      expect(events.at(-1)?.summary).toBe("Codex acted without your approval, so Hubble stopped it.");
      expect(codex.closed).toBe(1);
    }
  });

  it("treats a declined command as nothing having run", async () => {
    let answer: { result?: unknown } | undefined;
    const setupResult = setup(
      turnHandler(async (ctx) => {
        ctx.notify(...itemNote("item/started", commandItem("call_1", "inProgress")));
        answer = await ctx.ask("item/commandExecution/requestApproval", commandApproval("call_1"));
        ctx.notify(...itemNote("item/completed", commandItem("call_1", "declined")));
        ctx.notify("turn/completed", turnCompleted("completed"));
      })
    );
    await start(setupResult.adapter);
    await setupResult.adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush();
    const approvalId = setupResult.events.find((event) => event.kind === "approval_requested")!.approvalId!;
    await setupResult.adapter.respondToApproval(approvalId, "denied");
    await flush(20);
    expect(answer?.result).toEqual({ decision: "decline" });
    expect(setupResult.events.some((event) => event.kind === "error")).toBe(false);
    expect(setupResult.events.some((event) => event.kind === "command_started")).toBe(false);
    expect(setupResult.events.at(-1)?.kind).toBe("run_completed");
    expect(setupResult.codex.closed).toBe(0);
  });

  it("stops the session for any surface Hubble switched off", async () => {
    for (const type of ["webSearch", "imageView", "imageGeneration", "collabAgentToolCall", "subAgentActivity", "dynamicToolCall", "hookPrompt"]) {
      const { events, codex } = await running(async (ctx) => {
        ctx.notify(...itemNote("item/started", { type, id: "x1" }));
      });
      expect(events.at(-1)?.summary).toBe("Codex tried to use a tool Hubble keeps switched off, so Hubble stopped it.");
      expect(codex.closed).toBe(1);
    }
  });

  it("stops the session when a hook or an automatic reviewer starts", async () => {
    for (const method of ["hook/started", "item/autoApprovalReview/started"]) {
      const { codex } = await running(async (ctx) => {
        ctx.notify(method, { threadId: THREAD_ID, turnId: TURN_ID });
      });
      expect(codex.closed).toBe(1);
    }
  });

  it("stops the session when a file change is applied without an approval", async () => {
    const { codex } = await running(async (ctx) => {
      const item = { type: "fileChange", id: "p1", changes: [{ path: `${ROOT}/a.txt`, kind: { type: "update", move_path: null }, diff: "" }], status: "inProgress" };
      ctx.notify(...itemNote("item/started", item));
      ctx.notify(...itemNote("item/completed", { ...item, status: "completed" }));
    });
    expect(codex.closed).toBe(1);
  });
});

describe("other requests Codex can make", () => {
  it("never grants more permissions, user input, a dynamic tool or a token refresh", async () => {
    const replies: Record<string, { result?: unknown; error?: unknown }> = {};
    const { adapter } = setup(
      turnHandler(async (ctx) => {
        replies.permissions = await ctx.ask("item/permissions/requestApproval", {
          threadId: THREAD_ID, turnId: TURN_ID, itemId: "i", environmentId: null, startedAtMs: 1, cwd: ROOT, reason: null,
          permissions: { network: { enabled: true }, fileSystem: { read: ["C:/"], write: ["C:/"] } },
        });
        replies.input = await ctx.ask("item/tool/requestUserInput", { threadId: THREAD_ID, questions: [] });
        replies.tool = await ctx.ask("item/tool/call", { threadId: THREAD_ID });
        replies.refresh = await ctx.ask("account/chatgptAuthTokens/refresh", { reason: "unauthorized" });
        replies.legacy = await ctx.ask("execCommandApproval", { conversationId: THREAD_ID, command: ["x"] });
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush(20);
    expect(replies.permissions.result).toEqual({ permissions: {}, scope: "turn" });
    expect(replies.input.error).toBeDefined();
    expect(replies.tool.error).toBeDefined();
    expect(replies.refresh.error).toBeDefined();
    expect(replies.legacy.result).toEqual({ decision: "denied" });
  });

  it("asks about a file change inside the project, and declines one outside it or asking for a standing root", async () => {
    const outcomes: unknown[] = [];
    for (const [path, extra] of [
      [`${ROOT}/src/a.ts`, {}],
      ["C:/Users/me/secret.txt", {}],
      [`${ROOT}/src/a.ts`, { grantRoot: ROOT }],
    ] as const) {
      let reply: { result?: unknown } | undefined;
      const { adapter, events } = setup(
        turnHandler(async (ctx) => {
          ctx.notify(...itemNote("item/started", { type: "fileChange", id: "p1", changes: [{ path, kind: { type: "update", move_path: null }, diff: "" }], status: "inProgress" }));
          reply = await ctx.ask("item/fileChange/requestApproval", { threadId: THREAD_ID, turnId: TURN_ID, itemId: "p1", startedAtMs: 1, ...extra });
        })
      );
      await start(adapter);
      await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
      await flush();
      const requested = events.find((event) => event.kind === "approval_requested");
      outcomes.push(requested ? adapter.takeApprovalDetails(requested.approvalId!)?.targets : reply?.result);
    }
    expect(outcomes).toEqual([["src/a.ts"], { decision: "decline" }, { decision: "decline" }]);
  });
});

describe("Hubble's context server (MCP)", () => {
  function mcpItem(id: string, status: string, server = SERVER_NAME, tool = "get_workspace") {
    return { type: "mcpToolCall", id, server, tool, status, arguments: {}, readOnlyHint: true, result: null, error: null };
  }
  function elicitation(serverName = SERVER_NAME) {
    return {
      threadId: THREAD_ID, turnId: TURN_ID, serverName, mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_description: "…", tool_params: {} },
      message: 'Allow the server to run tool "get_workspace"?', requestedSchema: { type: "object", properties: {} },
    };
  }

  it("hands Codex the session's context server in thread/start, with prompt-on-every-call, token in-protocol", async () => {
    const { adapter, codex } = setup();
    await start(adapter, { context: true });
    const params = sent(codex, "thread/start")[0].params as Record<string, unknown>;
    expect(params.config).toEqual({
      mcp_servers: {
        [SERVER_NAME]: {
          url: CONTEXT_SERVER.url,
          http_headers: { Authorization: `Bearer ${CONTEXT_SERVER.token}` },
          default_tools_approval_mode: "prompt",
        },
      },
    });
    // The launch itself carries nothing of it.
    expect(codex.launches).toEqual([{ projectPath: ROOT }]);
  });

  it("answers this session's context call with Hubble's decision, and Codex receives the result", async () => {
    let reply: { result?: unknown } | undefined;
    const { adapter, codex, events } = setup(
      turnHandler(async (ctx) => {
        ctx.notify(...itemNote("item/started", mcpItem("m1", "inProgress")));
        reply = await ctx.ask("mcpServer/elicitation/request", elicitation());
        ctx.notify(...itemNote("item/completed", mcpItem("m1", "completed")));
        ctx.notify("turn/completed", turnCompleted("completed"));
      })
    );
    await start(adapter, { context: true });
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush(20);
    expect(reply?.result).toEqual({ action: "accept", content: {}, _meta: null });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["tool_started", "tool_finished", "run_completed"]));
    expect(codex.closed).toBe(0);
  });

  it("declines a call to any other server, or with no context bound — and nothing runs", async () => {
    for (const [context, server] of [[true, "someone_else"], [false, SERVER_NAME]] as const) {
      let reply: { result?: unknown } | undefined;
      const { adapter } = setup(
        turnHandler(async (ctx) => {
          ctx.notify(...itemNote("item/started", mcpItem("m1", "inProgress", server)));
          reply = await ctx.ask("mcpServer/elicitation/request", elicitation(server));
        })
      );
      await start(adapter, { context });
      await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
      await flush(20);
      expect(reply?.result).toEqual({ action: "decline", content: null, _meta: null });
    }
  });

  it("declines a context call when the session holds no context capability", async () => {
    let reply: { result?: unknown } | undefined;
    const { adapter } = setup(
      turnHandler(async (ctx) => {
        ctx.notify(...itemNote("item/started", mcpItem("m1", "inProgress")));
        reply = await ctx.ask("mcpServer/elicitation/request", elicitation());
      })
    );
    const proj = project();
    await adapter.createSession({
      sessionId: "s1",
      project: proj,
      permissions: proj.permissions,
      attachments: [],
      contextServer: { ...CONTEXT_SERVER, capabilities: [] },
    });
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush(20);
    expect(reply?.result).toEqual({ action: "decline", content: null, _meta: null });
  });

  it("stops the session when an MCP call completes that nobody approved", async () => {
    const setupResult = setup(
      turnHandler(async (ctx) => {
        ctx.notify(...itemNote("item/started", mcpItem("m1", "inProgress")));
        ctx.notify(...itemNote("item/completed", mcpItem("m1", "completed")));
      })
    );
    await start(setupResult.adapter, { context: true });
    await setupResult.adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush(20);
    expect(setupResult.codex.closed).toBe(1);
  });

  it("stops the session when an MCP resource read succeeds — Hubble never approved one", async () => {
    // `read_mcp_resource` raises no elicitation, so nothing Hubble shows can
    // approve it. The context server refuses every resource operation
    // (session-context/resources.security.test.ts); should one ever succeed,
    // it was unapproved, and the session stops.
    for (const tool of ["read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"]) {
      const setupResult = setup(
        turnHandler(async (ctx) => {
          ctx.notify(...itemNote("item/started", mcpItem("m1", "inProgress", SERVER_NAME, tool)));
          ctx.notify(...itemNote("item/completed", mcpItem("m1", "completed", SERVER_NAME, tool)));
        })
      );
      await start(setupResult.adapter, { context: true });
      await setupResult.adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
      await flush(20);
      expect(setupResult.events.at(-1)).toMatchObject({ kind: "error", summary: "Codex acted without your approval, so Hubble stopped it." });
      expect(setupResult.codex.closed).toBe(1);
    }
  });

  it("lets an MCP call the server refused fail quietly — nothing ran", async () => {
    const setupResult = setup(
      turnHandler(async (ctx) => {
        ctx.notify(...itemNote("item/started", mcpItem("m1", "inProgress", SERVER_NAME, "read_mcp_resource")));
        ctx.notify(...itemNote("item/completed", mcpItem("m1", "failed", SERVER_NAME, "read_mcp_resource")));
      })
    );
    await start(setupResult.adapter, { context: true });
    await setupResult.adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush(20);
    expect(setupResult.codex.closed).toBe(0);
  });
});

describe("lifecycle", () => {
  it("cancelling a run declines what is pending, then interrupts the turn", async () => {
    let reply: { result?: unknown } | undefined;
    const { adapter, codex } = setup(
      turnHandler(async (ctx) => {
        reply = await ctx.ask("item/commandExecution/requestApproval", commandApproval("call_1"));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush();
    expect((await adapter.cancelRun("s1")).ok).toBe(true);
    await flush();
    expect(reply?.result).toEqual({ decision: "decline" });
    expect(sent(codex, "turn/interrupt")[0].params).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
  });

  it("an interrupted turn is reported as cancelled", async () => {
    const { adapter, events } = setup(
      turnHandler(async (ctx) => {
        ctx.notify("turn/completed", turnCompleted("interrupted"));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush();
    expect(events.at(-1)?.kind).toBe("run_cancelled");
  });

  it("process death ends the session with one sentence, and a late approval changes nothing", async () => {
    const { adapter, codex, events } = setup(
      turnHandler(async (ctx) => {
        void ctx.ask("item/commandExecution/requestApproval", commandApproval("call_1"));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush();
    const approvalId = events.find((event) => event.kind === "approval_requested")!.approvalId!;
    codex.crash();
    await flush();
    expect(events.at(-1)).toMatchObject({ kind: "error", summary: "Agent disconnected unexpectedly." });
    const late = await adapter.respondToApproval(approvalId, "granted");
    expect(late.ok).toBe(false);
    expect((await adapter.sendMessage({ sessionId: "s1", text: "again", context: { attachments: [] } } as never)).ok).toBe(false);
  });

  it("releasing a session with an approval pending ends the process — the command can never be accepted", async () => {
    const { adapter, codex, events } = setup(
      turnHandler(async (ctx) => {
        void ctx.ask("item/commandExecution/requestApproval", commandApproval("call_1"));
      })
    );
    await start(adapter);
    await adapter.sendMessage({ sessionId: "s1", text: "x", context: { attachments: [] } } as never);
    await flush();
    const approvalId = events.find((event) => event.kind === "approval_requested")!.approvalId!;
    adapter.releaseSession("s1");
    await flush();
    // The process that asked is gone, so nothing it asked about can run; and
    // a late "yes" finds nothing to answer.
    expect(codex.closed).toBe(1);
    expect(codex.released).toBe(1);
    expect(adapter.takeApprovalDetails(approvalId)).toBeUndefined();
    expect((await adapter.respondToApproval(approvalId, "granted")).ok).toBe(false);
    expect(codex.received.some((message) => JSON.stringify(message.result ?? null).includes("accept"))).toBe(false);
    expect(adapter.providerSessionIdFor("s1")).toBeUndefined();
  });

  it("disconnect ends every session; a new session can be started afterwards", async () => {
    const { adapter, codex } = setup();
    await start(adapter);
    await adapter.disconnect();
    expect(codex.closed).toBe(1);
    const again = await start(adapter);
    expect(again.ok).toBe(true);
  });

  it("a thread/start that fails leaves nothing running", async () => {
    const { adapter, codex } = setup({
      "thread/start": () => {
        throw new CodexError(-32603);
      },
    });
    const started = await start(adapter);
    expect(started.ok).toBe(false);
    expect(codex.closed).toBe(1);
    expect(codex.released).toBe(1);
  });
});

describe("workspace binding", () => {
  it("answers a context call from the session's own authority only", async () => {
    // Two sessions, two servers: a call naming the other session's server is declined.
    const replies: unknown[] = [];
    const codex = createFakeCodex({
      "thread/start": (params) => askingThread(Object.keys((params.config as { mcp_servers: object })?.mcp_servers ?? {})[0] === SERVER_NAME ? "t-a" : "t-b"),
    });
    const adapter = createCodexControlAdapter({
      provider: "openai-codex",
      launch: codex.launcher,
      login: async () => "completed",
      loginMethods: [],
      platformVerified: true,
      minimumVersion: "0.159.0",
    });
    const proj = project();
    await adapter.createSession({ sessionId: "a", project: proj, permissions: proj.permissions, attachments: [], contextServer: CONTEXT_SERVER });
    const ctxA = codex.context();
    await adapter.createSession({
      sessionId: "b",
      project: proj,
      permissions: proj.permissions,
      attachments: [],
      contextServer: { ...CONTEXT_SERVER, name: "tabdump_qrstuvwxyz234567", workspaceId: "ws-other" },
    });
    // Session A's process asks about session B's server.
    ctxA.notify(...itemNote("item/started", { type: "mcpToolCall", id: "m1", server: "tabdump_qrstuvwxyz234567", tool: "x", status: "inProgress" }, "t-a"));
    replies.push(
      (await ctxA.ask("mcpServer/elicitation/request", {
        threadId: "t-a", turnId: null, serverName: "tabdump_qrstuvwxyz234567", mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call" }, message: "", requestedSchema: {},
      })).result
    );
    expect(replies).toEqual([{ action: "decline", content: null, _meta: null }]);
  });
});
