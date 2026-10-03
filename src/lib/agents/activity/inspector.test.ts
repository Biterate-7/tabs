import { beforeEach, describe, expect, it } from "vitest";
import { inspectActivityEntry, isInspectable } from "./inspector";
import { buildAgentActivityTimeline } from "./timeline";
import type { ActionInspection, ActionInspectorInput } from "./inspector";
import type { AgentActivityEntry } from "./timeline";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { Collection } from "@/lib/collections/types";
import type { RuntimeApprovalView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol";

/**
 * The action inspector's model over the records a real session produces —
 * the journal's events, the broker's approvals, the changes the Command
 * Centre applied — joined by the references the timeline keeps, never by
 * wording. Each fixture follows the order the runtime actually journals.
 */

const T0 = 1_700_000_000_000;
const WS = "w-research";

function session(over: Partial<RuntimeSessionView> = {}): RuntimeSessionView {
  return {
    sessionId: "s1",
    provider: "claude-code",
    status: "ready",
    workspaceId: WS,
    runIds: ["cr-1"],
    awaitingApproval: false,
    cancellable: false,
    resumable: false,
    latestSequence: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

let sequence = 0;
beforeEach(() => {
  sequence = 0;
});
function event(over: Partial<SequencedControlEvent> & Pick<SequencedControlEvent, "kind">): SequencedControlEvent {
  sequence += 1;
  return { id: `e${sequence}`, sessionId: "s1", provider: "claude-code", timestamp: T0 + sequence * 1_000, summary: "", sequence, ...over };
}

const started = () => event({ kind: "session_started", summary: "Session started." });

/** A workspace change approval, as the broker reports it for Hubble's own request. */
function workspaceApproval(over: Partial<RuntimeApprovalView> = {}): RuntimeApprovalView {
  return {
    approvalId: "wa-1",
    sessionId: "s1",
    provider: "claude-code",
    action: "change_workspace",
    scope: "write_workspace",
    workspaceId: WS,
    targets: [`New collection "Pricing Research"`],
    reason: "Create a collection in this workspace.",
    change: { kind: "create_collection", subject: "Pricing Research", tabCount: 5, details: [] },
    requestedAt: T0 + 2_000,
    expiresAt: T0 + 10 * 60_000,
    ...over,
  };
}

function fileApproval(over: Partial<RuntimeApprovalView> = {}): RuntimeApprovalView {
  return {
    approvalId: "a-file",
    sessionId: "s1",
    provider: "claude-code",
    action: "create_files",
    scope: "write_project",
    projectId: "p1",
    targets: ["notes/research-summary.md"],
    reason: "Create research-summary.md from the research collected in this workspace.",
    requestedAt: T0 + 3_000,
    expiresAt: T0 + 10 * 60_000,
    ...over,
  };
}

const sources: Collection = { id: "c1", workspaceId: WS, name: "Sources", tabIds: ["t1"], createdAt: 0, updatedAt: 0 };
const pricing: Collection = { id: "c9", workspaceId: WS, name: "Pricing Research", tabIds: ["t2", "t3", "t4", "t5", "t6"], createdAt: 1, updatedAt: 1 };

function appliedCreate(over: Partial<AppliedWorkspaceChange> = {}): AppliedWorkspaceChange {
  return {
    id: "ctxa-1",
    sessionId: "s1",
    provider: "claude-code",
    workspaceId: WS,
    at: T0 + 50_000,
    ok: true,
    approvalId: "wa-1",
    steps: [{ kind: "created", collectionId: "c9", name: "Pricing Research", tabCount: 5 }],
    before: [sources],
    after: [sources, pricing],
    ...over,
  };
}

type Records = Omit<ActionInspectorInput, "entries" | "agentName"> & { now?: number };

/** Builds the timeline from the records, then inspects the entry titled (or with the id) given. */
function open(records: Records, which: string | ((entry: AgentActivityEntry) => boolean)): { inspection: ActionInspection | null; entries: AgentActivityEntry[] } {
  const entries = buildAgentActivityTimeline({
    session: records.session,
    events: records.events,
    ...(records.approvals ? { approvals: records.approvals } : {}),
    ...(records.knownApprovals ? { knownApprovals: records.knownApprovals } : {}),
    ...(records.changes ? { changes: records.changes } : {}),
    agentName: "Claude Code",
    workspaceName: "Research",
    now: records.now ?? T0 + 60_000,
  });
  const match = typeof which === "string" ? (entry: AgentActivityEntry) => entry.title === which || entry.id === which : which;
  const entry = entries.find(match);
  if (!entry) throw new Error(`No entry ${String(which)} in: ${entries.map((candidate) => candidate.title).join(", ")}`);
  const inspection = inspectActivityEntry(entry.id, {
    entries,
    agentName: "Claude Code",
    workspaceName: "Research",
    ...records,
  });
  return { inspection, entries };
}

/** Everything the inspector puts in front of a person, as one string. */
function shown(inspection: ActionInspection): string {
  return [
    inspection.title,
    inspection.action,
    inspection.request?.summary,
    inspection.request?.reason,
    inspection.result?.text,
    ...inspection.chain.map((step) => step.label),
    ...(inspection.changes?.lines.map((line) => line.text) ?? []),
    inspection.file?.relativePath,
    inspection.undo?.kind === "available" ? inspection.undo.effects.join(" ") : inspection.undo?.kind === "unavailable" ? inspection.undo.reason : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/** A workspace change from request to application: Hubble's own request event, a decision, the applied change. */
function approvedCollectionRecords(change: AppliedWorkspaceChange = appliedCreate()): Records {
  return {
    session: session(),
    events: [
      started(),
      event({ kind: "tool_started", summary: "create_collection", tool: { name: "mcp__tabdump_x__create_collection", callId: "c1" } }),
      event({ kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: "wa-1" }),
      event({ kind: "approval_granted", summary: "Approved", approvalId: "wa-1" }),
    ],
    knownApprovals: new Map([["wa-1", workspaceApproval()]]),
    changes: [change],
    canUndo: () => true,
  };
}

describe("opening an action", () => {
  it("opens from a completed event and says what the action was, what it did and what changed", () => {
    const { inspection } = open(approvedCollectionRecords(), "Created collection “Pricing Research”");
    expect(inspection).toMatchObject({
      title: "Created collection “Pricing Research”",
      status: "completed",
      agentName: "Claude Code",
      workspaceName: "Research",
      action: "Create collection",
      result: { tone: "success", text: "Created “Pricing Research” in Research." },
      changes: { planned: false, lines: [{ sign: "add", text: "Collection “Pricing Research” · 5 tabs" }] },
      view: { changeId: "ctxa-1", label: "Open collection" },
    });
  });

  it("shows the approval that authorized it: who asked, what they asked, and when it was approved", () => {
    const { inspection } = open(approvedCollectionRecords(), "Created collection “Pricing Research”");
    expect(inspection!.request).toEqual({
      summary: "Create collection “Pricing Research” · 5 tabs",
      reason: "Create a collection in this workspace.",
      // When the journal recorded the request, as the timeline row says.
      at: T0 + 3_000,
    });
    expect(inspection!.chain.map((step) => [step.key, step.label])).toEqual([
      ["requested", "Requested by Claude Code"],
      ["decision", "Approved"],
      ["result", "Completed"],
    ]);
    expect(inspection!.chain[1]!.at).toBe(T0 + 4_000);
  });

  it("resolves the same action from the request, the decision and the result", () => {
    const records = approvedCollectionRecords();
    const fromResult = open(records, "Created collection “Pricing Research”").inspection!;
    const fromRequest = open(records, "Asked for approval").inspection!;
    const fromDecision = open(records, "Action approved").inspection!;
    expect(fromRequest.key).toBe(fromResult.key);
    expect(fromDecision.key).toBe(fromResult.key);
    expect(fromRequest.status).toBe("completed");
    expect(fromDecision.title).toBe("Created collection “Pricing Research”");
  });

  it("links a plan's change to its approval through the plan's outcome", () => {
    const records = approvedCollectionRecords(appliedCreate({ approvalId: undefined, planId: "plan-1" }));
    records.session = session({
      context: {
        workspaceId: WS,
        workspaceName: "Research",
        capabilities: [],
        version: 2,
        syncedAt: T0,
        fingerprint: "f",
        pendingActions: [],
        planOutcomes: [{ planId: "plan-1", approvalId: "wa-1", status: "applied", operationCount: 1, verifiedCount: 1, contextVersion: 2, at: T0 + 51_000 }],
      },
    });
    const { inspection } = open(records, "Created collection “Pricing Research”");
    expect(inspection!.key).toBe("approval:wa-1");
    expect(inspection!.request?.summary).toBe("Create collection “Pricing Research” · 5 tabs");
  });

  it("does not open informational entries", () => {
    const { entries } = open(approvedCollectionRecords(), "Claude Code connected");
    const connected = entries.find((entry) => entry.title === "Claude Code connected")!;
    expect(isInspectable(connected)).toBe(false);
    expect(inspectActivityEntry(connected.id, { entries, session: session(), events: [], agentName: "Claude Code" })).toBeNull();
  });

  it("handles missing optional data — a change with no approval on record still opens, with only what exists", () => {
    const records: Records = { session: session(), events: [started()], changes: [appliedCreate({ approvalId: undefined, before: undefined, after: undefined })] };
    const { inspection } = open(records, "Created collection “Pricing Research”");
    expect(inspection!.request).toBeUndefined();
    expect(inspection!.chain.map((step) => step.key)).toEqual(["result"]);
    expect(inspection!.undo).toEqual({ kind: "unavailable", reason: "Undo isn't available for this change." });
    expect(inspection!.file).toBeUndefined();
  });

  it("names a file the agent created, with its project, and never offers to open it", () => {
    const records: Records = {
      session: session({ projectId: "p1" }),
      projectName: "hubble-web",
      events: [
        started(),
        event({ kind: "tool_started", summary: "Write", tool: { name: "Write", callId: "w1" } }),
        event({ kind: "file_created", summary: "notes/research-summary.md", file: { relativePath: "notes/research-summary.md", projectId: "p1" } }),
        event({ kind: "approval_requested", summary: "Create research-summary.md", approvalId: "a-file", tool: { name: "Write", callId: "w1" } }),
        event({ kind: "approval_granted", summary: "Approved", approvalId: "a-file" }),
        event({ kind: "tool_finished", summary: "Write", tool: { name: "Write", callId: "w1", ok: true } }),
      ],
      knownApprovals: new Map([["a-file", fileApproval()]]),
    };
    const { inspection } = open(records, "Created research-summary.md");
    expect(inspection).toMatchObject({
      status: "completed",
      action: "Create file",
      request: { summary: "Create research-summary.md", reason: "Create research-summary.md from the research collected in this workspace." },
      result: { tone: "success", text: "Created notes/research-summary.md in hubble-web." },
      changes: { planned: false, lines: [{ sign: "add", text: "notes/research-summary.md" }] },
      file: { relativePath: "notes/research-summary.md", projectName: "hubble-web" },
    });
    expect(inspection!.view).toBeUndefined();
  });

  it("never shows an id, a tool name or a protocol verb", () => {
    const { inspection } = open(approvedCollectionRecords(), "Created collection “Pricing Research”");
    const text = shown(inspection!);
    expect(text).not.toMatch(/wa-1|ctxa|s1\b|c9|mcp__|create_collection|change_workspace|write_workspace|approval_/);
  });
});

describe("status comes from the records, never from the request", () => {
  it("a requested action is not a created one: waiting shows what was asked, not a result", () => {
    const records: Records = {
      session: session({ status: "waiting_for_approval", awaitingApproval: true }),
      events: [started(), event({ kind: "approval_requested", summary: "Create research-summary.md", approvalId: "a-file" })],
      approvals: [fileApproval()],
    };
    const { inspection } = open(records, "Waiting for approval");
    expect(inspection).toMatchObject({ status: "waiting_for_approval", title: "Create research-summary.md" });
    expect(inspection!.title).not.toMatch(/^Created/);
    expect(inspection!.result).toBeUndefined();
    expect(inspection!.changes).toEqual({ planned: true, lines: [{ sign: "add", text: "notes/research-summary.md" }] });
    expect(inspection!.undo).toBeUndefined();
    expect(inspection!.chain.map((step) => step.label)).toEqual(["Requested by Claude Code", "Waiting for approval"]);
  });

  it("follows one action live: waiting → approved → running → completed", () => {
    const requested = [started(), event({ kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: "wa-1" })];
    const granted = event({ kind: "approval_granted", summary: "Approved", approvalId: "wa-1" });
    const statuses: string[] = [];
    const inspect = (records: Records) => statuses.push(open(records, (entry) => entry.id === "approval:wa-1").inspection!.status);

    inspect({ session: session({ status: "waiting_for_approval" }), events: requested, approvals: [workspaceApproval()] });
    // Approved, while the session is not (yet) running.
    inspect({ session: session({ status: "ready" }), events: [...requested, granted], knownApprovals: new Map([["wa-1", workspaceApproval()]]) });
    inspect({ session: session({ status: "running" }), events: [...requested, granted], knownApprovals: new Map([["wa-1", workspaceApproval()]]) });
    inspect({
      session: session({ status: "running" }),
      events: [...requested, granted],
      knownApprovals: new Map([["wa-1", workspaceApproval()]]),
      changes: [appliedCreate()],
    });
    expect(statuses).toEqual(["waiting_for_approval", "approved", "running", "completed"]);
  });

  it("waiting → rejected: nothing changed, and nothing to undo", () => {
    const records: Records = {
      session: session(),
      events: [
        started(),
        event({ kind: "approval_requested", summary: "Wants to change your Hubble workspace", approvalId: "wa-1" }),
        event({ kind: "approval_denied", summary: "Denied", approvalId: "wa-1" }),
      ],
      knownApprovals: new Map([["wa-1", workspaceApproval()]]),
    };
    const { inspection } = open(records, "Action rejected");
    expect(inspection).toMatchObject({
      status: "rejected",
      title: "Create collection “Pricing Research” · 5 tabs",
      result: { tone: "neutral", text: "You rejected it. Nothing was changed." },
    });
    expect(inspection!.chain.map((step) => step.label)).toEqual(["Requested by Claude Code", "Rejected"]);
    expect(inspection!.undo).toBeUndefined();
    expect(inspection!.view).toBeUndefined();
  });

  it("running → failed: a tool that did not finish is a failure, with no undo", () => {
    const begin = [
      started(),
      event({ kind: "tool_started", summary: "Write", tool: { name: "Write", callId: "w1" } }),
      event({ kind: "file_created", summary: "x", file: { relativePath: "notes/research-summary.md", projectId: "p1" } }),
      event({ kind: "approval_requested", summary: "Create research-summary.md", approvalId: "a-file", tool: { name: "Write", callId: "w1" } }),
      event({ kind: "approval_granted", summary: "Approved", approvalId: "a-file" }),
    ];
    const known = new Map([["a-file", fileApproval()]]);
    const running = open({ session: session({ status: "running" }), events: begin, knownApprovals: known }, "Action approved").inspection!;
    expect(running.status).toBe("running");

    const failed = open(
      {
        session: session({ status: "ready" }),
        events: [...begin, event({ kind: "tool_finished", summary: "Write", tool: { name: "Write", callId: "w1", ok: false } })],
        knownApprovals: known,
      },
      "Action approved"
    ).inspection!;
    expect(failed).toMatchObject({
      key: running.key,
      status: "failed",
      title: "Couldn't create research-summary.md",
      result: { tone: "failure", text: "Claude Code couldn't create research-summary.md." },
    });
    expect(failed.undo).toBeUndefined();
    expect(failed.chain.at(-1)).toMatchObject({ key: "result", label: "Failed", tone: "failed" });
  });

  it("a change the Command Centre could not apply is failed, and says nothing changed", () => {
    const { inspection } = open(approvedCollectionRecords(appliedCreate({ ok: false, steps: [], before: undefined, after: undefined })), "Couldn't apply the approved change");
    expect(inspection).toMatchObject({ status: "failed", result: { tone: "failure", text: "Couldn't apply the approved change. Nothing was changed." } });
    expect(inspection!.undo).toBeUndefined();
  });

  it("an approval nobody answered in time is expired, not failed", () => {
    const records: Records = {
      session: session(),
      events: [started(), event({ kind: "approval_requested", summary: "x", approvalId: "wa-1" })],
      knownApprovals: new Map([["wa-1", workspaceApproval({ expiresAt: T0 + 30_000 })]]),
      now: T0 + 60_000,
    };
    const { inspection } = open(records, "Approval expired");
    expect(inspection).toMatchObject({ status: "expired", result: { tone: "neutral" } });
  });
});

describe("undo", () => {
  it("is offered for a change Hubble applied with both sides of it in hand, and says exactly what it will do", () => {
    const { inspection } = open(approvedCollectionRecords(), "Created collection “Pricing Research”");
    expect(inspection!.undo).toEqual({ kind: "available", changeId: "ctxa-1", effects: ["Remove the collection “Pricing Research”"], label: "Undo" });
  });

  it("says Undo all for several changes applied as one", () => {
    const change = appliedCreate({
      steps: [
        { kind: "created", collectionId: "c9", name: "Pricing Research", tabCount: 5 },
        { kind: "renamed", collectionId: "c1", name: "Primary sources", previousName: "Sources" },
        { kind: "added", collectionId: "c1", name: "Primary sources", tabCount: 2 },
      ],
    });
    const { inspection } = open(approvedCollectionRecords(change), "Updated Research");
    expect(inspection!.undo).toMatchObject({
      kind: "available",
      label: "Undo all",
      effects: ["Remove the collection “Pricing Research”", "Rename “Primary sources” back to “Sources”", "Take 2 tabs back out of “Primary sources”"],
    });
    expect(inspection!.view?.label).toBe("View changes");
    expect(inspection!.changes!.lines).toEqual([
      { sign: "add", text: "Collection “Pricing Research” · 5 tabs" },
      { sign: "change", text: "“Sources” renamed to “Primary sources”" },
      { sign: "add", text: "2 tabs added to “Primary sources”" },
    ]);
  });

  it("is not offered once the workspace has changed since — and says why", () => {
    const records = { ...approvedCollectionRecords(), canUndo: () => false };
    const { inspection } = open(records, "Created collection “Pricing Research”");
    expect(inspection!.undo).toMatchObject({ kind: "unavailable" });
    expect((inspection!.undo as { reason: string }).reason).toMatch(/workspace has changed since/);
  });

  it("is never offered for a file: Hubble keeps no copy to put back", () => {
    const records: Records = {
      session: session(),
      events: [started(), event({ kind: "file_created", summary: "x", file: { relativePath: "notes/a.md", projectId: "p1" } })],
      canUndo: () => true,
    };
    const { inspection } = open(records, "Created a.md");
    expect(inspection!.undo).toMatchObject({ kind: "unavailable" });
    expect((inspection!.undo as { reason: string }).reason).toMatch(/^Undo isn't available for this change\./);
  });

  it("an undone change is Undone, keeps what it did, and has no View", () => {
    const records = approvedCollectionRecords(appliedCreate({ undone: true, undoneAt: T0 + 55_000 }));
    const { inspection, entries } = open(records, "Created collection “Pricing Research”");
    expect(inspection).toMatchObject({ status: "undone", title: "Created collection “Pricing Research”", undo: { kind: "done", at: T0 + 55_000 } });
    expect(inspection!.view).toBeUndefined();
    expect(inspection!.chain.at(-1)).toMatchObject({ key: "undone", label: "Undone", at: T0 + 55_000 });
    // The undo's own entry opens the same action.
    const undoEntry = entries.find((entry) => entry.kind === "undone")!;
    expect(inspectActivityEntry(undoEntry.id, { ...records, entries, agentName: "Claude Code" })!.key).toBe(inspection!.key);
  });
});

describe("isolation", () => {
  it("never joins a change made in another workspace or for another session, even with the same approval id", () => {
    const records = approvedCollectionRecords();
    records.changes = [
      appliedCreate({ id: "other-ws", workspaceId: "w-personal" }),
      appliedCreate({ id: "other-session", sessionId: "s2" }),
    ];
    const { inspection, entries } = open(records, "Action approved");
    // Approved, with nothing applied in this session's workspace: only what was asked.
    expect(inspection!.status).toBe("approved");
    expect(inspection!.changes?.planned).toBe(true);
    expect(inspection!.undo).toBeUndefined();
    expect(entries.some((entry) => entry.refs?.changeId)).toBe(false);
  });

  it("never uses an approval remembered for another session", () => {
    const records: Records = {
      session: session(),
      events: [started(), event({ kind: "approval_requested", summary: "Asked", approvalId: "wa-1" }), event({ kind: "approval_granted", approvalId: "wa-1" })],
      knownApprovals: new Map([["wa-1", workspaceApproval({ sessionId: "s2", reason: "Another session's reason." })]]),
    };
    const { inspection } = open(records, "Action approved");
    expect(inspection!.request?.reason).toBeUndefined();
  });
});

describe("a failed step the agent could not name", () => {
  it("is titled by what was approved, and says the agent reported it failed", () => {
    // ACP's order for a failed edit: no file event, only a failed call.
    const records: Records = {
      session: session({ provider: "gemini" }),
      events: [
        started(),
        event({ kind: "tool_started", summary: "Editing files", tool: { name: "Edit", callId: "t1" } }),
        event({ kind: "approval_requested", summary: "Editing files", approvalId: "a-file", tool: { name: "Edit", callId: "t1" } }),
        event({ kind: "approval_granted", summary: "Approved", approvalId: "a-file" }),
        event({ kind: "tool_finished", summary: "Edit failed", tool: { name: "Edit", callId: "t1", ok: false } }),
      ],
      knownApprovals: new Map([["a-file", fileApproval({ action: "modify_files", targets: ["notes/research-summary.md"] })]]),
    };
    const { inspection } = open(records, "A step didn't work");
    expect(inspection).toMatchObject({
      status: "failed",
      title: "Edit research-summary.md",
      action: "Edit file",
      result: { tone: "failure", text: "Claude Code reported that it didn't work." },
    });
    expect(inspection!.undo).toBeUndefined();
  });
});
