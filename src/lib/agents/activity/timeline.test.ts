import { describe, expect, it } from "vitest";
import { buildAgentActivityTimeline, describeApproval } from "./timeline";
import type { AgentActivityEntry, AgentActivityInput } from "./timeline";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { RuntimeApprovalView, RuntimeSessionView, SequencedControlEvent } from "@/lib/agents/runtime/protocol";

/**
 * The timeline builder, over the records a real session produces.
 *
 * Every fixture below is shaped like what the runtime actually journals for
 * the provider named — Claude's tool/file/approval order, an ACP agent's
 * lifecycle, the context server's own events — because the builder's job is
 * to read those faithfully, not to read an idealised stream.
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
function event(over: Partial<SequencedControlEvent> & Pick<SequencedControlEvent, "kind">): SequencedControlEvent {
  sequence += 1;
  return {
    id: `e${sequence}`,
    sessionId: "s1",
    provider: "claude-code",
    timestamp: T0 + sequence * 1_000,
    summary: "",
    sequence,
    ...over,
  };
}

const started = () => event({ kind: "session_started", summary: "Session started." });
const loaded = (tabs = 18, collections = 3) =>
  event({ kind: "context_loaded", summary: "x", context: { workspaceId: WS, tabs, collections } });
const read = (operation: string, counts: Record<string, number> = {}, ok = true) =>
  event({ kind: "context_read", summary: "x", context: { workspaceId: WS, operation, ok, ...counts } });

function approval(over: Partial<RuntimeApprovalView> = {}): RuntimeApprovalView {
  return {
    approvalId: "a1",
    sessionId: "s1",
    provider: "claude-code",
    action: "create_files",
    scope: "write_project",
    projectId: "p1",
    targets: ["research-summary.md"],
    requestedAt: T0,
    expiresAt: T0 + 10 * 60_000,
    ...over,
  };
}

function build(over: Partial<AgentActivityInput> & { events: SequencedControlEvent[] }): AgentActivityEntry[] {
  return buildAgentActivityTimeline({
    session: session(),
    agentName: "Claude Code",
    workspaceName: "Research",
    now: T0 + 60_000,
    ...over,
  });
}

const titles = (entries: readonly AgentActivityEntry[]) => entries.map((entry) => entry.title);
const byKind = (entries: readonly AgentActivityEntry[], kind: string) => entries.filter((entry) => entry.kind === kind);

describe("event creation, from real records", () => {
  it("a connection creates a 'connected' entry, first, naming the workspace", () => {
    const [first] = build({ events: [started()] });
    expect(first).toMatchObject({ kind: "connected", status: "info", title: "Claude Code connected", description: "Working in Research" });
  });

  it("the context server's own event creates 'Workspace context loaded' with the counts it reported", () => {
    const entries = build({ events: [started(), loaded(18, 3)] });
    expect(entries[1]).toMatchObject({ kind: "context_loaded", title: "Workspace context loaded", description: "18 tabs · 3 collections" });
    expect(entries[1]!.metadata).toEqual({ tabs: 18, collections: 3 });
  });

  it("a workspace read creates 'Read workspace' with what the answer covered", () => {
    const entries = build({ events: [started(), read("get_workspace_summary", { tabs: 18, collections: 3 })] });
    expect(entries.at(-1)).toMatchObject({ kind: "reading", status: "completed", title: "Read workspace", description: "18 tabs · 3 collections · Research" });
  });

  it("a search creates 'Found N relevant tabs' from the search's own total", () => {
    const entries = build({ events: [started(), read("search_tabs", { matches: 14, tabs: 10 })] });
    expect(entries.at(-1)).toMatchObject({ kind: "searching", title: "Found 14 relevant tabs", description: "Searched Research" });
  });

  it("a search that found nothing says so rather than claiming a result", () => {
    const entries = build({ events: [started(), read("search_tabs", { matches: 0 })] });
    expect(entries.at(-1)!.title).toBe("No matching tabs found");
  });

  it("an action request creates a waiting entry that says what is asked", () => {
    const entries = build({
      session: session({ status: "waiting_for_approval", awaitingApproval: true }),
      events: [started(), event({ kind: "approval_requested", approvalId: "a1", summary: "Write research-summary.md" })],
      approvals: [approval()],
    });
    expect(entries.at(-1)).toMatchObject({
      kind: "approval_required",
      status: "waiting",
      title: "Waiting for approval",
      description: "Create research-summary.md",
    });
  });

  it("an approval creates 'Approved' and the request stops waiting", () => {
    const entries = build({
      events: [
        started(),
        event({ kind: "approval_requested", approvalId: "a1" }),
        event({ kind: "approval_granted", approvalId: "a1", summary: "Approved" }),
      ],
      knownApprovals: new Map([["a1", approval()]]),
    });
    expect(titles(entries).slice(1)).toEqual(["Asked for approval", "Approved"]);
    expect(entries[1]!.status).toBe("info");
    expect(entries[2]).toMatchObject({ kind: "action_approved", status: "completed", description: "Create research-summary.md" });
  });

  it("a rejection creates 'Rejected', not a failure", () => {
    const entries = build({
      events: [started(), event({ kind: "approval_requested", approvalId: "a1" }), event({ kind: "approval_denied", approvalId: "a1" })],
      knownApprovals: new Map([["a1", approval()]]),
    });
    expect(entries.at(-1)).toMatchObject({ kind: "action_rejected", title: "Rejected", status: "info" });
    expect(entries.some((entry) => entry.status === "failed")).toBe(false);
  });

  it("an action completing creates 'Created <file>' from the event that reported it", () => {
    const entries = build({
      session: session({ provider: "openai-codex" }),
      events: [started(), event({ kind: "file_created", summary: "notes/research-summary.md", file: { relativePath: "notes/research-summary.md", projectId: "p1" } })],
      agentName: "Codex",
    });
    expect(entries.at(-1)).toMatchObject({ kind: "created", status: "completed", title: "Created research-summary.md", description: "notes/research-summary.md" });
  });

  it("a failed step creates a failure entry with a short, safe explanation", () => {
    const entries = build({
      events: [
        started(),
        event({ kind: "tool_started", summary: "Write", tool: { name: "Write", callId: "c1" } }),
        event({ kind: "file_modified", summary: "Edited report.md", file: { relativePath: "report.md", projectId: "p1" } }),
        event({ kind: "tool_finished", summary: "Tool failed", tool: { name: "tool", callId: "c1", ok: false } }),
      ],
    });
    expect(entries.at(-1)).toMatchObject({ kind: "action_failed", status: "failed", title: "Couldn't edit report.md" });
  });

  it("an error event creates a failure entry from the adapter's own sentence, with no stack", () => {
    const entries = build({
      session: session({ status: "failed" }),
      events: [started(), event({ kind: "error", summary: "The agent stopped with an error." })],
    });
    const failure = entries.at(-1)!;
    expect(failure).toMatchObject({ kind: "error", status: "failed", title: "Claude Code stopped unexpectedly", description: "The agent stopped with an error" });
    expect(failure.action).toEqual({ kind: "new_session" });
    // Said once, even though the session's status also says it failed.
    expect(entries.filter((entry) => entry.status === "failed")).toHaveLength(1);
  });

  it("a read Hubble refused is a failure, not a silent gap", () => {
    const entries = build({ events: [started(), read("get_tabs", {}, false)] });
    expect(entries.at(-1)).toMatchObject({ kind: "context_failed", status: "failed", title: "Couldn't read the workspace" });
  });

  it("an applied workspace change creates an entry in the user's words, with View", () => {
    const change: AppliedWorkspaceChange = {
      id: "ctxa-1",
      sessionId: "s1",
      provider: "claude-code",
      workspaceId: WS,
      at: T0 + 50_000,
      ok: true,
      steps: [{ kind: "created", collectionId: "c9", name: "Physics", tabCount: 4 }],
    };
    const entries = build({ events: [started()], changes: [change] });
    expect(entries.at(-1)).toMatchObject({
      kind: "created",
      title: "Created collection “Physics”",
      description: "4 tabs",
      action: { kind: "view_change", changeId: "ctxa-1" },
    });
  });
});

describe("grouping", () => {
  it("folds a run of reads into one entry, claiming the most any single answer covered", () => {
    const entries = build({
      events: [
        started(),
        read("list_tabs", { tabs: 50 }),
        read("list_tabs", { tabs: 50 }),
        read("get_tabs", { tabs: 12 }),
        read("list_collections", { collections: 3 }),
      ],
    });
    const reads = byKind(entries, "reading");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ count: 4, description: "50 tabs · 3 collections · Research" });
  });

  it("starts a new entry when the agent changes what it is doing", () => {
    const entries = build({
      events: [started(), read("get_workspace_summary", { tabs: 18 }), read("search_tabs", { matches: 14 }), read("search_tabs", { matches: 6 })],
    });
    expect(titles(entries).slice(1)).toEqual(["Read workspace", "Found 6 relevant tabs"]);
    expect(entries.at(-1)!.description).toBe("2 searches in Research");
  });

  it("folds fifteen file reads into 'Read 15 files'", () => {
    const reads = Array.from({ length: 15 }, (_, index) =>
      event({ kind: "file_read", summary: "Read", file: { relativePath: `src/f${index}.ts`, projectId: "p1" } })
    );
    const entries = build({ events: [started(), ...reads] });
    expect(entries.at(-1)).toMatchObject({ kind: "files_read", title: "Read 15 files", count: 15 });
  });

  it("folds consecutive commands into 'Ran N commands'", () => {
    const command = (id: string) => [
      event({ kind: "command_started", summary: "Bash", tool: { name: "Bash", callId: id } }),
      event({ kind: "tool_finished", summary: "Tool finished", tool: { name: "tool", callId: id, ok: true } }),
    ];
    const entries = build({ events: [started(), ...command("a"), ...command("b"), ...command("c")] });
    expect(entries.at(-1)).toMatchObject({ kind: "command", title: "Ran 3 commands", count: 3 });
  });

  it("never shows the protocol name of a Hubble tool", () => {
    const entries = build({
      session: session({ status: "running" }),
      events: [started(), event({ kind: "tool_started", summary: "x", tool: { name: "mcp__tabdump_abcdefghijklmnop__search_tabs", callId: "c1" } })],
    });
    for (const entry of entries) expect(`${entry.title} ${entry.description ?? ""}`).not.toMatch(/mcp__|tabdump/);
    expect(entries.at(-1)).toMatchObject({ status: "active", title: "Reading workspace…" });
  });
});

describe("deduplication", () => {
  it("drops an event delivered twice", () => {
    const once = event({ kind: "file_created", summary: "x", file: { relativePath: "a.md", projectId: "p1" } });
    const entries = build({ events: [started(), once, { ...once }] });
    expect(byKind(entries, "created")).toHaveLength(1);
  });

  it("drops the same provider record replayed under a new id", () => {
    const first = event({ kind: "message_sent", summary: "Hi", sourceId: "msg-1" });
    const replay = { ...first, id: "different", sequence: first.sequence + 10 };
    const entries = build({ events: [started(), first, replay] });
    expect(byKind(entries, "message_sent")).toHaveLength(1);
  });

  it("says 'Created research-summary.md' once when three layers report the same completion", () => {
    const created = () =>
      event({ kind: "file_created", summary: "research-summary.md", runId: "cr-1", file: { relativePath: "research-summary.md", projectId: "p1" } });
    const entries = build({ events: [started(), created(), created(), created()] });
    expect(titles(entries).filter((title) => title === "Created research-summary.md")).toHaveLength(1);
  });

  it("records one decision per approval, whoever announced it", () => {
    const entries = build({
      events: [
        started(),
        event({ kind: "approval_requested", approvalId: "a1" }),
        event({ kind: "approval_granted", approvalId: "a1", summary: "Approved" }),
        event({ kind: "approval_granted", approvalId: "a1", summary: "Workspace change approved" }),
      ],
    });
    expect(byKind(entries, "action_approved")).toHaveLength(1);
  });

  it("does not repeat an applied change passed twice", () => {
    const change: AppliedWorkspaceChange = { id: "x", sessionId: "s1", provider: "claude-code", workspaceId: WS, at: T0 + 1, ok: true, steps: [] };
    const entries = build({ events: [started()], changes: [change, change] });
    expect(entries.filter((entry) => entry.id === "change:x")).toHaveLength(1);
  });

  it("keeps every id stable as the stream grows", () => {
    const events = [started(), loaded(), read("get_workspace_summary", { tabs: 3 })];
    const before = build({ events }).map((entry) => entry.id);
    const after = build({ events: [...events, event({ kind: "run_completed", summary: "Run completed." })] }).map((entry) => entry.id);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe("isolation", () => {
  it("ignores another session's events", () => {
    const entries = build({
      events: [started(), event({ kind: "file_created", sessionId: "s2", summary: "x", file: { relativePath: "secret.md", projectId: "p2" } })],
    });
    expect(JSON.stringify(entries)).not.toContain("secret.md");
  });

  it("ignores context activity naming a different workspace", () => {
    const foreign = event({ kind: "context_read", summary: "x", context: { workspaceId: "w-private", operation: "search_tabs", ok: true, matches: 99 } });
    const entries = build({ events: [started(), foreign] });
    expect(entries.some((entry) => entry.kind === "searching")).toBe(false);
  });

  it("ignores workspace changes made for another session or in another workspace", () => {
    const base = { provider: "claude-code" as AgentProviderId, at: T0 + 1, ok: true, steps: [{ kind: "created" as const, name: "Leak", tabCount: 1 }] };
    const entries = build({
      events: [started()],
      changes: [
        { ...base, id: "other-session", sessionId: "s2", workspaceId: WS },
        { ...base, id: "other-workspace", sessionId: "s1", workspaceId: "w-private" },
      ],
    });
    expect(JSON.stringify(entries)).not.toContain("Leak");
  });

  it("stamps every entry with its own session and workspace", () => {
    const entries = build({ events: [started(), loaded(), read("search_tabs", { matches: 2 })] });
    for (const entry of entries) expect(entry).toMatchObject({ sessionId: "s1", workspaceId: WS, provider: "claude-code" });
  });
});

describe("lifecycle", () => {
  it("connect → read → action → approval → completion (Claude's real order)", () => {
    // Built in journal order: each helper takes the next sequence.
    const events = [
      event({ kind: "message_sent", summary: "Summarize my research" }),
      started(),
      loaded(18, 3),
      read("get_workspace_summary", { tabs: 18, collections: 3 }),
      read("search_tabs", { matches: 14 }),
      event({ kind: "tool_started", summary: "Write", tool: { name: "Write", callId: "w1" } }),
      event({ kind: "file_modified", summary: "Edited research-summary.md", file: { relativePath: "research-summary.md", projectId: "p1" } }),
      event({ kind: "approval_requested", approvalId: "a1", summary: "Write research-summary.md", tool: { name: "Write", callId: "w1" } }),
    ];

    // While it waits: the request is the one entry asking for attention, and nothing spins.
    const waiting = build({
      session: session({ status: "waiting_for_approval", awaitingApproval: true }),
      events,
      approvals: [approval({ action: "modify_files" })],
    });
    expect(waiting.filter((entry) => entry.status === "waiting")).toHaveLength(1);
    expect(waiting.at(-1)).toMatchObject({ title: "Waiting for approval", description: "Edit research-summary.md" });
    expect(waiting.some((entry) => entry.status === "active")).toBe(false);

    const done = build({
      events: [
        ...events,
        event({ kind: "approval_granted", approvalId: "a1", summary: "Approved" }),
        event({ kind: "tool_finished", summary: "Tool finished", tool: { name: "tool", callId: "w1", ok: true } }),
        event({ kind: "message_received", summary: "Done", messageId: "m1", text: "Done" }),
        event({ kind: "run_completed", summary: "Run completed." }),
      ],
      knownApprovals: new Map([["a1", approval({ action: "modify_files" })]]),
    });
    expect(titles(done)).toEqual([
      "Claude Code connected",
      "You sent a message",
      "Workspace context loaded",
      "Read workspace",
      "Found 14 relevant tabs",
      "Asked for approval",
      "Approved",
      "Edited research-summary.md",
      "Replied",
      "Finished",
    ]);
    expect(done.every((entry) => entry.status !== "active" && entry.status !== "waiting")).toBe(true);
  });

  it("connect → action → failure", () => {
    const entries = build({
      session: session({ provider: "gemini", status: "failed" }),
      agentName: "Gemini",
      events: [
        started(),
        event({ kind: "tool_started", summary: "Edit", tool: { name: "Edit", callId: "e1" } }),
        event({ kind: "file_modified", summary: "Edited a.ts", file: { relativePath: "a.ts", projectId: "p1" } }),
        event({ kind: "tool_finished", summary: "Tool failed", tool: { name: "Edit", callId: "e1", ok: false } }),
        event({ kind: "error", summary: "Agent disconnected unexpectedly." }),
      ],
    });
    expect(titles(entries)).toEqual(["Gemini connected", "Couldn't edit a.ts", "Gemini stopped unexpectedly"]);
    expect(entries.at(-1)!.action).toEqual({ kind: "new_session" });
  });

  it("connect → disconnect", () => {
    const entries = build({ session: session({ status: "disconnected", updatedAt: T0 + 30_000 }), events: [started(), loaded()] });
    expect(entries.at(-1)).toMatchObject({ kind: "disconnected", status: "failed", title: "Claude Code disconnected", action: { kind: "new_session" } });
  });

  it("connecting is active, and a connection that never completed says so", () => {
    expect(build({ session: session({ status: "connecting" }), events: [] })[0]).toMatchObject({ status: "active", title: "Connecting to Claude Code…" });
    const failed = build({ session: session({ status: "failed" }), events: [] });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "connection_failed", status: "failed", title: "Couldn't connect to Claude Code" });
  });

  it("shows what is happening now only while the session is live", () => {
    const events = [started(), event({ kind: "tool_started", summary: "x", tool: { name: "mcp__tabdump_abcdefghijklmnop__get_tabs", callId: "c1" } })];
    expect(build({ session: session({ status: "running" }), events }).at(-1)).toMatchObject({ status: "active", title: "Reading workspace…" });
    // The run ended with the call unanswered: nothing is left spinning.
    for (const status of ["ready", "cancelled", "failed", "disconnected", "completed"] as const) {
      expect(build({ session: session({ status }), events }).some((entry) => entry.status === "active")).toBe(false);
    }
  });

  it("a context read answers the agent's open call, so the reading row resolves", () => {
    const entries = build({
      session: session({ status: "running" }),
      events: [
        started(),
        event({ kind: "tool_started", summary: "x", tool: { name: "mcp__tabdump_abcdefghijklmnop__search_tabs", callId: "c1" } }),
        read("search_tabs", { matches: 4 }),
        event({ kind: "thinking", summary: "Thinking" }),
      ],
    });
    expect(titles(entries).slice(-2)).toEqual(["Found 4 relevant tabs", "Thinking…"]);
  });

  it("an approval that expired unanswered stops waiting and says so", () => {
    const entries = build({
      events: [started(), event({ kind: "approval_requested", approvalId: "a1" })],
      knownApprovals: new Map([["a1", approval({ expiresAt: T0 })]]),
    });
    expect(entries.at(-1)).toMatchObject({ kind: "approval_closed", status: "info", title: "Approval expired" });
  });

  it("a declined edit is not shown as a failed one, whichever arrived first", () => {
    const intent = [
      event({ kind: "tool_started", summary: "Write", tool: { name: "Write", callId: "w1" } }),
      event({ kind: "file_modified", summary: "Edited x.md", file: { relativePath: "x.md", projectId: "p1" } }),
      event({ kind: "approval_requested", approvalId: "a1", tool: { name: "Write", callId: "w1" } }),
    ];
    const failedFirst = build({
      events: [
        started(),
        ...intent,
        event({ kind: "tool_finished", summary: "Tool failed", tool: { name: "tool", callId: "w1", ok: false } }),
        event({ kind: "approval_denied", approvalId: "a1", summary: "Denied" }),
      ],
    });
    expect(failedFirst.some((entry) => entry.status === "failed")).toBe(false);
    expect(failedFirst.at(-1)!.title).toBe("Rejected");
  });

  it("a question waits on the person while the session does", () => {
    const entries = build({ session: session({ status: "waiting_for_input" }), events: [started(), event({ kind: "waiting_for_input", summary: "?" })] });
    expect(entries.at(-1)).toMatchObject({ status: "waiting", title: "Claude Code is waiting for your reply" });
  });

  it("a plan that could not be applied is a failure; one that applied joins its change", () => {
    const outcomes = [
      { planId: "plan-1", approvalId: "a1", status: "applied" as const, operationCount: 2, verifiedCount: 2, contextVersion: 2, at: T0 + 5_000 },
      { planId: "plan-2", status: "stale" as const, operationCount: 1, verifiedCount: 0, contextVersion: 2, at: T0 + 6_000 },
    ];
    const change: AppliedWorkspaceChange = {
      id: "ctxa-1",
      sessionId: "s1",
      provider: "claude-code",
      workspaceId: WS,
      at: T0 + 4_000,
      ok: true,
      planId: "plan-1",
      steps: [
        { kind: "created", name: "A", tabCount: 2 },
        { kind: "added", collectionId: "c1", name: "B", tabCount: 1 },
      ],
    };
    const entries = build({
      session: session({
        context: { workspaceId: WS, workspaceName: "Research", capabilities: [], version: 2, syncedAt: T0, fingerprint: "f", pendingActions: [], planOutcomes: outcomes },
      }),
      events: [started()],
      changes: [change],
    });
    expect(entries.filter((entry) => entry.refs?.planId === "plan-1")).toHaveLength(1);
    expect(entries.find((entry) => entry.id === "change:ctxa-1")).toMatchObject({ title: "Updated Research" });
    expect(entries.find((entry) => entry.id === "plan:plan-2")).toMatchObject({ status: "failed", title: "Approved changes weren't applied" });
  });
});

describe("approval wording", () => {
  it("names a file action by its file and a workspace change by its collection, never by a command", () => {
    expect(describeApproval(approval({ targets: ["docs/a.md", "docs/b.md"] }))).toBe("Create a.md and 1 more");
    expect(
      describeApproval(approval({ action: "change_workspace", change: { kind: "create_collection", subject: "Physics", tabCount: 4, details: [] } }))
    ).toBe("Create collection “Physics” · 4 tabs");
    expect(describeApproval(approval({ action: "run_command", targets: ["rm -rf /"] }))).toBe("Run a command");
  });
});

describe("resilience", () => {
  it("handles an empty session and a long one", () => {
    expect(build({ events: [] })).toHaveLength(1);
    const many = Array.from({ length: 500 }, (_, index) =>
      index % 2 === 0 ? read("search_tabs", { matches: index }) : event({ kind: "message_sent", summary: "m" })
    );
    const entries = build({ events: many });
    expect(entries.length).toBeGreaterThan(400);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  it("does not trust a context event that carries no context", () => {
    const entries = build({ events: [started(), event({ kind: "context_read", summary: "x" })] });
    expect(entries).toHaveLength(1);
  });
});

describe("undo is told as a second fact", () => {
  const created: AppliedWorkspaceChange = {
    id: "ctxa-1",
    sessionId: "s1",
    provider: "claude-code",
    workspaceId: WS,
    at: T0 + 50_000,
    ok: true,
    approvalId: "wa-1",
    steps: [{ kind: "created", collectionId: "c9", name: "Pricing Research", tabCount: 5 }],
  };

  it("keeps the original entry exactly as it was, and adds the undo after it", () => {
    const before = build({ events: [started()], changes: [created] });
    const after = build({ events: [started()], changes: [{ ...created, undone: true, undoneAt: T0 + 55_000 }] });
    const original = before.find((entry) => entry.id === "change:ctxa-1")!;
    const kept = after.find((entry) => entry.id === "change:ctxa-1")!;
    expect(kept).toMatchObject({ title: original.title, status: "completed", kind: "created", description: original.description });
    const undo = after.at(-1)!;
    expect(undo).toMatchObject({ id: "undo:ctxa-1", kind: "undone", status: "completed", title: "Undid creation of “Pricing Research”", at: T0 + 55_000 });
    expect(after.indexOf(undo)).toBe(after.indexOf(kept) + 1);
    // The undo carries the same references, so it opens the same action.
    expect(undo.refs).toEqual(kept.refs);
    // Nothing is left to view once it is undone.
    expect(kept.action).toBeUndefined();
  });

  it("never places the undo before the change it undoes", () => {
    const entries = build({ events: [started()], changes: [{ ...created, undone: true, undoneAt: T0 }] });
    const ids = entries.map((entry) => entry.id);
    expect(ids.indexOf("undo:ctxa-1")).toBeGreaterThan(ids.indexOf("change:ctxa-1"));
  });

  it("names the approval that allowed a change on its entry", () => {
    const entries = build({ events: [started()], changes: [created] });
    expect(entries.find((entry) => entry.id === "change:ctxa-1")!.refs).toEqual({ changeId: "ctxa-1", approvalId: "wa-1" });
  });

  it("keeps the file a file entry is about, for the inspector", () => {
    const entries = build({ events: [started(), event({ kind: "file_created", summary: "x", file: { relativePath: "notes/a.md", projectId: "p1" } })] });
    expect(entries.at(-1)!.refs?.file).toEqual({ relativePath: "notes/a.md", projectId: "p1", operation: "created" });
  });
});

describe("files join the approval their call asked for", () => {
  it("in ACP's order: asked, approved, finished, then the file", () => {
    const entries = build({
      events: [
        started(),
        event({ kind: "tool_started", summary: "Edit", tool: { name: "Edit", callId: "t1" } }),
        event({ kind: "approval_requested", summary: "Edit", approvalId: "a1", tool: { name: "Edit", callId: "t1" } }),
        event({ kind: "approval_granted", summary: "Approved", approvalId: "a1" }),
        event({ kind: "tool_finished", summary: "Edit finished", tool: { name: "Edit", callId: "t1", ok: true } }),
        event({ kind: "file_created", summary: "notes/a.md", file: { relativePath: "notes/a.md", projectId: "p1" } }),
      ],
      knownApprovals: new Map([["a1", approval()]]),
    });
    expect(entries.at(-1)).toMatchObject({ title: "Created a.md", refs: { approvalId: "a1" } });
  });

  it("never lends a finished call's approval to a file reported later, after other work", () => {
    const entries = build({
      events: [
        started(),
        event({ kind: "tool_started", summary: "Edit", tool: { name: "Edit", callId: "t1" } }),
        event({ kind: "approval_requested", summary: "Edit", approvalId: "a1", tool: { name: "Edit", callId: "t1" } }),
        event({ kind: "approval_granted", summary: "Approved", approvalId: "a1" }),
        event({ kind: "tool_finished", summary: "Edit finished", tool: { name: "Edit", callId: "t1", ok: true } }),
        event({ kind: "message_received", summary: "Reply", messageId: "m1", text: "Done" }),
        event({ kind: "file_created", summary: "b.md", file: { relativePath: "b.md", projectId: "p1" } }),
      ],
    });
    expect(entries.at(-1)!.refs?.approvalId).toBeUndefined();
  });
});
