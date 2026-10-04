// @vitest-environment node
/**
 * The central promise of agent history, end to end, against real PostgreSQL:
 *
 *     start runtime → connect agent → real activity → persisted
 *       → runtime stops → a new runtime starts → workspace reopens
 *       → the session is in history → its timeline opens
 *       → its action opens in the inspector → references resolve
 *       → safe undo works, stale undo is refused
 *
 * Two runtimes, sharing nothing but the database: each has its own host,
 * journal, approval broker, session registry, MCP server and agent process,
 * and the second is built on a new connection pool. The first is abandoned
 * without a goodbye — no dispose, no flush beyond what each response already
 * waited for — as a crash or a closed laptop would leave it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readHistoryDetail, readHistoryPage, reconstructHistorySession } from "@/lib/agents/activity/history";
import { PostgresAgentHistoryStore } from "@/lib/agents/activity/history-store-postgres";
import { inspectActivityEntry } from "@/lib/agents/activity/inspector";
import { buildAgentActivityTimeline } from "@/lib/agents/activity/timeline";
import { collectionsMatch, restoreWorkspaceCollections } from "@/lib/collections/restore";
import { describePostgres, emptyDatabase } from "../../../../test/pg/database";
import { BOB, PRIVATE, approveAndApply, startRuntime, until } from "./__fixtures__/history-rig";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { Collection } from "@/lib/collections/types";
import { launchEntryFor } from "@/lib/agents/launch/allowlist";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { SessionContextServer } from "@/lib/agents/session-context/http";

const SCHEMA = readFileSync(path.join(__dirname, "..", "activity", "history-schema.sql"), "utf8");

/** The launch allowlist's own proof of identity for each agent's context calls. */
const contextIdentity = (provider: AgentProviderId) => launchEntryFor(provider)!.acp!.contextIdentity;

const servers: SessionContextServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** What the Command Centre does with a history session it opens: the wire answer, revalidated, back into the live model. */
function open(raw: unknown, workspaceName: string) {
  const history = reconstructHistorySession(readHistoryDetail(JSON.parse(JSON.stringify(raw)))!);
  const base = {
    session: history.session,
    events: history.events,
    approvals: [],
    knownApprovals: history.knownApprovals,
    changes: history.changes,
    planOutcomes: history.planOutcomes,
    agentName: "Gemini",
    workspaceName,
  };
  const entries = buildAgentActivityTimeline({ ...base, now: Date.now() });
  const inspect = (entryId: string, canUndo: (change: AppliedWorkspaceChange) => boolean) =>
    inspectActivityEntry(entryId, { ...base, entries, projectName: "Launch", canUndo });
  return { history, entries, inspect };
}

