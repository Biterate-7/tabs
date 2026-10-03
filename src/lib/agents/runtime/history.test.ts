// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAgentHistoryStore } from "@/lib/agents/activity/history-store";
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline";
import { ALICE, BOB, PRIVATE, SOURCES, approveAndApply, startRuntime, until } from "./__fixtures__/history-rig";
import type { AgentHistoryDetail, AgentHistoryPage } from "@/lib/agents/activity/history";
import type { AgentHistoryStore } from "@/lib/agents/activity/history-store";
import { launchEntryFor } from "@/lib/agents/launch/allowlist";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { SessionContextServer } from "@/lib/agents/session-context/http";

/**
 * Agent history from the runtime's side: what the real host records, when,
 * and what it refuses — with the real control service, broker, registry, MCP
 * server and a scripted ACP agent. The restart itself, against real
 * PostgreSQL, is history-restart.pg.test.ts.
 */

/** The launch allowlist's own proof of identity for each agent's context calls. */
const contextIdentity = (provider: AgentProviderId) => launchEntryFor(provider)!.acp!.contextIdentity;

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function page(runtime: Awaited<ReturnType<typeof startRuntime>>, workspaceId = "w-research", actor = ALICE) {
  return (await runtime.send<AgentHistoryPage>({ name: "list_history", workspaceId } as never, actor)).value!;
}

describe("without a history store", () => {
  it("says history is unavailable, and every live command works exactly as before", async () => {
    const runtime = await startRuntime({ runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    for (const command of [
      { name: "list_history", workspaceId: "w-research" },
      { name: "get_history", workspaceId: "w-research", sessionId },
      { name: "record_workspace_undo", workspaceId: "w-research", sessionId, changeId: "x", at: 1 },
      { name: "record_workspace_change", sessionId, change: { id: "x", at: 1, ok: true, steps: [] } },
    ]) {
      expect(await runtime.send(command as never), command.name).toMatchObject({ ok: false, error: { code: "history_unavailable" } });
    }
    expect((await runtime.snapshotOf(sessionId)).events.some((event) => event.kind === "context_loaded")).toBe(true);
  });
});

describe("recording a session's life", () => {
  it("records a session the moment it is created, in its workspace", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    expect((await page(runtime)).sessions).toEqual([
      expect.objectContaining({ sessionId, workspaceId: "w-research", provider: "gemini", title: "Organise pricing", projectId: "p1" }),
    ]);
    const detail = (await runtime.send<AgentHistoryDetail>({ name: "get_history", workspaceId: "w-research", sessionId } as never)).value!;
    expect(detail.records.events.map((event) => event.kind)).toContain("context_loaded");
  });

  it("records a session that failed", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    await runtime.send({ name: "send_message", sessionId, text: "go" } as never);
    runtime.agents.get("gemini")!.crash();
    await until(async () => ["failed", "disconnected"].includes((await runtime.snapshotOf(sessionId)).session.status));
    const live = (await runtime.snapshotOf(sessionId)).session.status;
    const [recorded] = (await page(runtime)).sessions;
    expect(recorded).toMatchObject({ sessionId, status: live });
    expect(recorded!.endedAt).toBeGreaterThan(0);
  });

  it("records a session the person ended", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    await runtime.send({ name: "send_message", sessionId, text: "go" } as never);
    await until(async () => (await runtime.snapshotOf(sessionId)).session.status === "running");
    expect(await runtime.send({ name: "dispose_session", sessionId } as never)).toMatchObject({ ok: true });
    // Gone from the runtime, kept in history.
    expect((await runtime.send<{ sessions: unknown[] }>({ name: "list_sessions" } as never)).value?.sessions).toEqual([]);
    expect((await page(runtime)).sessions).toEqual([expect.objectContaining({ sessionId, status: "cancelled" })]);
  });

  it("records a session that completed its work, with what it did", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    await runtime.send({ name: "send_message", sessionId, text: "go" } as never);
    const agent = await runtime.agentClient();
    await agent.callTool({ name: "search_tabs", arguments: { query: "pricing" } });
    const applied = await approveAndApply(runtime, sessionId, agent);
    runtime.finishTurn();
    await until(async () => (await runtime.snapshotOf(sessionId)).events.some((event) => event.kind === "run_completed"));
    await agent.close();

    const detail = (await runtime.send<AgentHistoryDetail>({ name: "get_history", workspaceId: "w-research", sessionId } as never)).value!;
    expect(detail.records.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["approval_requested", "approval_granted", "context_read", "run_completed"]));
    expect(detail.records.approvals.map((approval) => approval.approvalId)).toEqual([applied.approvalId]);
    expect(detail.records.changes).toEqual([
      expect.objectContaining({ id: applied.actionId, approvalId: applied.approvalId, ok: true, before: applied.before, after: applied.after }),
    ]);
  });
});

