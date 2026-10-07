import { describe, expect, it } from "vitest";
import { buildAgentActivityTimeline } from "./timeline";
import { oneLine, taskNeedsAttention, taskOutcome, taskOutcomeFacts } from "./outcome";
import type { AgentSessionStatus } from "@/lib/agents/control/session";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { RuntimeApprovalView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol";

/**
 * The task outcome (Stage 3) over the records a real project session leaves:
 * the developer's instruction, an approval for two files, Hubble's measured
 * change, and the checks run on it — read back as one answer.
 */

const T0 = 1_700_000_000_000;
const WS = "w-dev";

let sequence = 0;
function event(over: Partial<SequencedControlEvent> & Pick<SequencedControlEvent, "kind">): SequencedControlEvent {
  sequence += 1;
  return { id: `e${sequence}`, sessionId: "s1", provider: "gemini", timestamp: T0 + sequence * 1_000, summary: "", sequence, ...over };
}

function view(status: AgentSessionStatus): RuntimeSessionView {
  return {
    sessionId: "s1",
    provider: "gemini",
    status,
    workspaceId: WS,
    projectId: "proj-app",
    runIds: ["r1"],
    awaitingApproval: status === "waiting_for_approval",
    cancellable: false,
    resumable: false,
    latestSequence: sequence,
    createdAt: T0,
    updatedAt: T0,
  };
}

const approval: RuntimeApprovalView = {
  approvalId: "a1",
  sessionId: "s1",
  provider: "gemini",
  action: "modify_files",
  scope: "write_project",
  projectId: "proj-app",
  targets: ["src/app/api/auth/route.ts", "src/lib/session.ts"],
  requestedAt: T0,
  expiresAt: T0 + 600_000,
};

const sent = (text: string) => event({ kind: "message_sent", summary: "Message sent.", text });
const replied = (text: string) => event({ kind: "message_received", summary: "Reply.", text, messageId: `m${sequence + 1}` });
const done = () => event({ kind: "run_completed", summary: "Finished." });
const changed = (changeId = "a1", outcome: "applied" | "partial" | "not_applied" = "applied") =>
  event({
    kind: "project_changed",
    summary: "Changed 2 files.",
    projectChange: {
      changeId,
      projectId: "proj-app",
      outcome,
      undo: "available",
      files: [
        { path: "src/app/api/auth/route.ts", change: "modified", added: 12, removed: 4 },
        { path: "src/lib/session.ts", change: outcome === "partial" ? "unchanged" : "modified", added: 5, removed: 2 },
      ],
    },
  });
const check = (check: "test" | "lint" | "git_status", outcome: "passed" | "failed", changeId = "a1") => [
  event({ kind: "verification_started", summary: "Check.", verification: { checkId: `c${sequence}`, projectId: "proj-app", check, outcome: "running", changeId } }),
  event({ kind: "verification_finished", summary: "Check.", verification: { checkId: `c${sequence - 1}`, projectId: "proj-app", check, outcome, changeId } }),
];

function outcomeOf(status: AgentSessionStatus, events: SequencedControlEvent[], extra: { approvals?: RuntimeApprovalView[]; handoffs?: SessionHandoff[] } = {}) {
  const session = view(status);
  const entries = buildAgentActivityTimeline({
    session,
    events,
    ...(extra.approvals ? { approvals: extra.approvals } : {}),
    agentName: "Gemini CLI",
    workspaceName: "Development",
    now: T0 + 120_000,
  });
  return taskOutcome({
    status,
    sessionId: "s1",
    events,
    entries,
    ...extra,
    agentName: "Gemini CLI",
    projectName: "hubble-app",
  });
}

describe("taskOutcome", () => {
  it("is ready, and says so, before the first task", () => {
    sequence = 0;
    const outcome = outcomeOf("ready", [event({ kind: "session_started", summary: "Session started." })]);
    expect(outcome.state).toBe("ready");
    expect(outcome.headline).toBe("Gemini CLI is ready for a task");
    expect(outcome.task).toBeUndefined();
  });

  it("is working while the run is live, with the task the developer gave", () => {
    sequence = 0;
    const outcome = outcomeOf("running", [sent("Fix the authentication bug.")]);
    expect(outcome.state).toBe("working");
    expect(outcome.task).toBe("Fix the authentication bug.");
  });

  it("needs the developer when stopped on an approval, and names what it asks", () => {
    sequence = 0;
    const events = [sent("Fix the authentication bug."), event({ kind: "approval_requested", summary: "Approval.", approvalId: "a1" })];
    const outcome = outcomeOf("waiting_for_approval", events, { approvals: [approval] });
    expect(outcome.state).toBe("needs_you");
    expect(outcome.approval?.approvalId).toBe("a1");
    expect(outcome.headline).toMatch(/^Approve: /);
    expect(taskNeedsAttention(outcome)).toBe(true);
  });

  it("closes a finished task with what changed, measured, and the checks run since", () => {
    sequence = 0;
    const events = [
      ...check("test", "failed"), // before the change: verified older code, not counted
      sent("Fix the authentication bug."),
      event({ kind: "approval_requested", summary: "Approval.", approvalId: "a1" }),
      event({ kind: "approval_granted", summary: "Approved.", approvalId: "a1" }),
      replied("## Fixed\nThe route awaits verifyPassword now."),
      done(),
      changed(),
      ...check("test", "passed"),
      ...check("git_status", "passed"),
    ];
    const outcome = outcomeOf("ready", events);
    expect(outcome.state).toBe("done");
    expect(outcome.headline).toBe("Changed 2 files in hubble-app");
    expect(outcome.changes).toMatchObject({ files: 2, added: 17, removed: 6, counted: true, latestProjectChangeId: "a1" });
    expect(outcome.checks.map((entry) => `${entry.label}:${entry.outcome}`)).toEqual(["Tests:passed"]);
    expect(taskOutcomeFacts(outcome, { checksAvailable: true })).toEqual(["+17 −6", "Tests passed"]);
    expect(taskNeedsAttention(outcome)).toBe(false);
  });

  it("says checks were not run when the project has them and none ran", () => {
    sequence = 0;
    const outcome = outcomeOf("ready", [sent("Fix it."), done(), changed()]);
    expect(taskOutcomeFacts(outcome, { checksAvailable: true })).toEqual(["+17 −6", "Checks not run"]);
    expect(taskOutcomeFacts(outcome, { checksAvailable: false })).toEqual(["+17 −6"]);
  });

  it("flags a failed check and a partial change as needing attention", () => {
    sequence = 0;
    const failedCheck = outcomeOf("ready", [sent("Fix it."), done(), changed(), ...check("lint", "failed")]);
    expect(taskOutcomeFacts(failedCheck)).toContain("Lint failed");
    expect(taskNeedsAttention(failedCheck)).toBe(true);
    sequence = 0;
    const partial = outcomeOf("ready", [sent("Fix it."), done(), changed("a1", "partial")]);
    expect(partial.headline).toBe("Partly applied in hubble-app — check the project before continuing");
    expect(taskNeedsAttention(partial)).toBe(true);
  });

  it("does not count a change that was undone", () => {
    sequence = 0;
    const events = [
      sent("Fix it."),
      done(),
      changed(),
      event({ kind: "project_change_undone", summary: "Undone.", projectUndo: { changeId: "a1", projectId: "proj-app", outcome: "undone", files: 2 } }),
    ];
    const outcome = outcomeOf("ready", events);
    expect(outcome.changes.files).toBe(0);
    expect(outcome.changes.latestProjectChangeId).toBeUndefined();
    expect(outcome.headline).toBe("Nothing changed — you undid the change");
  });

  it("says nothing changed when the developer rejected the change", () => {
    sequence = 0;
    const events = [
      sent("Fix it."),
      event({ kind: "approval_requested", summary: "Approval.", approvalId: "a1" }),
      event({ kind: "approval_denied", summary: "Rejected.", approvalId: "a1" }),
      replied("Understood — I left the files as they were."),
      done(),
    ];
    const outcome = outcomeOf("ready", events);
    expect(outcome.state).toBe("done");
    expect(outcome.headline).toBe("Nothing changed — you rejected the change");
    expect(outcome.rejected).toBe(1);
  });

  it("reports a failure as the agent's, by name", () => {
    sequence = 0;
    const outcome = outcomeOf("failed", [sent("Fix it."), event({ kind: "error", summary: "The agent exited." })]);
    expect(outcome.state).toBe("failed");
    expect(outcome.headline).toBe("Gemini CLI stopped unexpectedly");
    expect(taskNeedsAttention(outcome)).toBe(true);
  });

  it("takes a handed-off session's task from the handoff's instruction, never its envelope", () => {
    sequence = 0;
    const handoff: SessionHandoff = {
      handoffId: "h1",
      workspaceId: WS,
      sourceSessionId: "s0",
      sourceProvider: "claude-code",
      targetProvider: "gemini",
      targetSessionId: "s1",
      status: "ready",
      context: {},
      instruction: "Add a test for the sign-in route.",
      createdAt: T0,
      updatedAt: T0,
    };
    const events = [
      event({ kind: "handoff_received", summary: "Handoff.", handoff: { handoffId: "h1", workspaceId: WS, peerProvider: "claude-code", peerSessionId: "s0" } }),
      event({ kind: "message_sent", summary: "Sent.", text: "HUBBLE HANDOFF … envelope …", handoff: { handoffId: "h1", workspaceId: WS, peerProvider: "claude-code" } }),
    ];
    const outcome = outcomeOf("running", events, { handoffs: [handoff] });
    expect(outcome.task).toBe("Add a test for the sign-in route.");
  });

  it("ignores another session's records", () => {
    sequence = 0;
    const outcome = outcomeOf("ready", [sent("Fix it."), done(), { ...changed(), sessionId: "s2" }]);
    expect(outcome.changes.files).toBe(0);
  });
});

describe("oneLine", () => {
  it("keeps the first line, without markdown marks, bounded", () => {
    expect(oneLine("\n\n# Plan\n- step")).toBe("Plan");
    expect(oneLine("   ")).toBeUndefined();
    expect(oneLine("x".repeat(400), 20)).toHaveLength(20);
  });
});
