// @vitest-environment node
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { createRuntimeHost } from "@/lib/agents/runtime/host";
import { createSessionContextServer } from "@/lib/agents/session-context/http";
import { createSessionContextRegistry } from "@/lib/agents/session-context/registry";
import { launchEntryFor } from "./allowlist";
import { createAcpProcessLauncher } from "./process";
import type { RuntimeActor } from "@/lib/agents/runtime/host";
import type { ExecutionGateResult } from "@/lib/agents/runtime/gate";
import type { SessionContextServer } from "@/lib/agents/session-context/http";

/**
 * The ACP context path end to end, with nothing scripted in-process (J.4).
 *
 * A real agent process — the launch fixture, answering exactly as Gemini CLI
 * 0.61.0 does for an MCP call (kind `other`, no server identity, its MCP-only
 * option ids) and honouring `--allowed-mcp-server-names` — is started by the
 * real launcher from the real allowlist entry, driven by the real adapter and
 * host, and calls the real loopback MCP server with the credential it was
 * handed over stdin. What is not real is the model: the fixture decides which
 * tool to call from the prompt text.
 */

const FIXTURE = path.resolve(__dirname, "__fixtures__/fake-acp-agent.mjs");
const LOCAL: ExecutionGateResult = { allowed: true, environment: "local", kind: "local", decision: { allowed: true, kind: "local-server" } };
const ALICE: RuntimeActor = { id: "local" };

let root: string;
let bin: string;
let projectDir: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "tabdump-context-test-")));
  bin = path.join(root, "bin");
  projectDir = path.join(root, "work", "launch");
  mkdirSync(bin, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const pkg = path.join(bin, "node_modules", "@google", "gemini-cli");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  copyFileSync(FIXTURE, path.join(pkg, "dist", "index.mjs"));
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "dist/index.mjs" } }));
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "gemini.cmd"), "@echo off\r\nexit 1\r\n");
  } else {
    const launcher = path.join(bin, "gemini");
    writeFileSync(launcher, `#!${process.execPath}\nimport(${JSON.stringify(path.join(pkg, "dist", "index.mjs"))})\n`);
    chmodSync(launcher, 0o755);
  }
});

