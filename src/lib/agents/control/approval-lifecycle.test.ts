import { describe, expect, it } from "vitest";
import { createControlService } from "./service";
import { createGrant } from "./permissions";
import { createProject } from "./projects";
import { createClaudeCodeControlAdapter } from "./providers/claude-code/adapter";
import {
  createScriptedRuntime,
  resultError,
  resultSuccess,
} from "./providers/claude-code/__fixtures__/scripted-runtime";
import { createAcpControlAdapter } from "./providers/acp/adapter";
import { AgentError, createFakeAgent } from "./providers/acp/__fixtures__/fake-agent";
import { createCodexControlAdapter } from "./providers/codex-app-server/adapter";
import {
  commandApproval,
  createFakeCodex,
  turnCompleted,
} from "./providers/codex-app-server/__fixtures__/fake-codex";
import type { AgentControlAdapter } from "./types";
import type { AgentControlEvent } from "./events";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentSessionStatus } from "./session";
import type { AcpApprovalPolicy } from "./providers/acp/launcher";
import type { ClaudePermissionDecision } from "./providers/claude-code/runtime";

/**
 * The approval lifecycle, for every provider that can ask.
 *
 *     approval requested → approval answered → the session is not left waiting
 *
 * Codex exposed a session that stayed `waiting_for_approval` after its
 * approval was answered, so the run's end (`running → ready`) was refused and
 * the session read as waiting forever. The invariant belongs to the control
 * service, not to one adapter: a session waits for approval exactly while an
 * approval of its own is outstanding. So each case below drives the real
 * service with the real adapter for each provider — Claude through its
 * scripted runtime, Gemini and Grok through the ACP fake agent, Codex through
 * the fake app-server — and asserts the same statuses for all four.
 */

const T0 = 1_700_000_000_000;
const ROOT = "C:/work/research";
const ALLOW = () => ({ allowed: true as const, kind: "local-server" as const });

type Driver = {
  provider: AgentProviderId;
  adapter: AgentControlAdapter;
  /** Makes the agent, mid-turn, ask to run `count` commands at once. Resolves once all are raised. */
  ask(count: number): Promise<void>;
  /** Makes the agent ask for something its grant already settles — a read in the project. */
  askRead?(): Promise<void>;
  /** What the provider was told, per request, in the order it asked. */
  answers(): string[];
  /** Ends the turn the way the provider would. */
  end(outcome: "completed" | "failed"): Promise<void>;
  /** The provider process dies. */
  crash(): Promise<void>;
};

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ *
 * Drivers — one per provider, over the provider's own test fixture.
 * ------------------------------------------------------------------ */

function claudeDriver(): Driver {
  const runtime = createScriptedRuntime();
  let id = 0;
  const adapter = createClaudeCodeControlAdapter({ runtime, now: () => T0, createId: () => `c-${++id}` });
  const answers: string[] = [];
  let asked = 0;
  const record = (decision: Promise<ClaudePermissionDecision>) =>
    void decision.then((answer) => answers.push(answer.behavior));
  return {
    provider: "claude-code",
    adapter,
    async ask(count) {
      for (let i = 0; i < count; i++) {
        asked += 1;
        record(
          runtime.latest().requestPermission({
            toolName: "Bash",
            toolUseId: `toolu_${asked}`,
            requestId: `req_${asked}`,
            input: { command: `echo ${asked}` },
          })
        );
      }
      await settle();
    },
    async askRead() {
      asked += 1;
      record(
        runtime.latest().requestPermission({
          toolName: "Read",
          toolUseId: `toolu_${asked}`,
          requestId: `req_${asked}`,
          input: { file_path: `${ROOT}/notes.txt` },
        })
      );
      await settle();
    },
    answers: () => answers,
    async end(outcome) {
      runtime.latest().emit(outcome === "completed" ? resultSuccess("claude-1") : resultError("claude-1"));
      await settle();
    },
    async crash() {
      runtime.latest().finish({ code: "process-failed" });
      await settle();
    },
  };
}

