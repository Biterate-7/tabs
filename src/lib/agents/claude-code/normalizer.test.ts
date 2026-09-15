import { describe, expect, it } from "vitest";
import { OBSERVATION_ALLOWLIST, normalizeSession, summarizeTool } from "./normalizer";
import { CLAUDE_CODE_PROVIDER, CLAUDE_LIMITS } from "./types";
import type { ClaudeDiscoveredSession, ClaudeParsedRecord } from "./types";

const T0 = Date.parse("2026-09-15T08:00:00.000Z");
const SESSION_ID = "b70abc10-f01a-48de-8d41-8ac936e8eff8";

function session(over: Partial<ClaudeDiscoveredSession> = {}): ClaudeDiscoveredSession {
  return {
    externalId: SESSION_ID,
    projectPath: "C:\\Users\\someone\\project",
    lastObservedAt: T0,
    ...over,
  };
}

function record(tools: ClaudeParsedRecord["tools"], over: Partial<ClaudeParsedRecord> = {}): ClaudeParsedRecord {
  return { type: "assistant", tools, tasks: [], timestamp: T0, ...over };
}

describe("activity summaries", () => {
  it("describes writes as edits, by basename", () => {
    expect(summarizeTool({ id: "t", name: "Edit", fileName: "graph-canvas.tsx" })).toBe(
      "Edited graph-canvas.tsx"
    );
    expect(summarizeTool({ id: "t", name: "Write", fileName: "notes.md" })).toBe("Edited notes.md");
    expect(summarizeTool({ id: "t", name: "Edit" })).toBe("Edited a file");
  });

  it("describes reads as inspections", () => {
    expect(summarizeTool({ id: "t", name: "Read", fileName: "auth.ts" })).toBe("Inspected auth.ts");
    expect(summarizeTool({ id: "t", name: "Grep", fileName: "src" })).toBe("Inspected src");
    expect(summarizeTool({ id: "t", name: "Grep" })).toBe("Inspected files");
  });

  it("uses a shell tool's human-written description", () => {
    expect(
      summarizeTool({ id: "t", name: "Bash", description: "Run the test suite" })
    ).toBe("Run the test suite");
  });

  it("says only that something ran when a shell tool has no description", () => {
    expect(summarizeTool({ id: "t", name: "Bash" })).toBe("Ran a command");
    expect(summarizeTool({ id: "t", name: "PowerShell" })).toBe("Ran a command");
  });

  it("degrades an unknown tool to a bounded phrase", () => {
    expect(summarizeTool({ id: "t", name: "mcp__something__brand_new" })).toBe("Used tool");
    expect(summarizeTool({ id: "t", name: "SomeFutureTool" })).toBe("Used tool");
  });

  it("describes a navigation without naming the destination", () => {
    const summary = summarizeTool({ id: "t", name: "mcp__x__navigate", url: "https://example.com/secret-path" });

    expect(summary).toBe("Opened a page");
    expect(summary).not.toContain("example.com");
  });
});

