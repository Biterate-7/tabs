import { describe, expect, it } from "vitest";
import { advanceTaskWindow, normalizeSession } from "./normalizer";
import { parseTranscriptLine } from "./parser";
import { NO_TASK_WINDOW } from "./types";
import type { ClaudeParsedRecord, ClaudeTaskWindow } from "./types";
import type { AgentAdapterObservation, AgentArtifactObservation } from "@/lib/agents/adapter";

/**
 * Work-item attribution: which file operations the adapter is willing to say
 * belong to which task.
 *
 * Everything here goes through the real parser and the real normalizer, from
 * transcript lines. A test that constructed `ClaudeParsedRecord`s by hand
 * could assert the window logic while quietly disagreeing with what the
 * parser actually produces from a transcript, which is the one thing these
 * rules cannot afford.
 *
 * The transcript shapes are the ones observed live — see
 * docs/claude-code-evidence-attribution.md for the survey those came from.
 */

const SESSION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "C:\\Users\\someone\\project";
const T0 = Date.parse("2026-09-20T08:00:00.000Z");

const session = { externalId: SESSION, projectPath: PROJECT, lastObservedAt: T0 };

let nextToolId = 0;

function line(name: string, input: unknown): string {
  nextToolId += 1;
  return JSON.stringify({
    type: "assistant",
    uuid: `00000000-0000-4000-8000-${String(nextToolId).padStart(12, "0")}`,
    timestamp: "2026-09-20T08:00:00.000Z",
    sessionId: SESSION,
    message: { content: [{ type: "tool_use", id: `toolu_${nextToolId}`, name, input }] },
  });
}

/** `TaskCreate`, whose input is exactly `{subject, description}`. */
const create = (subject: string) => line("TaskCreate", { subject });
/** `TaskUpdate`, whose input is exactly `{taskId, status}`. */
const start = (taskId: string) => line("TaskUpdate", { taskId, status: "in_progress" });
const finish = (taskId: string) => line("TaskUpdate", { taskId, status: "completed" });
const read = (file: string) => line("Read", { file_path: `${PROJECT}\\${file}` });
const edit = (file: string) => line("Edit", { file_path: `${PROJECT}\\${file}` });

function parseAll(lines: string[]): ClaudeParsedRecord[] {
  const records: ClaudeParsedRecord[] = [];
  for (const raw of lines) {
    const parsed = parseTranscriptLine(raw);
    if (parsed) records.push(parsed);
  }
  return records;
}

function observe(
  lines: string[],
  taskWindowBase: ClaudeTaskWindow = NO_TASK_WINDOW
): AgentAdapterObservation[] {
  return normalizeSession({ session, records: parseAll(lines), now: T0, taskWindowBase });
}

/** Every artifact observation that carries an attribution, as `task -> path`. */
function attributed(observations: AgentAdapterObservation[]): string[] {
  const out: string[] = [];
  for (const observation of observations) {
    for (const artifact of observation.artifacts ?? []) {
      if (artifact.workItemExternalId) {
        out.push(`${artifact.workItemExternalId} -> ${artifact.relativePath}`);
      }
    }
  }
  return out.sort();
}

/** Every artifact observation, attributed or not. Run-level context. */
function allArtifacts(observations: AgentAdapterObservation[]): AgentArtifactObservation[] {
  return observations.flatMap((observation) => observation.artifacts ?? []);
}

