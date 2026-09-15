import { describe, expect, it } from "vitest";
import { countCreatedTasks, normalizeSession, redactAbsolutePaths } from "./normalizer";
import { parseTranscriptLine } from "./parser";
import { CLAUDE_CODE_PROVIDER } from "./types";
import type { ClaudeDiscoveredSession, ClaudeParsedRecord } from "./types";
import type { ObservedWorkItem } from "@/lib/agents/adapter";

const T0 = Date.parse("2026-09-15T08:00:00.000Z");
const SESSION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "C:\\Users\\someone\\project";

/** A transcript line carrying one tool_use block. */
function assistantLine(name: string, input: unknown, id = "toolu_1"): string {
  return JSON.stringify({
    type: "assistant",
    uuid: "22222222-2222-4222-8222-222222222222",
    timestamp: "2026-09-15T08:00:00.000Z",
    sessionId: SESSION,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}

function parse(name: string, input: unknown, id = "toolu_1"): ClaudeParsedRecord {
  const parsed = parseTranscriptLine(assistantLine(name, input, id));
  if (!parsed) throw new Error("expected a record");
  return parsed;
}

const session: ClaudeDiscoveredSession = {
  externalId: SESSION,
  projectPath: PROJECT,
  lastObservedAt: T0,
};

/** The work items a batch of records produces, via the real normalizer. */
function workItemsFor(records: ClaudeParsedRecord[], taskOrdinalBase = 0): ObservedWorkItem[] {
  const [base] = normalizeSession({ session, records, now: T0, taskOrdinalBase });
  return base.workItems ?? [];
}

describe("parsing task tools", () => {
  it("reads a subject and description from TaskCreate", () => {
    const record = parse("TaskCreate", {
      subject: "Implement authentication",
      description: "Add the sign-in route and its tests.",
    });

    expect(record.tasks).toEqual([
      {
        kind: "create",
        subject: "Implement authentication",
        description: "Add the sign-in route and its tests.",
      },
    ]);
  });

  it("reads a taskId and status from TaskUpdate", () => {
    expect(parse("TaskUpdate", { taskId: "3", status: "completed" }).tasks).toEqual([
      { kind: "update", taskId: "3", status: "completed" },
    ]);
  });

  it("ignores a TaskCreate with no subject — there is nothing to name it", () => {
    expect(parse("TaskCreate", { description: "detail only" }).tasks).toEqual([]);
    expect(parse("TaskCreate", { subject: "   " }).tasks).toEqual([]);
  });

  it("ignores an unrecognised status rather than guessing one", () => {
    // Only in_progress and completed were ever observed. Anything else means
    // no status change — never a manufactured failure or cancellation.
    for (const status of ["blocked", "failed", "cancelled", "pending", 7, null]) {
      expect(parse("TaskUpdate", { taskId: "1", status }).tasks).toEqual([]);
    }
  });

  it("reads NOTHING from spawn_task, which carries a raw prompt", () => {
    const record = parse("mcp__ccd_session__spawn_task", {
      prompt: "`parseUrls` in src/lib/tabs/parse.ts truncates URLs. Reproduce with...",
      title: "Fix parseUrls",
      tldr: "A summary",
    });

    // The tool allowlist is two exact names. A pattern would have matched this.
    expect(record.tasks).toEqual([]);
    expect(JSON.stringify(record)).not.toContain("parseUrls");
    expect(JSON.stringify(record)).not.toContain("prompt");
  });

  it("reads nothing from dismiss_task either", () => {
    expect(parse("mcp__ccd_session__dismiss_task", { task_id: "x", reason: "y" }).tasks).toEqual(
      []
    );
  });

  it("ignores every other key of the task tools themselves", () => {
    const record = parse("TaskCreate", {
      subject: "Real subject",
      description: "Real description",
      prompt: "SECRET PROMPT",
      command: "rm -rf /",
      cwd: "C:\\Users\\someone\\secrets",
    });

    const serialized = JSON.stringify(record.tasks);
    expect(serialized).not.toContain("SECRET PROMPT");
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("secrets");
  });
});

describe("redacting absolute paths from task prose", () => {
  it("removes a Windows drive path", () => {
    expect(redactAbsolutePaths("Update C:\\Users\\someone\\project\\src\\a.ts now")).toBe(
      "Update [path] now"
    );
    expect(redactAbsolutePaths("Update C:/Users/someone/project/src/a.ts now")).toBe(
      "Update [path] now"
    );
  });

  it("removes a UNC share", () => {
    expect(redactAbsolutePaths("Copy from \\\\server\\share\\file")).toBe("Copy from [path]");
  });

  it("removes well-known POSIX roots", () => {
    expect(redactAbsolutePaths("Read /home/alice/project/config")).toBe("Read [path]");
    expect(redactAbsolutePaths("Read /Users/bob/notes.md")).toBe("Read [path]");
  });

  it("leaves an API route alone — it is not a filesystem path", () => {
    // Redacting this would mangle ordinary task text to guard against nothing.
    expect(redactAbsolutePaths("Add auth to the /api/users endpoint")).toBe(
      "Add auth to the /api/users endpoint"
    );
  });

  it("leaves a project-relative path alone", () => {
    expect(redactAbsolutePaths("Write 02 - Causes/Medium-Term Causes.md")).toBe(
      "Write 02 - Causes/Medium-Term Causes.md"
    );
    expect(redactAbsolutePaths("Edit src/lib/agents/work-items.ts")).toBe(
      "Edit src/lib/agents/work-items.ts"
    );
  });
});

describe("mapping tasks to work item observations", () => {
  it("numbers tasks by creation order, 1-based", () => {
    const items = workItemsFor([
      parse("TaskCreate", { subject: "First" }, "t1"),
      parse("TaskCreate", { subject: "Second" }, "t2"),
      parse("TaskCreate", { subject: "Third" }, "t3"),
    ]);

    expect(items.map((i) => [i.externalId, i.title])).toEqual([
      ["1", "First"],
      ["2", "Second"],
      ["3", "Third"],
    ]);
  });

  it("creates tasks as pending, not as started", () => {
    const items = workItemsFor([parse("TaskCreate", { subject: "First" })]);
    expect(items[0].status).toBe("pending");
  });

  it("folds an update into the creation it belongs to, within one poll", () => {
    const items = workItemsFor([
      parse("TaskCreate", { subject: "First" }, "t1"),
      parse("TaskUpdate", { taskId: "1", status: "in_progress" }, "t2"),
      parse("TaskUpdate", { taskId: "1", status: "completed" }, "t3"),
    ]);

    // One entry carrying the final state, not three.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: "1", title: "First", status: "completed" });
  });

  it("emits a title-less entry for an update whose creation was an earlier poll", () => {
    const items = workItemsFor([parse("TaskUpdate", { taskId: "2", status: "completed" })]);

    expect(items).toEqual([{ externalId: "2", status: "completed" }]);
    // No title means ingestion can only ever update, never create.
    expect(items[0].title).toBeUndefined();
  });

  it("continues numbering from the carried ordinal across polls", () => {
    // Poll one created two tasks.
    const first = [
      parse("TaskCreate", { subject: "One" }, "t1"),
      parse("TaskCreate", { subject: "Two" }, "t2"),
    ];
    expect(countCreatedTasks(first)).toBe(2);

    // Poll two continues from there rather than restarting at 1.
    const items = workItemsFor([parse("TaskCreate", { subject: "Three" })], 2);
    expect(items[0].externalId).toBe("3");
  });

  it("maps in_progress to active and completed to completed", () => {
    const items = workItemsFor([
      parse("TaskCreate", { subject: "A" }, "t1"),
      parse("TaskCreate", { subject: "B" }, "t2"),
      parse("TaskUpdate", { taskId: "1", status: "in_progress" }, "t3"),
      parse("TaskUpdate", { taskId: "2", status: "completed" }, "t4"),
    ]);

    expect(items.map((i) => i.status)).toEqual(["active", "completed"]);
  });

  it("carries a description through as the summary", () => {
    const items = workItemsFor([
      parse("TaskCreate", { subject: "A", description: "The longer detail" }),
    ]);
    expect(items[0].summary).toBe("The longer detail");
  });

  it("redacts an absolute path a model wrote into a subject", () => {
    const items = workItemsFor([
      parse("TaskCreate", {
        subject: "Fix C:\\Users\\someone\\project\\src\\a.ts",
        description: "Also check /home/someone/other",
      }),
    ]);

    expect(items[0].title).toBe("Fix [path]");
    expect(items[0].summary).toBe("Also check [path]");
    expect(JSON.stringify(items)).not.toContain("someone");
  });

  it("produces no work items for a session that used no task tools", () => {
    const [base] = normalizeSession({
      session,
      records: [parse("Edit", { file_path: `${PROJECT}\\src\\a.ts` })],
      now: T0,
    });

    // The correct answer for a provider with no work-item evidence is
    // *nothing* — not an invented item derived from the files it touched.
    expect(base.workItems).toBeUndefined();
  });

  it("never emits progress, because Claude Code counts nothing", () => {
    const items = workItemsFor([
      parse("TaskCreate", { subject: "A" }, "t1"),
      parse("TaskUpdate", { taskId: "1", status: "completed" }, "t2"),
    ]);
    expect(items[0].progress).toBeUndefined();
  });

  it("attaches work items to the session-level observation", () => {
    const [base, ...rest] = normalizeSession({
      session,
      records: [parse("TaskCreate", { subject: "A" })],
      now: T0,
    });

    expect(base.provider).toBe(CLAUDE_CODE_PROVIDER);
    expect(base.externalId).toBe(SESSION);
    expect(base.workItems).toHaveLength(1);
    // Per-tool observations carry none.
    for (const observation of rest) expect(observation.workItems).toBeUndefined();
  });

  it("is idempotent: the same records twice give the same observations", () => {
    const records = [
      parse("TaskCreate", { subject: "A" }, "t1"),
      parse("TaskUpdate", { taskId: "1", status: "in_progress" }, "t2"),
    ];

    expect(workItemsFor(records)).toEqual(workItemsFor(records));
  });
});

describe("no completion is inferred from disappearance", () => {
  it("a session with a terminal sidecar still reports no task completion", () => {
    const [base] = normalizeSession({
      session: { ...session, terminal: "deleted" },
      records: [parse("TaskCreate", { subject: "Unfinished work" })],
      now: T0,
    });

    // The RUN is cancelled — that is an explicit lifecycle artifact. The task
    // is not: nothing said it finished, so it stays exactly as observed.
    expect(base.status).toBe("cancelled");
    expect(base.workItems?.[0].status).toBe("pending");
  });

  it("an empty batch of records reports nothing about any task", () => {
    const [base] = normalizeSession({ session, records: [], now: T0, taskOrdinalBase: 5 });
    expect(base.workItems).toBeUndefined();
  });
});