describe("session observations", () => {
  it("always emits a base observation carrying identity and status", () => {
    const [base] = normalizeSession({
      session: session({ status: "working", title: "my-branch-c4", gitBranch: "main" }),
      records: [],
      now: T0,
    });

    expect(base.provider).toBe(CLAUDE_CODE_PROVIDER);
    expect(base.externalId).toBe(SESSION_ID);
    expect(base.status).toBe("working");
    expect(base.title).toBe("my-branch-c4");
    expect(base.gitBranch).toBe("main");
    expect(base.projectKey).toBe("C:\\Users\\someone\\project");
  });

  it("emits no workspaceId — attaching one is the client's job", () => {
    const observations = normalizeSession({
      session: session({ status: "working" }),
      records: [record([{ id: "t1", name: "Edit", fileName: "a.ts" }])],
      now: T0,
    });

    for (const observation of observations) {
      expect(observation.workspaceId).toBeUndefined();
    }
  });

  it("omits status entirely when the provider status was unrecognised", () => {
    const [base] = normalizeSession({ session: session(), records: [], now: T0 });

    expect(base).not.toHaveProperty("status");
  });

  it("omits absent metadata rather than blanking it, so the domain keeps what it knows", () => {
    const [base] = normalizeSession({ session: session({ status: "waiting" }), records: [], now: T0 });

    expect(base).not.toHaveProperty("title");
    expect(base).not.toHaveProperty("gitBranch");
  });

  it("carries each tool's own id as the event source id", () => {
    const observations = normalizeSession({
      session: session(),
      records: [
        record([
          { id: "toolu_a", name: "Edit", fileName: "a.ts" },
          { id: "toolu_b", name: "Read", fileName: "b.ts" },
        ]),
      ],
      now: T0,
    });

    expect(observations.slice(1).map((o) => o.sourceId)).toEqual(["toolu_a", "toolu_b"]);
    expect(observations.slice(1).map((o) => o.activity)).toEqual([
      "Edited a.ts",
      "Inspected b.ts",
    ]);
  });

  it("uses each record's own timestamp rather than the poll clock", () => {
    const observations = normalizeSession({
      session: session(),
      records: [record([{ id: "t1", name: "Edit", fileName: "a.ts" }], { timestamp: T0 - 60_000 })],
      now: T0,
    });

    expect(observations[1].observedAt).toBe(T0 - 60_000);
  });

  it("falls back to the poll clock for a record with no timestamp", () => {
    const observations = normalizeSession({
      session: session(),
      records: [record([{ id: "t1", name: "Edit", fileName: "a.ts" }], { timestamp: undefined })],
      now: T0 + 5,
    });

    expect(observations[1].observedAt).toBe(T0 + 5);
  });

  it("refines the git branch from later records", () => {
    const observations = normalizeSession({
      session: session({ gitBranch: "main" }),
      records: [
        record([{ id: "t1", name: "Edit", fileName: "a.ts" }], { gitBranch: "feature/x" }),
      ],
      now: T0,
    });

    expect(observations[1].gitBranch).toBe("feature/x");
  });

  it("passes a url through for exact-match linking", () => {
    const observations = normalizeSession({
      session: session(),
      records: [record([{ id: "t1", name: "nav", url: "https://example.com/a" }])],
      now: T0,
    });

    expect(observations[1].url).toBe("https://example.com/a");
  });

  it("bounds how many observations one session can produce in a poll", () => {
    const tools = Array.from({ length: CLAUDE_LIMITS.maxObservationsPerSession + 30 }, (_, i) => ({
      id: `toolu_${i}`,
      name: "Edit",
      fileName: `f${i}.ts`,
    }));

    const observations = normalizeSession({ session: session(), records: [record(tools)], now: T0 });

    // One base observation plus the capped activity stream.
    expect(observations).toHaveLength(CLAUDE_LIMITS.maxObservationsPerSession + 1);
  });
});

describe("lifecycle", () => {
  it("treats an explicit release artifact as cancellation, outranking the live status", () => {
    const [base] = normalizeSession({
      session: session({ status: "working", terminal: "deleted" }),
      records: [],
      now: T0,
    });

    expect(base.status).toBe("cancelled");
  });

  it("never manufactures a failure from an unknown status", () => {
    const [base] = normalizeSession({ session: session({ status: undefined }), records: [], now: T0 });

    expect(base.status).toBeUndefined();
  });
});

describe("observation safety", () => {
  it("emits only allowlisted fields", () => {
    const observations = normalizeSession({
      session: session({ status: "working", title: "t", gitBranch: "main" }),
      records: [
        record([
          { id: "t1", name: "Bash", description: "Run tests" },
          { id: "t2", name: "Edit", fileName: "a.ts" },
        ]),
      ],
      now: T0,
    });

    for (const observation of observations) {
      for (const key of Object.keys(observation)) {
        expect(OBSERVATION_ALLOWLIST).toContain(key);
      }
    }
  });

  it("produces no absolute path in any activity summary", () => {
    const observations = normalizeSession({
      session: session(),
      records: [
        record([
          { id: "t1", name: "Edit", fileName: "app-sidebar.tsx" },
          { id: "t2", name: "Read", fileName: "auth.ts" },
        ]),
      ],
      now: T0,
    });

    for (const observation of observations) {
      if (!observation.activity) continue;
      expect(observation.activity).not.toMatch(/[A-Za-z]:\\/);
      expect(observation.activity).not.toContain("/Users/");
    }
  });
});