/** Gemini and Grok: one ACP adapter, each with the asking policy its launch entry declares. */
function acpDriver(provider: "gemini" | "grok", approval: AcpApprovalPolicy): Driver {
  const answers: string[] = [];
  let pendingAsks: { kind: string; count: number } | undefined;
  let wake: (() => void) | undefined;
  let finish: ((outcome: "completed" | "failed") => void) | undefined;
  let asked = 0;

  const agent = createFakeAgent({
    "session/new": () => ({ sessionId: "acp-1", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "ask" }, { id: "yolo" }] } }),
    "session/prompt": async (params, ctx) => {
      const sessionId = params.sessionId as string;
      for (;;) {
        const outcome = await new Promise<"completed" | "failed" | "ask">((resolve) => {
          finish = resolve;
          wake = () => resolve("ask");
        });
        if (outcome === "completed") return { stopReason: "end_turn" };
        if (outcome === "failed") throw new AgentError(-32603);
        const batch = pendingAsks;
        pendingAsks = undefined;
        for (let i = 0; i < (batch?.count ?? 0); i++) {
          asked += 1;
          void ctx
            .ask("session/request_permission", {
              sessionId,
              toolCall: { toolCallId: `t${asked}`, kind: batch!.kind, title: "a tool" },
              options: [
                { optionId: "allow", kind: "allow_once" },
                { optionId: "reject", kind: "reject_once" },
              ],
            })
            .then((answer) => {
              const outcome = (answer.result as { outcome?: { outcome: string; optionId?: string } } | undefined)?.outcome;
              answers.push(outcome?.optionId ?? outcome?.outcome ?? "none");
            });
        }
      }
    },
  });
  let id = 0;
  const adapter = createAcpControlAdapter({
    provider,
    launch: agent.launcher,
    approval,
    now: () => T0,
    createId: () => `a-${++id}`,
  });
  const raise = async (kind: string, count: number) => {
    pendingAsks = { kind, count };
    wake?.();
    await settle();
  };
  return {
    provider,
    adapter,
    ask: (count) => raise("execute", count),
    askRead: () => raise("read", 1),
    answers: () => answers,
    async end(outcome) {
      finish?.(outcome);
      await settle(30);
    },
    async crash() {
      agent.crash();
      await settle();
    },
  };
}

function codexDriver(): Driver {
  const answers: string[] = [];
  let control: { ask(count: number): void; end(outcome: "completed" | "failed"): void } | undefined;
  let asked = 0;
  const codex = createFakeCodex({
    "turn/start": (_params, ctx) => {
      control = {
        ask(count) {
          for (let i = 0; i < count; i++) {
            asked += 1;
            void ctx.ask("item/commandExecution/requestApproval", commandApproval(`call_${asked}`)).then((reply) => {
              answers.push((reply.result as { decision?: string } | undefined)?.decision ?? "none");
            });
          }
        },
        end(outcome) {
          ctx.notify("turn/completed", turnCompleted(outcome));
        },
      };
      return { turn: { id: "turn-1", items: [], status: "inProgress", error: null } };
    },
  });
  let id = 0;
  const adapter = createCodexControlAdapter({
    provider: "openai-codex",
    launch: codex.launcher,
    login: async () => "completed",
    loginMethods: [{ id: "chatgpt", name: "Sign in with ChatGPT" }],
    platformVerified: true,
    minimumVersion: "0.159.0",
    now: () => T0,
    createId: () => `x-${++id}`,
  });
  return {
    provider: "openai-codex",
    adapter,
    async ask(count) {
      control?.ask(count);
      await settle();
    },
    answers: () => answers,
    async end(outcome) {
      control?.end(outcome);
      await settle();
    },
    async crash() {
      codex.crash();
      await settle();
    },
  };
}

