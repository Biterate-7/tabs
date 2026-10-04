import { describe, expect, it } from "vitest";
import { isWellFormedControlEvent } from "@/lib/agents/control/events";
import { createMemoryAgentHistoryStore, isKeepableHandoff } from "@/lib/agents/activity/history-store";
import {
  REDACTED,
  buildHandoffEnvelope,
  canHandOffFrom,
  containsSecretShape,
  handoffFingerprint,
  handoffLinksOf,
  handoffPassedLine,
  readHandoffInstruction,
  readSessionHandoff,
  selectHandoffContext,
  summarizePreviousResult,
  workspaceContextOf,
} from "./handoff";
import type { AgentActivityEntry } from "@/lib/agents/activity/timeline";
import type { AgentHistorySession } from "@/lib/agents/activity/history";
import type { AgentControlEvent } from "@/lib/agents/control/events";
import type { SessionHandoff } from "./handoff";
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot";

const T0 = 1_700_000_000_000;

const entry = (over: Partial<AgentActivityEntry> & Pick<AgentActivityEntry, "id" | "kind" | "title">): AgentActivityEntry => ({
  sessionId: "s1",
  provider: "claude-code",
  status: "completed",
  at: T0,
  count: 1,
  ...over,
});

const SNAPSHOT: SessionContextSnapshot = {
  workspace: {
    id: "w-dev",
    name: "Development",
    createdAt: 1,
    updatedAt: 2,
    tabs: [
      { id: "t1", url: "https://a.example/1", normalizedUrl: "https://a.example/1", domain: "a.example", title: "One" },
      { id: "t2", url: "https://a.example/2", normalizedUrl: "https://a.example/2", domain: "a.example", title: "Two" },
    ],
  },
  collections: [{ id: "c1", workspaceId: "w-dev", name: "Plan", tabIds: ["t1"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
  truncated: false,
};

function handoff(over: Partial<SessionHandoff> = {}): SessionHandoff {
  return {
    handoffId: "ho-1",
    workspaceId: "w-dev",
    sourceSessionId: "s-claude",
    sourceProvider: "claude-code",
    targetProvider: "openai-codex",
    targetSessionId: "s-codex",
    status: "ready",
    context: {
      workspace: { tabs: 8, collections: 2 },
      previousResult: { outcome: "finished", lines: [{ title: "Created collection “Implementation Plan”", description: "4 tabs" }], more: 0 },
    },
    instruction: "Implement the plan from the previous agent.",
    createdAt: T0,
    updatedAt: T0 + 1_000,
    ...over,
  };
}

describe("which sessions can hand work on", () => {
  it("a session the person can review: a finished turn, a question, or an ending", () => {
    for (const status of ["ready", "waiting_for_input", "completed", "cancelled", "failed", "disconnected"] as const) {
      expect(canHandOffFrom(status), status).toBe(true);
    }
  });

  it("never mid-turn, mid-connect or with a decision still owed", () => {
    for (const status of ["created", "connecting", "running", "waiting_for_approval"] as const) {
      expect(canHandOffFrom(status), status).toBe(false);
    }
  });
});

describe("the previous result", () => {
  it("is the session's results in the timeline's own words — never its reads, replies or lifecycle", () => {
    const result = summarizePreviousResult(
      [
        entry({ id: "connect", kind: "connected", title: "Claude Code connected", status: "info" }),
        entry({ id: "read", kind: "reading", title: "Read workspace" }),
        entry({ id: "replied", kind: "replied", title: "Replied" }),
        entry({ id: "change:a", kind: "created", title: "Created collection “Implementation Plan”", description: "4 tabs", refs: { changeId: "a" } }),
        entry({ id: "file", kind: "updated", title: "Edited plan.md", description: "docs/plan.md" }),
        entry({ id: "failed-file", kind: "action_failed", title: "Couldn't edit secret.md", status: "failed" }),
        entry({ id: "done", kind: "completed", title: "Finished" }),
      ],
      "ready"
    );
    expect(result).toEqual({
      outcome: "finished",
      lines: [
        { title: "Created collection “Implementation Plan”", description: "4 tabs" },
        { title: "Edited plan.md", description: "docs/plan.md" },
      ],
      more: 0,
    });
  });

  it("leaves out a change the person undid", () => {
    const result = summarizePreviousResult(
      [
        entry({ id: "change:a", kind: "created", title: "Created collection “Pricing”", refs: { changeId: "a" } }),
        entry({ id: "undo:a", kind: "undone", title: "Removed collection “Pricing”", refs: { changeId: "a" } }),
      ],
      "completed"
    );
    expect(result.lines).toEqual([]);
  });

  it("is bounded, and says how many more there were", () => {
    const many = Array.from({ length: 20 }, (_, index) => entry({ id: `f${index}`, kind: "created", title: `Created f${index}.ts` }));
    const result = summarizePreviousResult(many, "failed");
    expect(result.lines).toHaveLength(12);
    expect(result.more).toBe(8);
    expect(result.outcome).toBe("failed");
  });
});

describe("workspace context", () => {
  it("is counts of the snapshot, and of the focus only when it fits the snapshot", () => {
    expect(workspaceContextOf(SNAPSHOT, { tabIds: ["t1"], collectionIds: ["c1"] })).toEqual({ tabs: 2, collections: 1, focus: { tabs: 1, collections: 1 } });
    // A focus naming anything outside the workspace is not carried at all.
    expect(workspaceContextOf(SNAPSHOT, { tabIds: ["t1", "elsewhere"], collectionIds: [] })).toEqual({ tabs: 2, collections: 1 });
    expect(workspaceContextOf(SNAPSHOT, undefined)).toEqual({ tabs: 2, collections: 1 });
  });

  it("only the modes the person kept are passed", () => {
    const context = handoff().context;
    expect(selectHandoffContext(context, { workspace: true, previousResult: false })).toEqual({ workspace: context.workspace });
    expect(selectHandoffContext(context, { workspace: false, previousResult: true })).toEqual({ previousResult: context.previousResult });
    expect(selectHandoffContext(context, { workspace: false, previousResult: false })).toEqual({});
    expect(handoffPassedLine({ context: {}, instruction: undefined })).toBe("No context passed");
    expect(handoffPassedLine(handoff())).toBe("Workspace context · Previous result · Your instruction");
  });
});

describe("the person's instruction", () => {
  it("keeps prose, line breaks included, and drops control characters", () => {
    expect(readHandoffInstruction("  Implement the plan.\r\n\r\n\r\n\r\nThen review.\u0007  ")).toBe("Implement the plan.\n\nThen review.");
    expect(readHandoffInstruction("   ")).toBeUndefined();
    expect(readHandoffInstruction(42)).toBeUndefined();
  });

  it("never carries anything shaped like a credential", () => {
    const raw = [
      "Use sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX to call it",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123",
      "password=hunter2hunter2",
      "AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    expect(containsSecretShape(raw)).toBe(true);
    const kept = readHandoffInstruction(raw)!;
    expect(containsSecretShape(kept)).toBe(false);
    expect(kept).toContain(REDACTED);
    for (const secret of ["sk-ant-api03", "ghp_abc", "abcdefghijklmnopqrstuvwxyz.0123", "hunter2", "AKIAABCD"]) {
      expect(kept).not.toContain(secret);
    }
  });

  it("is bounded", () => {
    expect(readHandoffInstruction("x".repeat(5_000))!.length).toBe(2_000);
  });
});

describe("the envelope the target agent receives", () => {
  const record = handoff();

  it("is a short structured note: workspace, previous agent, result, context, instruction", () => {
    const text = buildHandoffEnvelope({
      workspaceName: "Development",
      sourceProvider: "claude-code",
      sourceTitle: "Research the topic",
      context: record.context,
      contextTools: true,
      instruction: record.instruction!,
    });
    expect(text.split("\n")[0]).toBe("HUBBLE HANDOFF");
    expect(text).toContain("Workspace: Development");
    expect(text).toContain("Previous agent: Claude Code");
    expect(text).toContain("Previous session: Research the topic");
    expect(text).toContain("Previous result: Finished");
    expect(text).toContain("- Created collection “Implementation Plan” (4 tabs)");
    expect(text).toContain("Workspace context: 8 tabs · 2 collections");
    expect(text).toContain("Instruction from the person:\nImplement the plan from the previous agent.");
  });

  it("never claims context the agent was not given", () => {
    const withoutTools = buildHandoffEnvelope({ workspaceName: "Development", sourceProvider: "claude-code", context: record.context, contextTools: false });
    expect(withoutTools).toContain("Workspace context: not available to you in this session.");
    expect(withoutTools).not.toContain("8 tabs");
    const notShared = buildHandoffEnvelope({ workspaceName: "Development", sourceProvider: "claude-code", context: {}, contextTools: true });
    expect(notShared).toContain("Workspace context: not shared for this handoff.");
    expect(notShared).not.toContain("Previous result");
  });

  it("is built only from the record's fields — no field could carry a transcript or a credential", () => {
    const text = buildHandoffEnvelope({ workspaceName: "Development", sourceProvider: "claude-code", context: record.context, contextTools: true });
    expect(text).not.toMatch(/token|authorization|bearer|https?:\/\//i);
  });
});

describe("reading a handoff back", () => {
  it("reads one it wrote", () => {
    expect(readSessionHandoff(JSON.parse(JSON.stringify(handoff())))).toEqual(handoff());
  });

  it("refuses one that does not read, rather than repairing it", () => {
    expect(readSessionHandoff({ ...handoff(), sourceProvider: "unknown-agent" })).toBeNull();
    expect(readSessionHandoff({ ...handoff(), status: "failed" })).toBeNull(); // a failure says where
    expect(readSessionHandoff({ ...handoff(), instruction: "key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX" })).toBeNull();
    expect(readSessionHandoff({ ...handoff(), context: { previousResult: { outcome: "finished", lines: "x", more: 0 } } })).toBeNull();
    expect(readSessionHandoff({ ...handoff(), transcript: "everything" })).toEqual(handoff()); // unknown fields dropped
  });
});

describe("the relationship", () => {
  it("is read from explicit records — both ways — and never from a handoff still being prepared or backed out of", () => {
    const records = [
      handoff(),
      handoff({ handoffId: "ho-2", sourceSessionId: "s-codex", sourceProvider: "openai-codex", targetProvider: "gemini", targetSessionId: "s-gemini" }),
      handoff({ handoffId: "ho-3", status: "cancelled", targetSessionId: undefined }),
      handoff({ handoffId: "ho-4", status: "preparing", targetSessionId: undefined }),
    ];
    expect(handoffLinksOf("s-claude", records)).toEqual({ to: [{ handoffId: "ho-1", sessionId: "s-codex", provider: "openai-codex", status: "ready" }] });
    expect(handoffLinksOf("s-codex", records)).toEqual({
      from: { handoffId: "ho-1", sessionId: "s-claude", provider: "claude-code", status: "ready" },
      to: [{ handoffId: "ho-2", sessionId: "s-gemini", provider: "gemini", status: "ready" }],
    });
    // Same workspace, same agent, same minute — no record, no relationship.
    expect(handoffLinksOf("s-unrelated", records)).toBeUndefined();
  });

  it("a failed handoff shows on its source; its target was never handed anything", () => {
    const failed = handoff({ status: "failed", failure: "context_not_delivered" });
    expect(handoffLinksOf("s-claude", [failed])?.to?.[0]?.status).toBe("failed");
    expect(handoffLinksOf("s-codex", [failed])).toBeUndefined();
  });
});

describe("binding a confirmation to its preview", () => {
  const input = { sourceSessionId: "s1", targetProvider: "openai-codex" as const, workspaceId: "w-dev", context: handoff().context, contextTools: true };

  it("is stable for the same preview, whatever the key order", () => {
    const reordered = { ...input, context: { previousResult: input.context.previousResult, workspace: input.context.workspace } };
    expect(handoffFingerprint(input)).toMatch(/^[0-9a-f]{16}$/);
    expect(handoffFingerprint(reordered)).toBe(handoffFingerprint(input));
  });

  it("changes when anything that would be passed changes", () => {
    const base = handoffFingerprint(input);
    expect(handoffFingerprint({ ...input, targetProvider: "gemini" })).not.toBe(base);
    expect(handoffFingerprint({ ...input, contextTools: false })).not.toBe(base);
    expect(handoffFingerprint({ ...input, context: { ...input.context, workspace: { tabs: 9, collections: 2 } } })).not.toBe(base);
  });
});

describe("history keeps a handoff", () => {
  const session = (sessionId: string, workspaceId = "w-dev"): AgentHistorySession => ({
    sessionId,
    workspaceId,
    provider: "claude-code",
    status: "completed",
    startedAt: T0,
    lastActivityAt: T0,
  });

  it("only once it ended, and never one backed out of", () => {
    expect(isKeepableHandoff(handoff(), session("s-claude"))).toBe(true);
    expect(isKeepableHandoff(handoff({ status: "failed", failure: "session_not_created", targetSessionId: undefined }), session("s-claude"))).toBe(true);
    expect(isKeepableHandoff(handoff({ status: "cancelled" }), session("s-claude"))).toBe(false);
    expect(isKeepableHandoff(handoff({ status: "preparing" }), session("s-claude"))).toBe(false);
  });

  it("only for its own source, in the handoff's own workspace", async () => {
    expect(isKeepableHandoff(handoff(), session("s-claude", "w-other"))).toBe(false);
    expect(isKeepableHandoff(handoff(), undefined)).toBe(false);

    const store = createMemoryAgentHistoryStore();
    await store.write("alice", { sessions: [session("s-claude"), session("s-codex")], records: [], handoffs: [handoff()] });
    // Bob names Alice's session: nothing is kept for him, and Alice's stays hers.
    await store.write("bob", { sessions: [], records: [], handoffs: [handoff({ handoffId: "ho-bob" })] });
    const page = await store.listSessions("alice", "w-dev");
    expect(page.sessions.find((entry) => entry.sessionId === "s-claude")?.handoff?.to?.[0]?.provider).toBe("openai-codex");
    expect(page.sessions.find((entry) => entry.sessionId === "s-codex")?.handoff?.from?.provider).toBe("claude-code");
    expect((await store.readSession("alice", "w-dev", "s-codex"))?.records.handoffs).toEqual([handoff()]);
    expect((await store.listSessions("bob", "w-dev")).sessions).toEqual([]);
    expect(await store.readSession("alice", "w-other", "s-claude")).toBeUndefined();
  });
});

describe("the events that say it happened", () => {
  const base: AgentControlEvent = {
    id: "e1",
    sessionId: "s-claude",
    provider: "claude-code",
    kind: "handoff_sent",
    timestamp: T0,
    summary: "Handed off to Codex",
    handoff: { handoffId: "ho-1", workspaceId: "w-dev", peerProvider: "openai-codex", peerSessionId: "s-codex", outcome: "ready" },
  };

  it("always carry the handoff, and say whether it arrived", () => {
    expect(isWellFormedControlEvent(base)).toBe(true);
    expect(isWellFormedControlEvent({ ...base, handoff: undefined })).toBe(false);
    expect(isWellFormedControlEvent({ ...base, handoff: { ...base.handoff!, outcome: undefined } })).toBe(false);
    expect(isWellFormedControlEvent({ ...base, handoff: { ...base.handoff!, outcome: "failed" } })).toBe(false); // a failure says where
    expect(isWellFormedControlEvent({ ...base, kind: "handoff_received", handoff: { handoffId: "ho-1", workspaceId: "w-dev", peerProvider: "claude-code" } })).toBe(true);
  });

  it("only the handoff kinds and the message that delivered one may carry a handoff", () => {
    expect(isWellFormedControlEvent({ ...base, kind: "message_sent", text: "HUBBLE HANDOFF" })).toBe(true);
    expect(isWellFormedControlEvent({ ...base, kind: "message_received", text: "hi" })).toBe(false);
    expect(isWellFormedControlEvent({ ...base, kind: "tool_started", tool: { name: "x" } })).toBe(false);
    // And text never rides on a handoff event.
    expect(isWellFormedControlEvent({ ...base, text: "transcript" })).toBe(false);
  });
});
