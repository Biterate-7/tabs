import { describe, expect, it } from "vitest";
import { emptyContextWorld } from "@/lib/agents/context/world";
import { contextPackAttachedContext } from "./attach";
import { contextPackId } from "./pack";
import { contextDeliveryLine } from "./present";
import { contextDeliveryOf, contextProvenanceOf } from "./provenance";
import { contextDeliveryState, handoffThatStarted, latestInstruction, sessionContextPack } from "./session";
import type { AgentContextWorld } from "@/lib/agents/context/world";
import type { AgentControlEvent } from "@/lib/agents/control/events";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { ContextPack } from "./pack";

const T0 = 1_700_000_000_000;

function world(brief = true): AgentContextWorld {
  return {
    ...emptyContextWorld(null),
    workspaces: [
      {
        id: "w1",
        name: "Research",
        tabs: [
          { id: "t1", url: "https://a.example/1", normalizedUrl: "https://a.example/1", domain: "a.example", title: "One" },
          { id: "t2", url: "https://a.example/2", normalizedUrl: "https://a.example/2", domain: "a.example", title: "Two" },
        ],
        ...(brief ? { brief: { description: "Climate policy sources.", updatedAt: T0 } } : {}),
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    collections: [{ id: "c1", workspaceId: "w1", name: "Pricing Research", tabIds: ["t1"], createdAt: T0, updatedAt: T0 }],
  };
}

const HANDOFF: SessionHandoff = {
  handoffId: "ho-1",
  workspaceId: "w1",
  sourceSessionId: "s-gemini",
  sourceProvider: "gemini",
  targetProvider: "grok",
  targetSessionId: "s-grok",
  status: "ready",
  context: {
    workspace: { tabs: 2, collections: 1, focus: { tabs: 0, collections: 1, collectionIds: ["c1"] } },
    previousResult: { outcome: "finished", lines: [{ title: "Created api.ts" }], more: 0, files: [{ path: "src/api.ts", change: "created" }] },
  },
  instruction: "Continue by fixing the remaining tests.",
  createdAt: T0,
  updatedAt: T0,
};

function packFor(over: Parameters<typeof sessionContextPack>[0] = { world: world(), workspaceId: "w1" }): ContextPack {
  const result = sessionContextPack(over);
  if (!result.ok) throw new Error(result.reason);
  return result.pack;
}

describe("a session's pack", () => {
  it("is the session's own selection — the whole workspace when it has none", () => {
    expect(packFor().scope).toBe("workspace");
    expect(packFor({ world: world(), workspaceId: "w1", selection: { workspaceId: "w1", tabIds: [], collectionIds: ["c1"] } }).scope).toBe("collection");
    // A selection for another workspace is not this session's.
    expect(packFor({ world: world(), workspaceId: "w1", selection: { workspaceId: "w2", tabIds: ["x"], collectionIds: [] } }).scope).toBe("workspace");
  });

  it("carries the previous result of the handoff that started it, with its files", () => {
    const pack = packFor({ world: world(), workspaceId: "w1", sessionId: "s-grok", handoffFrom: handoffThatStarted("s-grok", [HANDOFF]) });
    expect(pack.previousResult?.lines).toEqual([{ title: "Created api.ts" }]);
    expect(pack.files).toEqual([{ path: "src/api.ts", change: "created" }]);
    expect(handoffThatStarted("s-gemini", [HANDOFF])).toBeUndefined();
    expect(handoffThatStarted("s-grok", [{ ...HANDOFF, status: "failed", failure: "context_not_delivered" }])).toBeUndefined();
  });

  it("shows the person's latest words, never the handoff envelope or the agent's", () => {
    const events: Pick<AgentControlEvent, "kind" | "sessionId" | "summary" | "text" | "handoff">[] = [
      { kind: "message_sent", sessionId: "s-grok", summary: "Handoff", text: "HUBBLE HANDOFF …", handoff: { handoffId: "ho-1", workspaceId: "w1", peerProvider: "gemini" } },
      { kind: "message_received", sessionId: "s-grok", summary: "Reply", text: "I will do it." },
    ];
    expect(latestInstruction(events, "s-grok", HANDOFF)).toBe("Continue by fixing the remaining tests.");
    expect(latestInstruction([...events, { kind: "message_sent", sessionId: "s-grok", summary: "Message sent.", text: "Now the docs." }], "s-grok", HANDOFF)).toBe("Now the docs.");
    expect(latestInstruction([], "s-x")).toBeUndefined();
  });
});

describe("where a session's context stands", () => {
  const pack = packFor();
  const id = contextPackId(pack);

  it("pending, delivered, changed — against the pack it would be sent now", () => {
    expect(contextDeliveryState({ contextSnapshotId: id, contextDelivered: false }, pack)).toBe("pending");
    expect(contextDeliveryState({ contextSnapshotId: id, contextDelivered: true }, pack)).toBe("delivered");
    expect(contextDeliveryState({ contextSnapshotId: "pack-0000000000000000", contextDelivered: true }, pack)).toBe("changed");
    // A brief written after the session started is context it has not been sent.
    expect(contextDeliveryState({}, pack)).toBe("changed");
  });

  it("reads, for a whole workspace with nothing to attach", () => {
    const plain = packFor({ world: world(false), workspaceId: "w1" });
    expect(contextPackAttachedContext(plain, T0)).toBeNull();
    expect(contextDeliveryState({}, plain)).toBe("reads");
    expect(contextDeliveryLine("reads", "Claude Code")).toBe("Claude Code reads this workspace when it needs to");
  });

  it("trusts context attached before packs existed", () => {
    expect(contextDeliveryState({ contextSnapshotId: "snapshot-legacy", contextDelivered: true }, pack)).toBe("delivered");
    expect(contextDeliveryState({ focus: { tabIds: ["t1"], collectionIds: [], delivered: false } }, pack)).toBe("pending");
  });

  it("notices the workspace changing under a running session: a rename changes the pack", () => {
    const renamed = { ...world(), workspaces: world().workspaces.map((workspace) => ({ ...workspace, name: "Policy" })) };
    expect(contextDeliveryState({ contextSnapshotId: id, contextDelivered: true }, packFor({ world: renamed, workspaceId: "w1" }))).toBe("changed");
  });
});

describe("context provenance", () => {
  const selected = packFor({ world: world(), workspaceId: "w1", selection: { workspaceId: "w1", tabIds: ["t2"], collectionIds: ["c1"] } });
  const delivery = contextDeliveryOf(contextPackAttachedContext(selected, T0)!, "w1")!;
  const base = {
    session: { sessionId: "s1", workspaceId: "w1" },
    workspaceName: "Research",
    agentName: (provider: string) => (provider === "gemini" ? "Gemini CLI" : "Agent"),
  };

  it("names what had been delivered by the time of the action", () => {
    const events = [
      { kind: "message_sent" as const, sessionId: "s1", timestamp: T0, delivery },
      { kind: "context_read" as const, sessionId: "s1", timestamp: T0 + 1, context: { workspaceId: "w1", ok: true } },
      { kind: "context_read" as const, sessionId: "s1", timestamp: T0 + 2, context: { workspaceId: "w1", ok: false } },
    ];
    const lines = contextProvenanceOf({ ...base, events, at: T0 + 5, collectionName: (id) => (id === "c1" ? "Pricing Research" : undefined) })!.lines;
    expect(lines).toEqual(["Research workspace · Workspace brief", "Pricing Research collection · 1 tab", "Read the workspace once"]);
  });

  it("is the whole workspace before anything was delivered, and counts a collection deleted since", () => {
    const events = [{ kind: "message_sent" as const, sessionId: "s1", timestamp: T0 + 10, delivery }];
    expect(contextProvenanceOf({ ...base, events, at: T0 })!.lines).toEqual(["Research workspace · Whole project"]);
    expect(contextProvenanceOf({ ...base, events, at: T0 + 20, collectionName: () => undefined })!.lines).toEqual([
      "Research workspace · Workspace brief",
      "1 collection · 1 tab",
    ]);
  });

  it("says what a handoff passed: the previous result and its files, the instruction — never what was said", () => {
    const lines = contextProvenanceOf({
      ...base,
      session: { sessionId: "s-grok", workspaceId: "w1" },
      events: [],
      handoffs: [HANDOFF],
      at: T0 + 1,
    })!.lines;
    expect(lines).toEqual([
      "Research workspace · Whole project",
      "Previous result from Gemini CLI · 1 file",
      "Handed over · 1 collection",
      "Your handoff instruction",
    ]);
  });

  it("has nothing to say for a session with no workspace", () => {
    expect(contextProvenanceOf({ ...base, session: { sessionId: "s1" }, events: [], at: T0 })).toBeUndefined();
  });
});