const DRIVERS: [string, () => Driver][] = [
  ["Claude", claudeDriver],
  ["Gemini", () => acpDriver("gemini", { kind: "asking-mode", modeIds: ["default"] })],
  ["Grok", () => acpDriver("grok", { kind: "asking-mode", modeIds: ["ask", "default"] })],
  ["Codex", codexDriver],
];

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

async function running(makeDriver: () => Driver) {
  const driver = makeDriver();
  const grant = createGrant(["read_project", "write_project", "run_commands"], T0, "p1");
  if (!grant) throw new Error("grant fixture failed");
  const made = createProject(
    { id: "p1", name: "Research", path: ROOT, providers: [driver.provider], permissions: grant },
    T0
  );
  if (!made.ok) throw new Error("project fixture failed");
  let counter = 0;
  const service = createControlService({
    runtime: ALLOW,
    resolveAdapter: (provider) => (provider === driver.provider ? driver.adapter : undefined),
    resolveProject: (projectId) => (projectId === "p1" ? made.project : undefined),
    now: () => T0,
    createId: () => `s${++counter}`,
  });
  const events: AgentControlEvent[] = [];
  service.subscribe((event) => events.push(event));

  const started = await service.startSession({ provider: driver.provider, projectId: "p1", permissions: grant });
  if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
  const sessionId = started.value.id;
  const sent = await service.sendMessage({ sessionId, text: "go", context: { attachments: [] } });
  if (!sent.ok) throw new Error(`send failed: ${sent.error.code}`);
  await settle();

  return {
    driver,
    service,
    events,
    sessionId,
    status: (): AgentSessionStatus | undefined => service.session(sessionId)?.status,
    /** Approvals still waiting on the user, oldest first. */
    open: () => service.approvals.forSession(sessionId).filter((approval) => approval.status === "requested"),
    answer: async (approvalId: string, decision: "granted" | "denied") => {
      const result = await service.respondToApproval(approvalId, decision);
      await settle();
      return result;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

describe.each(DRIVERS)("%s: approval lifecycle", (_name, makeDriver) => {
  it("approve → the session leaves waiting, and the turn ends ready", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    expect(h.status()).toBe("waiting_for_approval");
    expect(h.open()).toHaveLength(1);

    expect((await h.answer(h.open()[0].id, "granted")).ok).toBe(true);
    expect(h.driver.answers()).toEqual([expect.stringMatching(/^(allow|accept)$/)]);
    expect(h.status()).toBe("running");
    expect(h.open()).toHaveLength(0);

    await h.driver.end("completed");
    expect(h.status()).toBe("ready");
    // Not stuck: the session takes the next message.
    expect((await h.service.sendMessage({ sessionId: h.sessionId, text: "next", context: { attachments: [] } })).ok).toBe(true);
  });

  it("deny → the provider is refused, the session leaves waiting, and the turn ends ready", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    expect(h.status()).toBe("waiting_for_approval");

    expect((await h.answer(h.open()[0].id, "denied")).ok).toBe(true);
    expect(h.driver.answers()).toEqual([expect.stringMatching(/^(deny|reject|decline)$/)]);
    expect(h.status()).toBe("running");

    await h.driver.end("completed");
    expect(h.status()).toBe("ready");
  });

  it("multiple approvals → waits until the last is answered", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(2);
    expect(h.status()).toBe("waiting_for_approval");
    const [first, second] = h.open();
    expect(second).toBeDefined();

    await h.answer(first.id, "granted");
    // One question is still on screen; the session is still waiting on it.
    expect(h.status()).toBe("waiting_for_approval");
    expect(h.open().map((approval) => approval.id)).toEqual([second.id]);

    await h.answer(second.id, "denied");
    expect(h.status()).toBe("running");
    expect(h.driver.answers()).toHaveLength(2);

    await h.driver.end("completed");
    expect(h.status()).toBe("ready");
  });

  it("an approval, then a second one in the same session, each settle", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    await h.answer(h.open()[0].id, "granted");
    expect(h.status()).toBe("running");

    await h.driver.ask(1);
    expect(h.status()).toBe("waiting_for_approval");
    await h.answer(h.open()[0].id, "granted");
    expect(h.status()).toBe("running");

    await h.driver.end("completed");
    expect(h.status()).toBe("ready");
  });

  it("approval followed by a failed turn → failed, not waiting", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    await h.answer(h.open()[0].id, "granted");
    await h.driver.end("failed");
    expect(h.status()).toBe("failed");
  });

  it("the session ends while an approval is pending → the card is withdrawn and a late yes does nothing", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    const pending = h.open()[0];

    expect((await h.service.cancelRun(h.sessionId)).ok).toBe(true);
    await settle();

    expect(h.status()).toBe("cancelled");
    // Withdrawn, not left on screen for a session that is over.
    expect(h.service.approvals.get(pending.id)?.status).toBe("cancelled");
    expect(h.open()).toHaveLength(0);
    // The provider was told no — never left blocked, never told yes.
    expect(h.driver.answers()).toHaveLength(1);
    expect(h.driver.answers()[0]).not.toMatch(/^(allow|accept)$/);

    expect((await h.answer(pending.id, "granted")).ok).toBe(false);
    expect(h.driver.answers()).toHaveLength(1);
  });

  it("the agent disconnects while an approval is pending → failed, the card is withdrawn, a late yes does nothing", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    const pending = h.open()[0];

    await h.driver.crash();

    expect(h.status()).toBe("failed");
    expect(h.service.approvals.get(pending.id)?.status).toBe("cancelled");
    expect((await h.answer(pending.id, "granted")).ok).toBe(false);
    expect(h.driver.answers().filter((answer) => /^(allow|accept)$/.test(answer))).toHaveLength(0);
  });

  it("the agent disconnected by the user while an approval is pending → nothing is left waiting", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    const pending = h.open()[0];

    // What the runtime host does for disconnect_provider: cancel, then disconnect.
    await h.service.cancelRun(h.sessionId);
    await h.driver.adapter.disconnect();
    await settle();

    expect(h.status()).toBe("cancelled");
    expect(h.service.approvals.get(pending.id)?.status).toBe("cancelled");
    expect((await h.answer(pending.id, "granted")).ok).toBe(false);
  });

  it("a turn that ends with a question unanswered → ready, and the question is withdrawn", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    const pending = h.open()[0];
    expect(h.status()).toBe("waiting_for_approval");

    await h.driver.end("completed");

    expect(h.status()).toBe("ready");
    expect(h.service.approvals.get(pending.id)?.status).toBe("cancelled");
    expect((await h.answer(pending.id, "granted")).ok).toBe(false);
    expect(h.driver.answers().filter((answer) => /^(allow|accept)$/.test(answer))).toHaveLength(0);
  });

  it("the events say what happened, once each", async () => {
    const h = await running(makeDriver);
    await h.driver.ask(1);
    const id = h.open()[0].id;
    await h.answer(id, "granted");
    const about = h.events.filter((event) => event.approvalId === id).map((event) => event.kind);
    expect(about).toEqual(["approval_requested", "approval_granted"]);
  });
});

describe.each(DRIVERS.filter(([name]) => name !== "Codex"))(
  "%s: a request the grant already settles",
  (_name, makeDriver) => {
    it("is answered at once and never leaves the session waiting", async () => {
      const h = await running(makeDriver);
      await h.driver.askRead!();
      expect(h.driver.answers()).toEqual([expect.stringMatching(/^(allow)$/)]);
      expect(h.open()).toHaveLength(0);
      expect(h.status()).toBe("running");
      await h.driver.end("completed");
      expect(h.status()).toBe("ready");
    });
  }
);