afterAll(async () => {
  // Windows keeps the directory locked for a moment after the agent
  // processes exit; the process-exit proof lives in process.test.ts.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}, 15_000);

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const LAUNCH_PLAN = {
  workspace: {
    id: "w-launch",
    name: "Launch Plan",
    createdAt: 1,
    updatedAt: 2,
    tabs: [
      { id: "t1", url: "https://example.com/pricing", normalizedUrl: "https://example.com/pricing", domain: "example.com", title: "Pricing research" },
      { id: "t2", url: "https://example.org/press", normalizedUrl: "https://example.org/press", domain: "example.org", title: "Press kit" },
    ],
  },
  collections: [],
  dependencies: [],
};

async function until(predicate: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function build(scopes: string[]) {
  const registry = createSessionContextRegistry({});
  const server = createSessionContextServer({ registry });
  servers.push(server);
  const entry = launchEntryFor("gemini")!.acp!;
  const adapter = createAcpControlAdapter({
    provider: "gemini",
    launch: createAcpProcessLauncher({ provider: "gemini", env: { PATH: bin, PATHEXT: ".EXE;.CMD", SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP } }),
    approval: entry.approval,
    contextIdentity: entry.contextIdentity,
  });
  const host = createRuntimeHost({
    gate: LOCAL,
    resolveAdapter: (provider) => (provider === "gemini" ? adapter : undefined),
    providers: ["gemini"],
    sessionContext: { registry, url: () => server.url() },
    runtimeId: "rt-ctx",
  });
  const send = async <T = Record<string, unknown>>(command: unknown) =>
    (await host.execute(ALICE, command as never)) as unknown as { ok: boolean; value?: T; error?: { code: string } };

  async function start() {
    await send({
      name: "authorize_projects",
      projects: [{ id: "p1", name: "Launch", path: projectDir, providers: ["gemini"], permissions: { scopes, projectId: "p1", grantedAt: 1 } }],
    });
    const created = await send<{ sessionId: string }>({
      name: "create_session",
      provider: "gemini",
      projectId: "p1",
      workspaceId: "w-launch",
      contextSnapshot: LAUNCH_PLAN,
    });
    if (!created.ok) throw new Error(`create_session: ${created.error?.code}`);
    return created.value!.sessionId;
  }

  /** Sends a turn and returns the agent's reply once the run completes. */
  async function turn(sessionId: string, text: string, during?: () => Promise<void>): Promise<string> {
    const before = ((await send<{ events: unknown[] }>({ name: "get_events", sessionId })).value?.events ?? []).length;
    await send({ name: "send_message", sessionId, text });
    if (during) await during();
    let reply = "";
    await until(async () => {
      const events = ((await send<{ events: { kind: string; text?: string }[] }>({ name: "get_events", sessionId })).value?.events ?? []).slice(before);
      const done = events.some((event) => event.kind === "run_completed" || event.kind === "error");
      reply = events.filter((event) => event.kind === "message_received").map((event) => event.text ?? "").join("");
      return done;
    });
    return reply;
  }

  return { host, registry, send, start, turn };
}

describe("an ACP agent using its session's Hubble context through a real process", () => {
  it("reads the workspace: the context call is recognised structurally and allowed once — no prompt, no enforcement", async () => {
    const h = build(["read_workspace", "read_project"]);
    const sessionId = await h.start();
    const reply = await h.turn(sessionId, 'context get_current_workspace {"maxTabs":10}');
    expect(reply).toMatch(/^context:proceed_once:/);
    expect(reply).toContain("Pricing research");
    const view = await h.send<{ session: { status: string }; approvals: unknown[] }>({ name: "get_session", sessionId });
    expect(view.value?.approvals).toEqual([]);
    expect(view.value?.session.status).not.toBe("failed");

    // Another workspace, asked for by id: refused by the server.
    const denied = await h.turn(sessionId, 'context get_workspace {"workspaceId":"w-private"}');
    expect(denied).toContain("This session can only read the Hubble workspace it was started from.");
    await h.host.dispose();
  }, 60_000);

  it("proposes a change: Hubble asks the user, and only an approved, applied change comes back as done", async () => {
    const h = build(["read_workspace", "read_project", "write_workspace"]);
    const sessionId = await h.start();
    const reply = await h.turn(sessionId, 'context create_collection {"name":"Launch reading","tabIds":["t1","t2"]}', async () => {
      let approvalId = "";
      await until(async () => {
        const view = await h.send<{ approvals: { approvalId: string; provider: string; change?: { subject: string } }[] }>({ name: "get_session", sessionId });
        const approval = view.value?.approvals?.[0];
        if (approval) {
          expect(approval).toMatchObject({ provider: "gemini", change: { subject: "Launch reading" } });
          approvalId = approval.approvalId;
        }
        return Boolean(approvalId);
      });
      await h.send({ name: "respond_to_approval", approvalId, decision: "granted" });
      let actionId = "";
      await until(async () => {
        const view = await h.send<{ session: { context: { pendingActions: { actionId: string }[] } } }>({ name: "get_session", sessionId });
        actionId = view.value?.session.context.pendingActions[0]?.actionId ?? "";
        return Boolean(actionId);
      });
      await h.send({ name: "complete_context_action", sessionId, actionId, outcome: { ok: true, collectionId: "c-new" } });
    });
    expect(reply).toMatch(/^context:proceed_once:/);
    expect(reply).toContain('"created":true');
    expect(reply).toContain('"collectionId":"c-new"');
    await h.host.dispose();
  }, 60_000);

  it("reads the summary and proposes a plan (J.5): the same approval, applied by the webview's batch, verified", async () => {
    const h = build(["read_workspace", "read_project", "write_workspace"]);
    const sessionId = await h.start();
    const summary = await h.turn(sessionId, "context get_workspace_summary {}");
    expect(summary).toMatch(/^context:proceed_once:/);
    expect(summary).toContain('"uncategorized":2');

    const plan = { basedOnVersion: 1, operations: [{ kind: "create_collection", name: "Launch reading", tabIds: ["t1", "t2"], confidence: "high" }] };
    const reply = await h.turn(sessionId, `context propose_workspace_plan ${JSON.stringify(plan)}`, async () => {
      let approvalId = "";
      await until(async () => {
        const view = await h.send<{ approvals: { approvalId: string; provider: string; plan?: { operationCount: number } }[] }>({ name: "get_session", sessionId });
        const approval = view.value?.approvals?.[0];
        if (approval) {
          expect(approval).toMatchObject({ provider: "gemini", plan: { operationCount: 1 } });
          approvalId = approval.approvalId;
        }
        return Boolean(approvalId);
      });
      await h.send({ name: "respond_to_approval", approvalId, decision: "granted" });
      let action: { actionId: string; planHash: string; operations: { kind: "create_collection"; name: string; tabIds: string[] }[] } | undefined;
      await until(async () => {
        const view = await h.send<{ session: { context: { pendingActions: NonNullable<typeof action>[] } } }>({ name: "get_session", sessionId });
        action = view.value?.session.context.pendingActions[0];
        return Boolean(action);
      });
      const applied = applyCollectionBatch([], { workspaceId: "w-launch", tabIds: new Set(["t1", "t2"]) }, action!.operations, 1);
      if (!applied.ok) throw new Error("apply failed");
      await h.send({ name: "sync_session_context", sessionId, snapshot: { ...LAUNCH_PLAN, collections: applied.collections } });
      await h.send({ name: "complete_context_action", sessionId, actionId: action!.actionId, outcome: { ok: true, planHash: action!.planHash, created: applied.created } });
    });
    expect(reply).toMatch(/^context:proceed_once:/);
    expect(reply).toContain('"applied":true');
    expect(reply).toContain('"verified":true');
    expect(reply).toContain('"contextVersion":2');
    await h.host.dispose();
  }, 60_000);

  it("ends the credential with the session: a disposed session's agent is gone and its token is refused", async () => {
    const h = build(["read_workspace", "read_project"]);
    const sessionId = await h.start();
    expect(h.registry.activeCount()).toBe(1);
    await h.send({ name: "dispose_session", sessionId });
    expect(h.registry.activeCount()).toBe(0);
    await h.host.dispose();
  }, 60_000);
});