describe("recording what the Command Centre applied", () => {
  it("takes whose, where and which approval from the runtime, never from the caller", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    const agent = await runtime.agentClient();
    const applied = await approveAndApply(runtime, sessionId, agent);
    await agent.close();

    // A second report of a change, claiming a plan this session never had,
    // and a snapshot of another workspace.
    const forged = await runtime.send({
      name: "record_workspace_change",
      sessionId,
      change: {
        id: "made-up",
        at: 1,
        ok: true,
        planId: "plan-from-nowhere",
        steps: [{ kind: "created", name: "X", tabCount: 0 }],
        before: [],
        after: [{ ...SOURCES, workspaceId: PRIVATE.workspace.id }],
      },
    } as never);
    expect(forged.ok).toBe(true);
    const changes = (await runtime.send<AgentHistoryDetail>({ name: "get_history", workspaceId: "w-research", sessionId } as never)).value!.records.changes;
    const made = changes.find((change) => change.id === "made-up")!;
    expect(made.planId).toBeUndefined();
    expect(made.approvalId).toBeUndefined();
    // Not an inverse of anything in this workspace, so no undo can ever be built from it.
    expect(made.before).toBeUndefined();
    expect(made.after).toBeUndefined();
    expect(made.workspaceId).toBe("w-research");
    expect(changes.find((change) => change.id === applied.actionId)?.approvalId).toBe(applied.approvalId);
  });

  it("refuses another account's session", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    const reply = await runtime.send({ name: "record_workspace_change", sessionId, change: { id: "x", at: 1, ok: true, steps: [] } } as never, BOB);
    expect(reply).toMatchObject({ ok: false, error: { code: "ownership_denied" } });
  });

  it("refuses an undo of a change that was never recorded as applied", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    const reply = await runtime.send({ name: "record_workspace_undo", workspaceId: "w-research", sessionId, changeId: "never", at: 1 } as never);
    expect(reply).toMatchObject({ ok: false, error: { code: "session_not_found" } });
  });
});

describe("isolation", () => {
  it("keeps each workspace's and each account's history to itself", async () => {
    const runtime = await startRuntime({ store: createMemoryAgentHistoryStore(), runtimeId: "rt", providers: ["gemini", "grok"], servers, contextIdentity });
    const research = await runtime.start("gemini");
    const personal = await runtime.start("grok", PRIVATE);
    const bobs = await runtime.start("gemini", PRIVATE, BOB);

    expect((await page(runtime, "w-research")).sessions.map((session) => session.sessionId)).toEqual([research]);
    expect((await page(runtime, PRIVATE.workspace.id)).sessions.map((session) => session.sessionId)).toEqual([personal]);
    expect((await page(runtime, PRIVATE.workspace.id, BOB)).sessions.map((session) => session.sessionId)).toEqual([bobs]);
    expect(await runtime.send({ name: "get_history", workspaceId: PRIVATE.workspace.id, sessionId: research } as never)).toMatchObject({ ok: false, error: { code: "session_not_found" } });
    expect(await runtime.send({ name: "get_history", workspaceId: "w-research", sessionId: research } as never, BOB)).toMatchObject({ ok: false, error: { code: "session_not_found" } });
  });
});

describe("a failing history store", () => {
  it("never reaches the live session: events journal, the timeline builds, history says it is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken: AgentHistoryStore = {
      write: async () => {
        throw Object.assign(new Error("connection refused: postgres://user:secret@db"), { code: "ECONNREFUSED" });
      },
      listSessions: async () => {
        throw new Error("down");
      },
      readSession: async () => {
        throw new Error("down");
      },
      hasAppliedChange: async () => {
        throw new Error("down");
      },
    };
    const runtime = await startRuntime({ store: broken, runtimeId: "rt", servers, contextIdentity });
    const sessionId = await runtime.start();
    const agent = await runtime.agentClient();
    await agent.callTool({ name: "search_tabs", arguments: { query: "pricing" } });
    await until(async () => (await runtime.snapshotOf(sessionId)).events.some((event) => event.kind === "context_read"));
    await agent.close();

    const { session, events, approvals } = await runtime.snapshotOf(sessionId);
    const titles = buildAgentActivityTimeline({ session, events, approvals, agentName: "Gemini", workspaceName: "Research", now: Date.now() }).map((entry) => entry.title);
    expect(titles).toContain("Found 2 relevant tabs");
    expect(await runtime.send({ name: "list_history", workspaceId: "w-research" } as never)).toMatchObject({ ok: false, error: { code: "history_unavailable" } });

    // Said, once, without the error's detail.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("ECONNREFUSED");
    expect(String(warn.mock.calls[0]![0])).not.toContain("secret");
    warn.mockRestore();
  });
});
