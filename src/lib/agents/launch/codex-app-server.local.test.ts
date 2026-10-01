import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexControlAdapter } from "@/lib/agents/control/providers/codex-app-server/adapter";
import { createGrant } from "@/lib/agents/control/permissions";
import { createProject } from "@/lib/agents/control/projects";
import { launchEntryFor } from "./allowlist";
import { CODEX_HOME_CONFIG } from "./codex-home";
import { createAppServerProcessLauncher } from "./process";
import type { AgentControlEvent } from "@/lib/agents/control/events";
import type { AgentPermissionScope } from "@/lib/agents/control/permissions";
import type { AppServerLauncher } from "@/lib/agents/control/providers/codex-app-server/launcher";
import type { SessionContextCapability } from "@/lib/agents/session-context/capabilities";

/**
 * Hubble's Codex integration against the REAL `codex app-server`.
 *
 * Opt-in: `HUBBLE_CODEX_PREFIX=<npm global prefix holding @openai/codex>`.
 * Runs the production launcher (allowlisted executable, literal arguments,
 * allowlisted environment, Hubble's own Codex folder) and the production
 * adapter. Two things only are test scaffolding, and both are outside Codex:
 *
 *   - the **model** is a scripted Responses API on loopback, named in the
 *     test's Codex folder, so every tool call Codex receives is chosen here;
 *   - **sign-in**: that scripted model needs none, so the one `account/read`
 *     reply is rewritten to a ChatGPT account. Nothing else is touched.
 *
 * Everything that decides whether something runs — the approval requests,
 * their refusal, the sandbox, the disabled tools — is Codex's own behaviour.
 * Every command is harmless and runs in a scratch project.
 */

const PREFIX = process.env.HUBBLE_CODEX_PREFIX;
const run = PREFIX ? describe : describe.skip;
const T0 = 1_700_000_000_000;

type Step = { call: { id: string; name: string; namespace?: string; args: Record<string, unknown> } } | { text: string };

function startModel() {
  const queue: (Step | ((requests: Record<string, unknown>[]) => Step))[] = [];
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = (() => {
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      requests.push(json);
      if (!req.url?.includes("/responses")) return void res.writeHead(404).end("{}");
      const next = queue.shift() ?? { text: "done" };
      const step = typeof next === "function" ? next(requests) : next;
      const id = `resp_${requests.length}`;
      const item =
        "call" in step
          ? {
              type: "function_call",
              id: `fc_${requests.length}`,
              call_id: step.call.id,
              name: step.call.name,
              ...(step.call.namespace ? { namespace: step.call.namespace } : {}),
              arguments: JSON.stringify(step.call.args),
            }
          : { type: "message", role: "assistant", id: `msg_${requests.length}`, content: [{ type: "output_text", text: step.text }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
      ]) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise<{ port: number; queue: typeof queue; requests: typeof requests; close(): void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as { port: number }).port, queue, requests, close: () => server.close() })
    )
  );
}

/** What Codex handed back to the model for a call. */
function outputFor(requests: Record<string, unknown>[], callId: string): string | undefined {
  for (const request of requests) {
    for (const item of (request.input as Record<string, unknown>[] | undefined) ?? []) {
      if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && item.call_id === callId) {
        return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      }
    }
  }
  return undefined;
}

/** Tools Codex offered the model on its most recent request. */
function toolNames(requests: Record<string, unknown>[]): string[] {
  const tools = (requests.at(-1)?.tools as Record<string, unknown>[] | undefined) ?? [];
  return tools.map((tool) => String(tool.name ?? tool.type));
}

/** A stand-in for the session's context server: streamable-HTTP MCP, bearer-authenticated. */
function startContextServer(token: string) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      const message = JSON.parse(body || "{}") as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.id === undefined) return void res.writeHead(202).end();
      let result: unknown = {};
      if (message.method === "initialize") {
        result = { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hubble", version: "1" } };
      } else if (message.method === "tools/list") {
        result = {
          tools: [{ name: "get_workspace", description: "Overview", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
        };
      } else if (message.method === "tools/call") {
        calls.push(String(message.params?.name));
        result = { content: [{ type: "text", text: "WORKSPACE-OVERVIEW-5512" }] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return new Promise<{ url: string; calls: string[]; close(): void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, calls, close: () => server.close() })
    )
  );
}

/** The one piece of sign-in scaffolding: `account/read` answered as a ChatGPT account. */
function signedIn(launcher: AppServerLauncher): AppServerLauncher {
  return async (request) => {
    const launched = await launcher(request);
    if (!launched.ok) return launched;
    const accountReads = new Set<number>();
    const inner = launched.transport;
    return {
      ...launched,
      transport: {
        send(line) {
          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.method === "account/read" && typeof message.id === "number") accountReads.add(message.id);
          inner.send(line);
        },
        onLine(listener) {
          return inner.onLine((line) => {
            const message = JSON.parse(line) as { id?: number; result?: unknown };
            if (typeof message.id === "number" && accountReads.has(message.id) && !("method" in message)) {
              accountReads.delete(message.id);
              listener(JSON.stringify({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } }));
              return;
            }
            listener(line);
          });
        },
        onClose: (listener) => inner.onClose(listener),
        close: () => inner.close(),
      },
    };
  };
}