describe("work-item attribution", () => {
  // A. One explicit read inside one window.
  it("attributes a file a task explicitly read while open", () => {
    const observations = observe([
      create("Review the config"),
      start("1"),
      read("src/config.ts"),
      finish("1"),
    ]);

    expect(attributed(observations)).toEqual(["1 -> src/config.ts"]);
  });

  // B. The same, for a modification.
  it("attributes a file a task explicitly edited while open", () => {
    const observations = observe([
      create("Fix the config"),
      start("1"),
      edit("src/config.ts"),
      finish("1"),
    ]);

    expect(attributed(observations)).toEqual(["1 -> src/config.ts"]);
    expect(allArtifacts(observations)[0].role).toBe("edited");
  });

  // C. Two files, one task, two rows.
  it("attributes every file a task touched", () => {
    const observations = observe([
      create("Compare both"),
      start("1"),
      read("src/a.ts"),
      read("src/b.ts"),
      finish("1"),
    ]);

    expect(attributed(observations)).toEqual(["1 -> src/a.ts", "1 -> src/b.ts"]);
  });

  // D. Two tasks, different files, no bleed.
  it("keeps two tasks' files separate", () => {
    const observations = observe([
      create("First"),
      create("Second"),
      start("1"),
      edit("src/one.ts"),
      finish("1"),
      start("2"),
      edit("src/two.ts"),
      finish("2"),
    ]);

    expect(attributed(observations)).toEqual(["1 -> src/one.ts", "2 -> src/two.ts"]);
  });

  // E. Two tasks, same file, each explicitly.
  it("attributes one file to both tasks that explicitly touched it", () => {
    const observations = observe([
      create("First"),
      create("Second"),
      start("1"),
      read("src/shared.ts"),
      finish("1"),
      start("2"),
      edit("src/shared.ts"),
      finish("2"),
    ]);

    expect(attributed(observations)).toEqual(["1 -> src/shared.ts", "2 -> src/shared.ts"]);
  });

  // F. Present in the run, absent from the task.
  it("does not attribute a file touched outside any window", () => {
    const observations = observe([
      read("src/before.ts"),
      create("Work"),
      start("1"),
      edit("src/during.ts"),
      finish("1"),
      read("src/after.ts"),
    ]);

    expect(attributed(observations)).toEqual(["1 -> src/during.ts"]);
    // The other two are still run-level context — recorded, just not evidence.
    expect(allArtifacts(observations).map((a) => a.relativePath).sort()).toEqual([
      "src/after.ts",
      "src/before.ts",
      "src/during.ts",
    ]);
  });

  // G. Prose is not an observation.
  it("does not attribute a file named only in task prose", () => {
    const observations = observe([
      create("Rewrite src/mentioned.ts from scratch"),
      start("1"),
      finish("1"),
    ]);

    expect(attributed(observations)).toEqual([]);
    expect(allArtifacts(observations)).toEqual([]);
  });

  // H1. Ambiguity: a completion for a task that never started.
  it("attributes nothing from a window an untracked task completed inside", () => {
    // The shape observed live in 9fdc10e8: task 2 runs, then task 3 is
    // completed having never been started, so task 3's work happened
    // somewhere inside task 2's span.
    const observations = observe([
      create("One"),
      create("Two"),
      create("Three"),
      start("2"),
      edit("src/ambiguous.ts"),
      finish("2"),
      finish("3"),
    ]);

    expect(attributed(observations)).toEqual([]);
    // Still context. Refusing to attribute is not refusing to record.
    expect(allArtifacts(observations).map((a) => a.relativePath)).toEqual(["src/ambiguous.ts"]);
  });

  // H2. Ambiguity: two tasks open at once (never observed live).
  it("attributes nothing while two tasks are open", () => {
    const observations = observe([
      create("One"),
      create("Two"),
      start("1"),
      edit("src/first.ts"),
      start("2"),
      edit("src/second.ts"),
      finish("2"),
    ]);

    // Task 1's span is contaminated by the overlap; task 2's span opened
    // while another was already open, so neither is safe to claim.
    expect(attributed(observations)).toEqual([]);
  });

  // H3. Ambiguity: order within a record is unrecoverable.
  it("attributes nothing from a record that mixes a task event with a file tool", () => {
    const mixed = JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-99999999ffff",
      timestamp: "2026-09-20T08:00:00.000Z",
      sessionId: SESSION,
      message: {
        content: [
          { type: "tool_use", id: "toolu_m1", name: "Edit", input: { file_path: `${PROJECT}\\src/mixed.ts` } },
          { type: "tool_use", id: "toolu_m2", name: "TaskUpdate", input: { taskId: "1", status: "completed" } },
        ],
      },
    });

    const observations = observe([create("One"), start("1"), edit("src/clean.ts"), mixed]);

    expect(attributed(observations)).toEqual([]);
  });

  // I. Nothing to show is a valid answer.
  it("attributes nothing for a task that touched no file", () => {
    const observations = observe([create("Think about it"), start("1"), finish("1")]);

    expect(attributed(observations)).toEqual([]);
  });

  // J/K. The observation carries no run or workspace of its own: both are
  // resolved downstream from (agentId, externalId). What this layer owes is
  // that an attribution never names anything but a task id scoped to THIS
  // session, which is what makes a cross-run match impossible downstream.
  it("attributes only session-scoped task ids, never a run or workspace", () => {
    const observations = observe([create("Work"), start("1"), edit("src/a.ts"), finish("1")]);
    const artifact = allArtifacts(observations)[0];

    expect(artifact.workItemExternalId).toBe("1");
    expect(Object.keys(artifact).sort()).toEqual([
      "projectPath",
      "relativePath",
      "role",
      "sourceId",
      "workItemExternalId",
    ]);
  });

  // L. Older cursors, and sessions seen mid-flight, must not guess.
  it("attributes nothing when the window carried in is unknown", () => {
    const observations = observe([read("src/orphan.ts"), finish("4")]);

    expect(attributed(observations)).toEqual([]);
  });

  // M. Re-reading the same bytes must decide the same way.
  it("is deterministic across a repeated read of the same records", () => {
    const lines = [create("Work"), start("1"), edit("src/a.ts"), read("src/b.ts"), finish("1")];
    const first = attributed(observe(lines));
    const second = attributed(observe(lines));

    expect(first).toEqual(second);
    expect(first).toEqual(["1 -> src/a.ts", "1 -> src/b.ts"]);
  });

  // N. Torn and malformed input must not invent attribution.
  it("survives malformed records without fabricating attribution", () => {
    const observations = observe([
      create("Work"),
      start("1"),
      "{ not json",
      "",
      JSON.stringify({ type: "assistant", message: { content: "not an array" } }),
      edit("src/a.ts"),
      finish("1"),
    ]);

    expect(attributed(observations)).toEqual(["1 -> src/a.ts"]);
  });

  it("ignores an unrecognised status rather than closing a window", () => {
    const observations = observe([
      create("Work"),
      start("1"),
      line("TaskUpdate", { taskId: "1", status: "cancelled" }),
      edit("src/a.ts"),
      finish("1"),
    ]);

    // `cancelled` is not a status Claude Code writes, so it means no change —
    // the window is still task 1's.
    expect(attributed(observations)).toEqual(["1 -> src/a.ts"]);
  });

  it("does not attribute a file a shell command touched", () => {
    const observations = observe([
      create("Work"),
      start("1"),
      line("Bash", { command: "rm src/a.ts", description: "Remove a file" }),
    ]);

    expect(allArtifacts(observations)).toEqual([]);
  });

  it("does not attribute a path from an unrecognised tool", () => {
    const observations = observe([
      create("Work"),
      start("1"),
      line("SomeFutureTool", { file_path: `${PROJECT}\\src/a.ts` }),
    ]);

    // No role, so no artifact exists for the evidence to point at.
    expect(allArtifacts(observations)).toEqual([]);
  });

  it("does not attribute a file outside the project", () => {
    const observations = observe([
      create("Work"),
      start("1"),
      line("Read", { file_path: "C:\\Users\\someone\\.ssh\\id_rsa" }),
    ]);

    expect(allArtifacts(observations)).toEqual([]);
  });
});

