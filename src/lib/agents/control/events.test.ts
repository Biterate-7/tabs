import { describe, expect, it } from "vitest";
import {
  AGENT_CONTROL_EVENT_KINDS,
  APPROVAL_EVENT_KINDS,
  domainEventKindFor,
  FILE_EVENT_KINDS,
  isWellFormedControlEvent,
  MAX_CONTROL_SUMMARY_LENGTH,
  normalizeControlSummary,
  TOOL_EVENT_KINDS,
  toDomainEventInput,
} from "./events";
import { AGENT_EVENT_KINDS, MAX_SUMMARY_LENGTH } from "@/lib/agents/types";
import type { AgentControlEvent, AgentControlEventKind } from "./events";

const T0 = 1_700_000_000_000;

function event(over: Partial<AgentControlEvent> = {}): AgentControlEvent {
  return {
    id: "e1",
    sessionId: "s1",
    provider: "claude-code",
    kind: "message_received",
    timestamp: T0,
    summary: "Said something",
    ...over,
  };
}

describe("the event vocabulary", () => {
  it("classifies every kind for the durable log", () => {
    // An unclassified kind would throw or fall through silently; both are
    // worse than a deliberate `null`.
    for (const kind of AGENT_CONTROL_EVENT_KINDS) {
      const mapped = domainEventKindFor(kind);
      if (mapped !== null) expect(AGENT_EVENT_KINDS).toContain(mapped);
    }
  });

  it("keeps the two summary caps in agreement", () => {
    // A control summary longer than the domain's would be truncated twice,
    // once here and once on ingest, producing a different string each time.
    expect(MAX_CONTROL_SUMMARY_LENGTH).toBe(MAX_SUMMARY_LENGTH);
  });

  it("declares its slice groups from real kinds", () => {
    for (const group of [FILE_EVENT_KINDS, TOOL_EVENT_KINDS, APPROVAL_EVENT_KINDS]) {
      for (const kind of group) expect(AGENT_CONTROL_EVENT_KINDS).toContain(kind);
    }
  });

  it("drops the two kinds that say nothing a week later", () => {
    expect(domainEventKindFor("thinking")).toBeNull();
    expect(domainEventKindFor("message_sent")).toBeNull();
  });
});

describe("summary normalization", () => {
  it("collapses whitespace so a multi-line blob cannot pass the length check", () => {
    expect(normalizeControlSummary("a\n\n  b\tc  ")).toBe("a b c");
  });

  it("bounds an over-long summary", () => {
    const long = "x".repeat(MAX_CONTROL_SUMMARY_LENGTH + 500);
    expect(normalizeControlSummary(long)).toHaveLength(MAX_CONTROL_SUMMARY_LENGTH);
  });
});

describe("well-formedness", () => {
  it("accepts a plain event", () => {
    expect(isWellFormedControlEvent(event())).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(isWellFormedControlEvent(event({ kind: "exploded" as AgentControlEventKind }))).toBe(
      false
    );
  });

  it("rejects a missing identity or timestamp", () => {
    expect(isWellFormedControlEvent(event({ id: "" }))).toBe(false);
    expect(isWellFormedControlEvent(event({ sessionId: "" }))).toBe(false);
    expect(isWellFormedControlEvent(event({ timestamp: Number.NaN }))).toBe(false);
  });

  it("rejects an over-long summary rather than silently truncating it", () => {
    expect(
      isWellFormedControlEvent(event({ summary: "x".repeat(MAX_CONTROL_SUMMARY_LENGTH + 1) }))
    ).toBe(false);
  });

  it("requires the slice its kind implies", () => {
    // A `file_modified` with no file renders as a blank row rather than
    // failing, which is exactly the bug worth catching at the boundary.
    expect(isWellFormedControlEvent(event({ kind: "file_modified" }))).toBe(false);
    expect(isWellFormedControlEvent(event({ kind: "tool_started" }))).toBe(false);
    expect(isWellFormedControlEvent(event({ kind: "approval_requested" }))).toBe(false);

    expect(
      isWellFormedControlEvent(
        event({ kind: "file_modified", file: { relativePath: "a.ts", projectId: "p1" } })
      )
    ).toBe(true);
    expect(
      isWellFormedControlEvent(event({ kind: "tool_started", tool: { name: "Read" } }))
    ).toBe(true);
    expect(
      isWellFormedControlEvent(event({ kind: "approval_requested", approvalId: "a1" }))
    ).toBe(true);
  });

  it("rejects a file path that escapes its project", () => {
    for (const relativePath of ["../secrets.env", "a/../../b", "/etc/passwd", "C:/Windows/x"]) {
      expect(
        isWellFormedControlEvent(
          event({ kind: "file_read", file: { relativePath, projectId: "p1" } })
        ),
        relativePath
      ).toBe(false);
    }
  });

  it("rejects an absurd tool name", () => {
    expect(
      isWellFormedControlEvent(event({ kind: "tool_started", tool: { name: "x".repeat(200) } }))
    ).toBe(false);
  });
});

describe("reduction to the durable log", () => {
  it("drops an event with no run to attach to", () => {
    // The domain's log is per-run. An event before the session has a run has
    // nowhere to go, and inventing a run for it would be worse.
    expect(toDomainEventInput(event({ kind: "file_read" }))).toBeNull();
  });

  it("drops the kinds that are not durable", () => {
    expect(toDomainEventInput(event({ kind: "thinking", runId: "r1" }))).toBeNull();
    expect(toDomainEventInput(event({ kind: "message_sent", runId: "r1" }))).toBeNull();
  });

  it("reduces a file event to a link", () => {
    const reduced = toDomainEventInput(
      event({
        kind: "file_modified",
        runId: "r1",
        summary: "Edited  parser.ts",
        file: { relativePath: "src/parser.ts", projectId: "p1" },
        sourceId: "src-1",
      })
    );

    expect(reduced).toEqual({
      runId: "r1",
      kind: "link",
      summary: "Edited parser.ts",
      sourceId: "src-1",
    });
  });

  it("carries no tool or file detail into the durable log", () => {
    // The durable log is a summary line. Everything structural stays on the
    // live stream, which is not persisted.
    const reduced = toDomainEventInput(
      event({
        kind: "command_started",
        runId: "r1",
        tool: { name: "Bash", description: "Run the tests" },
      })
    );

    expect(reduced).not.toBeNull();
    expect(Object.keys(reduced!).sort()).toEqual(["kind", "runId", "summary"]);
  });

  it("normalizes the summary on the way through", () => {
    const reduced = toDomainEventInput(
      event({ kind: "error", runId: "r1", summary: "  broke\n  badly  " })
    );

    expect(reduced?.summary).toBe("broke badly");
  });
});