/** Live `codex.exe` processes started from the test's Codex install. No inner double quotes: they do not survive argv quoting into PowerShell 5.1. */
function codexProcesses(): number {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'codex.exe' -and $_.ExecutablePath -like '${PREFIX}*' } | Measure-Object | Select-Object -ExpandProperty Count`,
    ],
    { encoding: "utf8" }
  );
  const count = Number(out.trim());
  if (!Number.isInteger(count)) throw new Error("could not count Codex processes");
  return count;
}

async function waitFor(predicate: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

run("Codex app-server, real (Codex 0.159)", () => {
  let scratch: string;
  let projectPath: string;
  let model: Awaited<ReturnType<typeof startModel>>;

  beforeAll(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "hubble-codex-it-"));
    projectPath = path.join(scratch, "project");
    mkdirSync(projectPath);
    writeFileSync(path.join(projectPath, "notes.txt"), "INSIDE-NOTES-7731");
    model = await startModel();
  });

  afterAll(() => {
    model?.close();
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows may hold the folder a moment after Codex exits.
    }
  });

  /** The production launcher, with the scripted model named in Hubble's own Codex folder. */
  function launcher(extraEnv: Record<string, string> = {}): AppServerLauncher {
    const env = { ...process.env, PATH: `${PREFIX};${process.env.PATH ?? ""}`, LOCALAPPDATA: path.join(scratch, "appdata"), ...extraEnv };
    const modelConfig = [
      `model_provider = "mock"`,
      `model = "gpt-5-codex"`,
      `[model_providers.mock]`,
      `name = "mock"`,
      `base_url = "http://127.0.0.1:${model.port}/v1"`,
      `wire_api = "responses"`,
      `requires_openai_auth = false`,
      `stream_max_retries = 0`,
      `request_max_retries = 0`,
    ].join("\n");
    return signedIn(
      createAppServerProcessLauncher({
        provider: "openai-codex",
        env,
        homeFs: {
          makeDirectory: (directory) => mkdirSync(directory, { recursive: true }),
          readText: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
          // Hubble's settings, then the test's model — Hubble's rewrite still runs every launch.
          writeText: (file, text) => writeFileSync(file, `${text}\n${text === CODEX_HOME_CONFIG ? modelConfig : ""}\n`),
          list: (directory) => (existsSync(directory) ? readdirSync(directory) : undefined),
        },
      })
    );
  }

  function adapterWith(launch: AppServerLauncher) {
    const entry = launchEntryFor("openai-codex")!.appServer!;
    const adapter = createCodexControlAdapter({
      provider: "openai-codex",
      launch,
      login: async () => "unavailable",
      loginMethods: [],
      platformVerified: entry.verifiedPlatforms.includes(process.platform),
      minimumVersion: entry.minimumVersion,
    });
    const events: AgentControlEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));
    return { adapter, events };
  }

  async function session(
    adapter: ReturnType<typeof createCodexControlAdapter>,
    options: { scopes?: AgentPermissionScope[]; context?: { url: string; token: string; capabilities: SessionContextCapability[] } } = {}
  ) {
    const grant = createGrant(options.scopes ?? ["read_project", "write_project", "run_commands"], T0, "p1")!;
    const made = createProject({ id: "p1", name: "Scratch", path: projectPath, providers: ["openai-codex"], permissions: grant }, T0);
    if (!made.ok) throw new Error("project");
    const started = await adapter.createSession({
      sessionId: "s1",
      project: made.project,
      permissions: grant,
      attachments: [],
      ...(options.context
        ? { contextServer: { name: "tabdump_abcdefghijklmnop", url: options.context.url, token: options.context.token, workspaceId: "ws-1", capabilities: options.context.capabilities } }
        : {}),
    });
    expect(started.ok).toBe(true);
  }

  async function turn(
    adapter: ReturnType<typeof createCodexControlAdapter>,
    events: AgentControlEvent[],
    steps: (Step | ((requests: Record<string, unknown>[]) => Step))[],
    decide?: (approvalId: string) => "granted" | "denied"
  ) {
    model.queue.push(...steps, { text: "done" });
    const before = events.length;
    const answered = new Set<string>();
    expect((await adapter.sendMessage({ sessionId: "s1", text: "go", context: { attachments: [] } } as never)).ok).toBe(true);
    await waitFor(() => {
      for (const event of events.slice(before)) {
        if (event.kind === "approval_requested" && event.approvalId && decide && !answered.has(event.approvalId)) {
          answered.add(event.approvalId);
          void adapter.respondToApproval(event.approvalId, decide(event.approvalId));
        }
      }
      return events.slice(before).some((event) => ["run_completed", "run_cancelled", "error"].includes(event.kind));
    }, 90_000);
    return events.slice(before);
  }

  it("offers the model only the tools that pass through Hubble's approvals", async () => {
    const { adapter, events } = adapterWith(launcher());
    await session(adapter);
    await turn(adapter, events, []);
    expect(toolNames(model.requests).sort()).toEqual(["exec_command", "request_user_input", "write_stdin"]);
    adapter.dispose();
  }, 120_000);

  it("asks before every command, shows it whole, and never runs a declined one", async () => {
    const { adapter, events } = adapterWith(launcher());
    await session(adapter);
    const target = path.join(projectPath, "declined.txt");
    const seen: string[] = [];
    const turnEvents = await turn(
      adapter,
      events,
      [
        { call: { id: "c_read", name: "exec_command", args: { cmd: "Get-Content notes.txt" } } },
        { call: { id: "c_write", name: "exec_command", args: { cmd: "Set-Content -Path declined.txt -Value no" } } },
      ],
      (approvalId) => {
        seen.push(adapter.takeApprovalDetails(approvalId)?.command?.commandLine ?? "");
        return "denied";
      }
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("Get-Content notes.txt");
    expect(seen[0]).toMatch(/powershell\.exe/i);
    expect(seen[1]).toContain("Set-Content -Path declined.txt -Value no");
    expect(existsSync(target)).toBe(false);
    expect(outputFor(model.requests, "c_read")).toMatch(/rejected by user/);
    expect(turnEvents.some((event) => event.kind === "command_started")).toBe(false);
    adapter.dispose();
  }, 120_000);

  it("runs an approved command, and only that one", async () => {
    const { adapter, events } = adapterWith(launcher());
    await session(adapter);
    const target = path.join(projectPath, "approved.txt");
    await turn(
      adapter,
      events,
      [
        { call: { id: "c_ok", name: "exec_command", args: { cmd: "Get-Content notes.txt" } } },
        { call: { id: "c_make", name: "exec_command", args: { cmd: "Set-Content -Path approved.txt -Value yes" } } },
      ],
      () => "granted"
    );
    expect(outputFor(model.requests, "c_ok")).toContain("INSIDE-NOTES-7731");
    expect(existsSync(target)).toBe(true);
    adapter.dispose();
  }, 120_000);

  it("offers no terminal: tty is refused and stdin cannot reach an approved process", async () => {
    const { adapter, events } = adapterWith(launcher());
    await session(adapter);
    let approvals = 0;
    await turn(
      adapter,
      events,
      [
        { call: { id: "c_tty", name: "exec_command", args: { cmd: "cmd.exe", tty: true } } },
        { call: { id: "c_long", name: "exec_command", args: { cmd: "Start-Sleep -Seconds 4", yield_time_ms: 500 } } },
        (requests: Record<string, unknown>[]): Step => {
          const sid = Number(/session ID (\d+)/.exec(outputFor(requests, "c_long") ?? "")?.[1] ?? 0);
          return { call: { id: "c_stdin", name: "write_stdin", args: { session_id: sid, chars: "echo pwned> stdin.txt\r\n" } } };
        },
      ],
      () => {
        approvals += 1;
        return "granted";
      }
    );
    expect(outputFor(model.requests, "c_tty")).toMatch(/TTY execution is disabled/);
    expect(outputFor(model.requests, "c_stdin")).toMatch(/stdin is closed|Unknown process/);
    expect(existsSync(path.join(projectPath, "stdin.txt"))).toBe(false);
    // Only the sleep was asked about: the tty call never reached a process.
    expect(approvals).toBe(1);
    adapter.dispose();
  }, 120_000);

  it("refuses the switched-off tools outright, without asking and without acting", async () => {
    const { adapter, events } = adapterWith(launcher());
    await session(adapter);
    const picture = path.join(scratch, "outside.png");
    writeFileSync(picture, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const turnEvents = await turn(adapter, events, [
      { call: { id: "c_img", name: "view_image", args: { path: picture } } },
      { call: { id: "c_spawn", name: "spawn_agent", args: { message: "hi" } } },
      { call: { id: "c_goal", name: "create_goal", args: { objective: "x" } } },
    ]);
    for (const id of ["c_img", "c_spawn", "c_goal"]) expect(outputFor(model.requests, id)).toMatch(/unsupported call/);
    expect(turnEvents.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(turnEvents.at(-1)?.kind).toBe("run_completed");
    adapter.dispose();
  }, 120_000);

  it("routes a context-server call through Hubble's decision — allowed, and declined without a capability", async () => {
    const token = "tdctx_integration";
    const context = await startContextServer(token);
    try {
      for (const [capabilities, expectCall] of [
        [["workspace.read"], true],
        [[], false],
      ] as const) {
        const { adapter, events } = adapterWith(launcher());
        await session(adapter, { context: { url: context.url, token, capabilities: [...capabilities] } });
        const before = context.calls.length;
        await turn(adapter, events, [
          { call: { id: `c_mcp_${capabilities.length}`, name: "get_workspace", namespace: "mcp__tabdump_abcdefghijklmnop", args: {} } },
        ]);
        expect(toolNames(model.requests)).toContain("mcp__tabdump_abcdefghijklmnop");
        if (expectCall) {
          expect(context.calls.length).toBe(before + 1);
          expect(outputFor(model.requests, `c_mcp_${capabilities.length}`)).toContain("WORKSPACE-OVERVIEW-5512");
        } else {
          expect(context.calls.length).toBe(before);
          expect(outputFor(model.requests, `c_mcp_${capabilities.length}`)).toMatch(/rejected/);
        }
        adapter.dispose();
      }
    } finally {
      context.close();
    }
  }, 180_000);

  it("ignores the user's own CODEX_HOME — its allow rule cannot approve a command", async () => {
    const userHome = path.join(scratch, "user-codex");
    mkdirSync(path.join(userHome, "rules"), { recursive: true });
    writeFileSync(path.join(userHome, "rules", "default.rules"), 'prefix_rule(pattern=["Get-Content"], decision="allow")\n');
    const { adapter, events } = adapterWith(launcher({ CODEX_HOME: userHome }));
    await session(adapter);
    let asked = 0;
    await turn(adapter, events, [{ call: { id: "c_rule", name: "exec_command", args: { cmd: "Get-Content notes.txt" } } }], () => {
      asked += 1;
      return "denied";
    });
    expect(asked).toBe(1);
    expect(outputFor(model.requests, "c_rule")).toMatch(/rejected by user/);
    adapter.dispose();
  }, 120_000);

  it("refuses to start when Hubble's own Codex folder holds an approval rule", async () => {
    const home = path.join(scratch, "appdata", "Hubble", "codex");
    mkdirSync(path.join(home, "rules"), { recursive: true });
    writeFileSync(path.join(home, "rules", "default.rules"), 'prefix_rule(pattern=["Get-Content"], decision="allow")\n');
    try {
      const { adapter } = adapterWith(launcher());
      const connected = await adapter.connect();
      expect(connected.ok).toBe(false);
      expect(adapter.getConnectionStatus().detail).toMatch(/approval rules/);
    } finally {
      rmSync(path.join(home, "rules"), { recursive: true, force: true });
    }
  }, 60_000);

  it("interrupting with an approval pending runs nothing; ending the session ends Codex", async () => {
    const baseline = codexProcesses();
    const { adapter, events } = adapterWith(launcher());
    await session(adapter);
    model.queue.push({ call: { id: "c_pending", name: "exec_command", args: { cmd: "Set-Content -Path interrupted.txt -Value no" } } }, { text: "done" });
    await adapter.sendMessage({ sessionId: "s1", text: "go", context: { attachments: [] } } as never);
    await waitFor(() => events.some((event) => event.kind === "approval_requested"));
    expect(codexProcesses()).toBeGreaterThan(baseline);
    await adapter.cancelRun("s1");
    await waitFor(() => events.some((event) => event.kind === "run_cancelled"));
    expect(existsSync(path.join(projectPath, "interrupted.txt"))).toBe(false);

    adapter.releaseSession("s1");
    await waitFor(() => codexProcesses() === baseline, 20_000);

    // And a fresh session starts cleanly afterwards.
    await session(adapter);
    adapter.dispose();
    await waitFor(() => codexProcesses() === baseline, 20_000);
  }, 180_000);
});