describe("task windows across polls", () => {
  it("carries an open window into the next poll", () => {
    const first = parseAll([create("Work"), start("1"), edit("src/a.ts")]);
    const carried = advanceTaskWindow(first, NO_TASK_WINDOW);

    expect(carried).toEqual({ openTaskId: "1", contaminated: false });

    // The next poll's records continue the same span.
    const observations = observe([read("src/b.ts"), finish("1")], carried);
    expect(attributed(observations)).toEqual(["1 -> src/b.ts"]);
  });

  it("closes a window that the next poll finishes", () => {
    const records = parseAll([finish("1")]);

    expect(advanceTaskWindow(records, { openTaskId: "1", contaminated: false })).toEqual(
      NO_TASK_WINDOW
    );
  });

  it("carries contamination into the next poll", () => {
    const observations = observe([read("src/a.ts")], { openTaskId: "1", contaminated: true });

    expect(attributed(observations)).toEqual([]);
  });

  it("leaves a poll that read nothing exactly where it was", () => {
    const window = { openTaskId: "3", contaminated: false };

    expect(advanceTaskWindow([], window)).toEqual(window);
  });

  it("attributes nothing from a span that has not closed yet", () => {
    // The span may still turn out to be contaminated by something this poll
    // has not read. Paying out only at the close is what makes late
    // contamination survivable.
    const observations = observe([create("Work"), start("1"), edit("src/a.ts")]);

    expect(attributed(observations)).toEqual([]);
    expect(allArtifacts(observations).map((a) => a.relativePath)).toEqual(["src/a.ts"]);
  });

  it("does not attribute a span whose orphan completion lands in the next poll", () => {
    // Measured on the survey machine: attributing at the tool call instead of
    // at the close credited two of task 3's files to task 2, because task 3's
    // orphan completion arrived in a later batch. Split here at exactly that
    // boundary — the first poll must claim nothing.
    const first = [create("Two"), create("Three"), start("2"), edit("src/shared.ts")];
    const carried = advanceTaskWindow(parseAll(first), NO_TASK_WINDOW);

    expect(attributed(observe(first))).toEqual([]);

    // And the poll that closes it sees the orphan in the same batch, so the
    // span is contaminated before anything is paid out.
    expect(attributed(observe([finish("2"), finish("3")], carried))).toEqual([]);
  });

  it("does not let one session's window reach another", () => {
    // Windows live per-session in the cursor; a normalizer call only ever
    // sees one session's records and one session's base.
    const a = observe([create("A"), start("1"), edit("src/a.ts"), finish("1")]);
    const b = observe([edit("src/b.ts")], NO_TASK_WINDOW);

    expect(attributed(a)).toEqual(["1 -> src/a.ts"]);
    expect(attributed(b)).toEqual([]);
  });
});