describePostgres("agent history survives a runtime restart", () => {
  it("start → activity → stop → restart → history → timeline → inspector → undo", async () => {
    const database = await emptyDatabase();
    await database.pool.query(SCHEMA);

    /* ---------------- Runtime one: an agent does real work. */

    const first = await startRuntime({ store: new PostgresAgentHistoryStore(database.pool), runtimeId: "rt-1", servers, contextIdentity });
    const sessionId = await first.start("gemini");
    await first.send({ name: "send_message", sessionId, text: "PROMPT-SECRET: organise my pricing tabs" } as never);

    const agent = await first.agentClient("gemini");
    await agent.callTool({ name: "get_workspace_summary", arguments: {} });
    await agent.callTool({ name: "search_tabs", arguments: { query: "pricing" } });
    const applied = await approveAndApply(first, sessionId, agent);
    expect(applied.recorded).toMatchObject({ ok: true });
    first.finishTurn();
    await until(async () => (await first.snapshotOf(sessionId)).events.some((event) => event.kind === "run_completed"));

    // Live, as it is today: the journal-built timeline.
    const live = await first.snapshotOf(sessionId);
    const liveTitles = buildAgentActivityTimeline({
      session: live.session,
      events: live.events,
      approvals: live.approvals,
      agentName: "Gemini",
      workspaceName: "Research",
      now: Date.now(),
    }).map((entry) => entry.title);
    expect(liveTitles).toContain("Found 2 relevant tabs");
    await agent.close();

    /* ---------------- The runtime stops. Nothing more is said to it. */

    const knownToFirst = first.host.runtimeId;

    /* ---------------- Runtime two: a new process, a new pool, the same database. */

    const second = await startRuntime({ store: new PostgresAgentHistoryStore(await database.openPool()), runtimeId: "rt-2", servers, contextIdentity });
    expect(second.host.runtimeId).not.toBe(knownToFirst);
    // The new runtime holds no session at all: the live path has nothing.
    expect((await second.send<{ sessions: unknown[] }>({ name: "list_sessions" } as never)).value?.sessions).toEqual([]);

    // The workspace reopens, and its history is there.
    const listed = await second.send({ name: "list_history", workspaceId: "w-research" } as never);
    expect(listed.ok).toBe(true);
    const page = readHistoryPage(JSON.parse(JSON.stringify(listed.value)))!;
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]).toMatchObject({ sessionId, workspaceId: "w-research", provider: "gemini", title: "Organise pricing" });

    // The session opens into the same timeline the live one showed.
    const detail = await second.send({ name: "get_history", workspaceId: "w-research", sessionId } as never);
    expect(detail.ok).toBe(true);
    const opened = open(detail.value, "Research");
    // Its runtime is gone, so it is not "ready" any more — it is disconnected.
    expect(opened.history.session.status).toBe("disconnected");
    const titles = opened.entries.map((entry) => entry.title);
    expect(titles).toEqual([
      "Gemini connected",
      "Workspace context loaded",
      "You sent a message",
      "Read workspace",
      "Found 2 relevant tabs",
      "Asked for approval",
      "Approved",
      "Created collection “Pricing”",
      "Replied",
      "Finished",
      "Gemini disconnected",
    ]);
    // Everything the live timeline said is said again, in the same order.
    expect(titles.filter((title) => liveTitles.includes(title))).toEqual(liveTitles.filter((title) => title !== "Waiting for approval"));

    /* ---------------- The historical action, in the inspector, by reference. */

    const createdEntry = opened.entries.find((entry) => entry.kind === "created")!;
    expect(createdEntry.refs).toMatchObject({ changeId: applied.actionId, approvalId: applied.approvalId });

    // The workspace still holds what the change left: undo is offered.
    let workspace: Collection[] = [...applied.after];
    const canUndo = (change: AppliedWorkspaceChange) => Boolean(change.after && collectionsMatch(workspace, change.workspaceId, change.after));
    const inspection = opened.inspect(createdEntry.id, canUndo)!;
    expect(inspection).toMatchObject({
      key: `approval:${applied.approvalId}`,
      title: "Created collection “Pricing”",
      status: "completed",
      action: "Create collection",
      request: { summary: "Create collection “Pricing” · 2 tabs" },
      result: { tone: "success", text: "Created “Pricing” in Research." },
      changes: { planned: false, lines: [{ sign: "add", text: "Collection “Pricing” · 2 tabs" }] },
      undo: { kind: "available", changeId: applied.actionId, label: "Undo" },
    });
    expect(inspection.chain.map((step) => step.label)).toEqual(["Requested by Gemini", "Approved", "Completed"]);
    // The approval and the decision resolve to the very entries the timeline shows.
    for (const id of [`approval:${applied.approvalId}`, `decision:${applied.approvalId}`]) {
      expect(opened.inspect(id, canUndo)?.key).toBe(inspection.key);
    }

    // Someone edits the workspace since: undo is refused, and says why.
    const edited = workspace.map((collection) => (collection.id === "c-new" ? { ...collection, name: "Pricing (mine)" } : collection));
    const stale = opened.inspect(createdEntry.id, (change) => Boolean(change.after && collectionsMatch(edited, change.workspaceId, change.after)))!;
    expect(stale.undo).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("the workspace has changed since") });
    const change = opened.history.changes.find((candidate) => candidate.id === applied.actionId)!;
    expect(restoreWorkspaceCollections(edited, "w-research", change.before!, change.after!)).toBeNull();

    // Undo on the unchanged workspace: exact, and recorded as its own fact.
    const restored = restoreWorkspaceCollections(workspace, "w-research", change.before!, change.after!)!;
    expect(restored).not.toBeNull();
    workspace = restored.collections;
    expect(workspace).toEqual(applied.before);
    const undone = await second.send({ name: "record_workspace_undo", workspaceId: "w-research", sessionId, changeId: applied.actionId, at: Date.now() } as never);
    expect(undone).toMatchObject({ ok: true, value: { sessionId, changeId: applied.actionId } });

    const reopened = open((await second.send({ name: "get_history", workspaceId: "w-research", sessionId } as never)).value, "Research");
    const after = reopened.entries.map((entry) => entry.title);
    // The original action keeps its place and its words; the undo is told after it.
    expect(after).toContain("Created collection “Pricing”");
    expect(after.indexOf("Undid creation of “Pricing”")).toBeGreaterThan(after.indexOf("Created collection “Pricing”"));
    expect(reopened.entries.find((entry) => entry.id === createdEntry.id)).toMatchObject({ status: "completed", title: "Created collection “Pricing”" });
    expect(reopened.inspect(createdEntry.id, () => true)).toMatchObject({ status: "undone", undo: { kind: "done" } });

    /* ---------------- Isolation, on the restarted runtime. */

    expect((await second.send({ name: "list_history", workspaceId: "w-research" } as never, BOB)).value).toEqual({ sessions: [] });
    expect(await second.send({ name: "get_history", workspaceId: "w-research", sessionId } as never, BOB)).toMatchObject({ ok: false, error: { code: "session_not_found" } });
    expect(await second.send({ name: "record_workspace_undo", workspaceId: "w-research", sessionId, changeId: applied.actionId, at: 1 } as never, BOB)).toMatchObject({
      ok: false,
      error: { code: "session_not_found" },
    });
    expect((await second.send({ name: "list_history", workspaceId: PRIVATE.workspace.id } as never)).value).toEqual({ sessions: [] });
    expect(await second.send({ name: "get_history", workspaceId: PRIVATE.workspace.id, sessionId } as never)).toMatchObject({ ok: false, error: { code: "session_not_found" } });

    /* ---------------- And nothing private reached the database. */

    const { rows } = await database.pool.query<{ data: unknown }>(`SELECT data FROM tabdump_agent_history_records`);
    const stored = JSON.stringify(rows);
    for (const secret of ["PROMPT-SECRET", "REPLY-SECRET", "Pricing research", "Pricing models compared", "example.com", "https://", "Bearer", "pricing\""]) {
      expect(stored, secret).not.toContain(secret);
    }
  });

  it("a runtime that shuts down cleanly records how each session ended", async () => {
    const database = await emptyDatabase();
    await database.pool.query(SCHEMA);
    const first = await startRuntime({ store: new PostgresAgentHistoryStore(database.pool), runtimeId: "rt-1", servers, contextIdentity });
    const sessionId = await first.start("gemini");
    await first.send({ name: "send_message", sessionId, text: "hello" } as never);
    await until(async () => (await first.snapshotOf(sessionId)).session.status === "running");
    await first.host.dispose();

    const second = await startRuntime({ store: new PostgresAgentHistoryStore(await database.openPool()), runtimeId: "rt-2", servers, contextIdentity });
    const page = (await second.send<{ sessions: { status: string }[] }>({ name: "list_history", workspaceId: "w-research" } as never)).value!;
    expect(page.sessions.map((session) => session.status)).toEqual(["cancelled"]);
  });
});
