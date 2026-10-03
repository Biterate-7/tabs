import { describe, expect, it } from "vitest";
import {
  historyApprovalOf,
  historyChangeOf,
  historyEventOf,
  historyOutcomeOf,
  historySessionStatus,
  readHistoryDetail,
  readHistoryPage,
  reconstructHistorySession,
  reviveHistoryChange,
  reviveHistoryEvent,
} from "./history";
import { inspectActivityEntry, isInspectable } from "./inspector";
import { buildAgentActivityTimeline } from "./timeline";
import type { AgentHistoryDetail, AgentHistorySession } from "./history";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { Collection } from "@/lib/collections/types";
import type {
  RuntimeApprovalView,
  RuntimePlanOutcomeView,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol";

/**
 * Agent history keeps the records the live timeline is built from, reduced
 * to what it reads — and reading them back must give the very same timeline
 * and the very same inspections, by the same references. These fixtures
 * follow the order the runtime journals a real session in, with the
 * transport noise (`thinking`, `message_delta`) and the private content
 * (message text, a command line, tab titles) a real session carries.
 */

const T0 = 1_700_000_000_000;
const WS = "w-research";

let sequence = 0;
function event(over: Partial<SequencedControlEvent> & Pick<SequencedControlEvent, "kind">): SequencedControlEvent {
  sequence += 1;
  return { id: `e${sequence}`, sessionId: "s1", provider: "claude-code", timestamp: T0 + sequence * 1_000, summary: "", sequence, ...over };
}

const sources: Collection = { id: "c1", workspaceId: WS, name: "Sources", tabIds: ["t1"], createdAt: 0, updatedAt: 0 };
const pricing: Collection = { id: "c9", workspaceId: WS, name: "Pricing Research", tabIds: ["t2", "t3"], createdAt: 1, updatedAt: 1 };

function fixture() {
  sequence = 0;
  const events: SequencedControlEvent[] = [
    event({ kind: "session_started", summary: "Session started." }),
    event({ kind: "context_loaded", summary: "3 tabs · 1 collection", context: { workspaceId: WS, tabs: 3, collections: 1 } }),
    event({ kind: "message_sent", summary: "PROMPT", text: "PROMPT-SECRET: organise my bank tabs", messageId: "m0" }),
    event({ kind: "thinking", summary: "THINKING-SECRET" }),
    event({ kind: "context_read", summary: "3 tabs", context: { workspaceId: WS, operation: "get_workspace_summary", ok: true, tabs: 3, collections: 1 } }),
    event({ kind: "context_read", summary: "2 matching tabs", context: { workspaceId: WS, operation: "search_tabs", ok: true, matches: 2 } }),
    event({ kind: "message_delta", summary: "", text: "DELTA-SECRET", messageId: "m1" }),
    event({ kind: "approval_requested", summary: "Create a collection", approvalId: "wa-1" }),
    event({ kind: "approval_granted", summary: "Approved", approvalId: "wa-1" }),
    // An ACP agent's file work: the call, its approval, its finish, then the file.
    event({ kind: "tool_started", summary: "", tool: { name: "write", callId: "call-1", description: "Write the summary" } }),
    event({ kind: "approval_requested", summary: "Create research-summary.md", approvalId: "a-file", tool: { name: "write", callId: "call-1" } }),
    event({ kind: "approval_granted", summary: "", approvalId: "a-file" }),
    event({ kind: "tool_finished", summary: "", tool: { name: "write", callId: "call-1", ok: true } }),
    event({ kind: "file_created", summary: "Created", file: { relativePath: "notes/research-summary.md", projectId: "p1" }, runId: "cr-1" }),
    // A finished call, then a thought, then a file: the file is not that call's.
    event({ kind: "tool_started", summary: "", tool: { name: "write", callId: "call-2" } }),
    event({ kind: "approval_requested", summary: "Edit plan.md", approvalId: "a-file-2", tool: { name: "write", callId: "call-2" } }),
    event({ kind: "approval_granted", summary: "", approvalId: "a-file-2" }),
    event({ kind: "tool_finished", summary: "", tool: { name: "write", callId: "call-2", ok: true } }),
    event({ kind: "thinking", summary: "" }),
    event({ kind: "file_modified", summary: "Edited", file: { relativePath: "plan.md", projectId: "p1" }, runId: "cr-1" }),
    event({ kind: "command_started", summary: "", tool: { name: "Bash", callId: "call-3", description: "Run the tests" } }),
    event({ kind: "command_finished", summary: "", tool: { name: "Bash", callId: "call-3", ok: true } }),
    event({ kind: "approval_requested", summary: "Apply 2 changes", approvalId: "wa-plan" }),
    event({ kind: "approval_granted", summary: "", approvalId: "wa-plan" }),
    event({ kind: "message_received", summary: "Done", text: "REPLY-SECRET: here is what I did", messageId: "m1" }),
    event({ kind: "run_completed", summary: "Finished" }),
  ];

  const approvals: RuntimeApprovalView[] = [
    {
      approvalId: "wa-1",
      sessionId: "s1",
      provider: "claude-code",
      action: "change_workspace",
      scope: "write_workspace",
      workspaceId: WS,
      targets: [`New collection "Pricing Research"`],
      reason: "Group the pricing tabs.",
      change: { kind: "create_collection", subject: "Pricing Research", tabCount: 2, details: ["TAB-TITLE-SECRET"] },
      requestedAt: T0 + 8_000,
      expiresAt: T0 + 600_000,
    },
    {
      approvalId: "a-file",
      sessionId: "s1",
      provider: "claude-code",
      action: "create_files",
      scope: "write_project",
      projectId: "p1",
      targets: ["notes/research-summary.md"],
      requestedAt: T0 + 11_000,
      expiresAt: T0 + 600_000,
    },
    {
      approvalId: "a-file-2",
      sessionId: "s1",
      provider: "claude-code",
      action: "modify_files",
      scope: "write_project",
      projectId: "p1",
      targets: ["plan.md"],
      command: { program: "COMMAND-SECRET", args: ["--token", "sk-live"], cwd: "C:/Users/someone" } as never,
      requestedAt: T0 + 16_000,
      expiresAt: T0 + 600_000,
    },
    {
      approvalId: "wa-plan",
      sessionId: "s1",
      provider: "claude-code",
      action: "change_workspace",
      scope: "write_workspace",
      workspaceId: WS,
      targets: ["PLAN-TARGET-SECRET"],
      plan: {
        planId: "plan-1",
        basedOnVersion: 1,
        operationCount: 2,
        tabCount: 3,
        steps: [
          { kind: "rename_collection", subject: "Sources", to: "Reading", tabs: [], movesFrom: [] },
          { kind: "add_tabs_to_collection", subject: "Reading", tabCount: 1, tabs: ["TAB-TITLE-SECRET-2"], movesFrom: ["Elsewhere"], reason: "REASON-SECRET" },
        ],
      },
      requestedAt: T0 + 23_000,
      expiresAt: T0 + 600_000,
    },
  ];

  const changes: AppliedWorkspaceChange[] = [
    {
      id: "ctxa-1",
      sessionId: "s1",
      provider: "claude-code",
      workspaceId: WS,
      at: T0 + 9_500,
      ok: true,
      approvalId: "wa-1",
      steps: [{ kind: "created", collectionId: "c9", name: "Pricing Research", tabCount: 2 }],
      before: [sources],
      after: [sources, pricing],
      undone: true,
      undoneAt: T0 + 40_000,
    },
    {
      id: "ctxa-plan",
      sessionId: "s1",
      provider: "claude-code",
      workspaceId: WS,
      at: T0 + 24_500,
      ok: false,
      planId: "plan-1",
      approvalId: "wa-plan",
      steps: [],
    },
  ];

  const planOutcomes: RuntimePlanOutcomeView[] = [
    { planId: "plan-1", approvalId: "wa-plan", status: "not_applied", operationCount: 2, verifiedCount: 0, contextVersion: 2, at: T0 + 24_600 },
  ];

  const live: RuntimeSessionView = {
    sessionId: "s1",
    provider: "claude-code",
    status: "completed",
    workspaceId: WS,
    projectId: "p1",
    title: "Organise pricing",
    runIds: ["cr-1"],
    awaitingApproval: false,
    cancellable: false,
    resumable: false,
    latestSequence: sequence,
    createdAt: T0,
    updatedAt: T0 + 30_000,
    context: {
      workspaceId: WS,
      workspaceName: "Research",
      capabilities: [],
      version: 2,
      syncedAt: T0,
      fingerprint: "f",
      pendingActions: [],
      planOutcomes,
    },
  };

  return { events, approvals, changes, planOutcomes, live };
}

/** What the runtime would have written, through the same reducers it uses. */
type Fixture = ReturnType<typeof fixture>;

function persisted(fixture: Fixture): AgentHistoryDetail {
  const session: AgentHistorySession = {
    sessionId: "s1",
    workspaceId: WS,
    provider: "claude-code",
    status: "completed",
    title: "Organise pricing",
    projectId: "p1",
    startedAt: fixture.live.createdAt,
    lastActivityAt: fixture.live.updatedAt,
    endedAt: fixture.live.updatedAt,
  };
  const detail = {
    session,
    records: {
      events: fixture.events.map(historyEventOf).filter((kept) => kept !== null),
      approvals: fixture.approvals.map(historyApprovalOf),
      changes: fixture.changes.map(historyChangeOf),
      undos: fixture.changes.filter((change) => change.undone).map((change) => ({ changeId: change.id, at: change.undoneAt! })),
      planOutcomes: fixture.planOutcomes.map(historyOutcomeOf),
    },
  };
  // Through JSON, as the database and the wire carry it, and revalidated on the way back.
  return readHistoryDetail(JSON.parse(JSON.stringify(detail)))!;
}

const SECRETS = [
  "PROMPT-SECRET",
  "THINKING-SECRET",
  "DELTA-SECRET",
  "REPLY-SECRET",
  "COMMAND-SECRET",
  "sk-live",
  "C:/Users/someone",
  "TAB-TITLE-SECRET",
  "TAB-TITLE-SECRET-2",
  "REASON-SECRET",
  "PLAN-TARGET-SECRET",
  "Elsewhere",
];

describe("what agent history keeps", () => {
  it("keeps no conversation, command line, tab title or transport event", () => {
    const f = fixture();
    const detail = persisted(f);
    const stored = JSON.stringify(detail);
    for (const secret of SECRETS) expect(stored, secret).not.toContain(secret);
    expect(detail.records.events.some((kept) => kept.kind === "thinking" || kept.kind === "message_delta")).toBe(false);
    expect(detail.records.events.every((kept) => kept.text === undefined)).toBe(true);
    // That a message was sent and answered is kept; what it said is not.
    expect(detail.records.events.filter((kept) => kept.kind === "message_sent" || kept.kind === "message_received")).toHaveLength(2);
    // The summary only where the timeline reads one.
    expect(detail.records.events.find((kept) => kept.kind === "run_completed")?.summary).toBe("");
    expect(detail.records.events.find((kept) => kept.kind === "approval_requested")?.summary).toBe("Create a collection");
  });

  it("keeps a file approval's project-relative targets, and nothing of another kind's", () => {
    const [, file, , plan] = fixture().approvals;
    expect(historyApprovalOf(file!).targets).toEqual(["notes/research-summary.md"]);
    expect(historyApprovalOf(plan!).targets).toEqual([]);
    expect(historyApprovalOf(plan!).plan?.steps.map((step) => step.subject)).toEqual(["Sources", "Reading"]);
  });

  it("keeps an applied change as applied — the undo is its own record — and its snapshot only whole", () => {
    const [created] = fixture().changes;
    const kept = historyChangeOf(created!);
    expect(kept.undone).toBeUndefined();
    expect(kept.undoneAt).toBeUndefined();
    expect(kept.before).toEqual([sources]);
    expect(kept.after).toEqual([sources, pricing]);

    // A snapshot naming another workspace is not an inverse of this change.
    const foreign = historyChangeOf({ ...created!, after: [{ ...pricing, workspaceId: "w-other" }] });
    expect(foreign.before).toBeUndefined();
    expect(foreign.after).toBeUndefined();
  });

  it("refuses records that do not read, rather than repairing them", () => {
    expect(reviveHistoryEvent({ ...fixture().events[0], sessionId: "someone-else" }, "s1")).toBeNull();
    expect(reviveHistoryEvent({ ...fixture().events[2], text: "smuggled" }, "s1")).toBeNull();
    expect(reviveHistoryEvent({ ...fixture().events[13], file: { relativePath: "../../etc/passwd", projectId: "p1" } }, "s1")).toBeNull();
    expect(reviveHistoryEvent({ ...fixture().events[9], tool: { name: 42 } }, "s1")).toBeNull();
    const change = fixture().changes[0]!;
    expect(reviveHistoryChange({ ...change, workspaceId: "w-other" }, { sessionId: "s1", workspaceId: WS })).toBeNull();
    expect(reviveHistoryChange({ ...change, steps: [{ kind: "deleted", name: "x" }] }, { sessionId: "s1", workspaceId: WS })).toBeNull();
    expect(readHistoryDetail({ session: { sessionId: "s1" }, records: {} })).toBeNull();
    expect(readHistoryPage({ sessions: [{ nope: true }] })).toEqual({ sessions: [] });
  });
});

describe("history reads back as the same timeline", () => {
  it("builds the identical timeline from persisted records as from the live ones", () => {
    const f = fixture();
    const known = new Map(f.approvals.map((approval) => [approval.approvalId, approval]));
    const liveEntries = buildAgentActivityTimeline({
      session: f.live,
      events: f.events,
      approvals: [],
      knownApprovals: known,
      changes: f.changes,
      agentName: "Claude Code",
      workspaceName: "Research",
      now: T0 + 3_600_000,
    });

    const history = reconstructHistorySession(persisted(f));
    const historyEntries = buildAgentActivityTimeline({
      session: history.session,
      events: history.events,
      approvals: [],
      knownApprovals: history.knownApprovals,
      changes: history.changes,
      planOutcomes: history.planOutcomes,
      agentName: "Claude Code",
      workspaceName: "Research",
      now: T0 + 3_600_000,
    });

    expect(historyEntries).toEqual(liveEntries);
    // The things that make this fixture worth having, so it cannot quietly stop covering them.
    const titles = liveEntries.map((entry) => entry.title);
    expect(titles).toContain("Created collection “Pricing Research”");
    expect(titles).toContain("Undid creation of “Pricing Research”");
    expect(titles).toContain("Created research-summary.md");
    expect(titles).toContain("Couldn't apply the approved change");
    expect(liveEntries.find((entry) => entry.title === "Created research-summary.md")?.refs?.approvalId).toBe("a-file");
    // Not the approval of the call that finished before the thought.
    expect(liveEntries.find((entry) => entry.title === "Edited plan.md")?.refs?.approvalId).toBeUndefined();
  });

  it("inspects every action identically, joined by the same references", () => {
    const f = fixture();
    const known = new Map(f.approvals.map((approval) => [approval.approvalId, approval]));
    const canUndo = () => true;
    const liveInput = { session: f.live, events: f.events, approvals: [], knownApprovals: known, changes: f.changes, agentName: "Claude Code", workspaceName: "Research", projectName: "Launch", canUndo };
    const liveEntries = buildAgentActivityTimeline({ ...liveInput, now: T0 + 3_600_000 });

    const history = reconstructHistorySession(persisted(f));
    const historyInput = {
      session: history.session,
      events: history.events,
      approvals: [],
      knownApprovals: history.knownApprovals,
      changes: history.changes,
      planOutcomes: history.planOutcomes,
      agentName: "Claude Code",
      workspaceName: "Research",
      projectName: "Launch",
      canUndo,
    };
    const historyEntries = buildAgentActivityTimeline({ ...historyInput, now: T0 + 3_600_000 });

    const inspectable = liveEntries.filter(isInspectable);
    expect(inspectable.length).toBeGreaterThan(5);
    for (const entry of inspectable) {
      expect(inspectActivityEntry(entry.id, { ...historyInput, entries: historyEntries }), entry.title).toEqual(
        inspectActivityEntry(entry.id, { ...liveInput, entries: liveEntries })
      );
    }

    // The relationships, resolved by id: the change, its approval, its undo.
    const created = inspectActivityEntry("change:ctxa-1", { ...historyInput, entries: historyEntries })!;
    expect(created).toMatchObject({ key: "approval:wa-1", status: "undone", request: { summary: "Create collection “Pricing Research” · 2 tabs", reason: "Group the pricing tabs." } });
    expect(created.chain.map((step) => step.label)).toEqual(["Requested by Claude Code", "Approved", "Completed", "Undone"]);
    const failed = inspectActivityEntry("change:ctxa-plan", { ...historyInput, entries: historyEntries })!;
    expect(failed).toMatchObject({ status: "failed", result: { tone: "failure" } });
  });
});

describe("a session read back from history", () => {
  it("claims nothing live", () => {
    const history = reconstructHistorySession(persisted(fixture()));
    expect(history.session).toMatchObject({ awaitingApproval: false, cancellable: false, resumable: false, runIds: [] });
    expect(history.session.context).toBeUndefined();
  });

  it("reads a session the runtime was still driving as disconnected, and an ended one as it ended", () => {
    expect(historySessionStatus("running")).toBe("disconnected");
    expect(historySessionStatus("waiting_for_approval")).toBe("disconnected");
    expect(historySessionStatus("completed")).toBe("completed");
    expect(historySessionStatus("failed")).toBe("failed");
    expect(historySessionStatus("cancelled")).toBe("cancelled");
  });

  it("folds only the first undo onto a change, and never onto a failed one", () => {
    const f = fixture();
    const detail = persisted(f);
    const twice = reconstructHistorySession({
      ...detail,
      records: {
        ...detail.records,
        undos: [...detail.records.undos, { changeId: "ctxa-1", at: T0 + 99_000 }, { changeId: "ctxa-plan", at: T0 + 99_000 }],
      },
    });
    expect(twice.changes.find((change) => change.id === "ctxa-1")?.undoneAt).toBe(T0 + 40_000);
    expect(twice.changes.find((change) => change.id === "ctxa-plan")?.undone).toBeUndefined();
  });
});
