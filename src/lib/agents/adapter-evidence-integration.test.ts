import { describe, expect, it } from "vitest";
import { ingestObservation } from "./adapter";
import { createAgent } from "./registry";
import { findRunByExternalId } from "./runs";
import { emptyAgentState } from "./types";
import { getWorkItemEvidenceRows } from "./work-item-evidence";
import { findWorkItemByExternalId } from "./work-items";
import type { AgentAdapterObservation } from "./adapter";
import type { AgentState } from "./types";

/**
 * The seam where an adapter's task attribution becomes stored evidence.
 *
 * The two halves were built separately: a provider can say "this file was
 * touched for task X" (`workItemExternalId`), and the domain can store
 * "task X touched this thing" (`recordWorkItemEvidence`). Neither reaches the
 * other on its own, because the provider never sees an artifact id and the
 * domain never sees a transcript. This is the join, and these tests are about
 * what it refuses as much as what it records.
 */

const T0 = 1_700_000_000_000;
const WORKSPACE = "ws-1";
const PROJECT = "C:\\Users\\someone\\project";

function seeded(): { state: AgentState; agentId: string } {
  const agent = createAgent(emptyAgentState(), { provider: "mock", name: "Mock" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  return { state: agent.state, agentId: agent.agent.id };
}

function ingest(
  state: AgentState,
  agentId: string,
  observation: AgentAdapterObservation,
  now = T0
): AgentState {
  const result = ingestObservation(state, { agentId, observation, now });
  if (!result.ok) throw new Error(`ingest failed: ${result.reason}`);
  return result.state;
}

/** An observation naming one file, optionally attributed to a task. */
function fileObservation(
  relativePath: string,
  workItemExternalId?: string,
  externalId = "sess-1"
): AgentAdapterObservation {
  return {
    provider: "mock",
    externalId,
    workspaceId: WORKSPACE,
    artifacts: [
      {
        projectPath: PROJECT,
        relativePath,
        role: "edited",
        sourceId: `toolu_${relativePath}`,
        ...(workItemExternalId ? { workItemExternalId } : {}),
      },
    ],
  };
}

/** The base observation, which is where work items ride. */
function runWithTasks(
  tasks: { externalId: string; title: string }[],
  externalId = "sess-1"
): AgentAdapterObservation {
  return {
    provider: "mock",
    externalId,
    workspaceId: WORKSPACE,
    workItems: tasks.map((task) => ({ ...task, status: "active" as const })),
  };
}

function runId(state: AgentState, agentId: string, externalId = "sess-1"): string {
  const run = findRunByExternalId(state, agentId, externalId);
  if (!run) throw new Error("no run");
  return run.id;
}

function evidenceFor(state: AgentState, run: string, taskExternalId: string) {
  const item = findWorkItemByExternalId(state, run, taskExternalId);
  if (!item) throw new Error(`no work item ${taskExternalId}`);
  return getWorkItemEvidenceRows(state, item.id);
}

describe("artifact evidence, wired from an adapter's attribution", () => {
  // A. The whole point.
  it("records one evidence row for an explicitly attributed file", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(initial, agentId, runWithTasks([{ externalId: "1", title: "Write it" }]));
    state = ingest(state, agentId, fileObservation("src/parser.ts", "1"));

    const run = runId(state, agentId);
    const rows = evidenceFor(state, run, "1");
    const artifact = state.artifacts.find((a) => a.relativePath === "src/parser.ts");

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("artifact");
    expect(rows[0].targetId).toBe(artifact?.id);
    expect(rows[0].workItemId).toBe(findWorkItemByExternalId(state, run, "1")?.id);
    expect(rows[0].runId).toBe(run);
    expect(rows[0].workspaceId).toBe(WORKSPACE);
  });

  // B. The common case: no attribution at all.
  it("ingests an unattributed file normally and records no evidence", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(initial, agentId, runWithTasks([{ externalId: "1", title: "Write it" }]));
    state = ingest(state, agentId, fileObservation("src/unattributed.ts"));

    const run = runId(state, agentId);

    // The artifact and its run-level link are recorded exactly as before.
    expect(state.artifacts.some((a) => a.relativePath === "src/unattributed.ts")).toBe(true);
    expect(state.artifactLinks.filter((link) => link.runId === run)).toHaveLength(1);
    // But nothing claims a task touched it.
    expect(evidenceFor(state, run, "1")).toEqual([]);
    expect(state.workItemEvidence).toEqual([]);
  });

  // C. An id that resolves to nothing.
  it("ingests the file but records no evidence for an unknown external id", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(initial, agentId, runWithTasks([{ externalId: "1", title: "Write it" }]));
    state = ingest(state, agentId, fileObservation("src/parser.ts", "does-not-exist"));

    const run = runId(state, agentId);

    expect(state.artifacts.some((a) => a.relativePath === "src/parser.ts")).toBe(true);
    expect(state.workItemEvidence).toEqual([]);
    // And emphatically not attached to the one task that does exist.
    expect(evidenceFor(state, run, "1")).toEqual([]);
  });

  // D. Containment: another run's task id must not reach this run.
  it("does not attribute a file to a task belonging to another run", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(
      initial,
      agentId,
      runWithTasks([{ externalId: "1", title: "Run A task" }], "sess-a")
    );
    // Run B has no tasks of its own, but its observation claims task "1".
    state = ingest(state, agentId, runWithTasks([], "sess-b"));
    state = ingest(state, agentId, fileObservation("src/b.ts", "1", "sess-b"));

    const runA = runId(state, agentId, "sess-a");
    const runB = runId(state, agentId, "sess-b");

    expect(state.workItemEvidence).toEqual([]);
    expect(evidenceFor(state, runA, "1")).toEqual([]);
    // Run B still recorded the file as its own run-level context.
    expect(state.artifactLinks.some((link) => link.runId === runB)).toBe(true);
  });

  // E. Polling re-reads the same bytes constantly.
  it("is idempotent — the same attributed observation twice is one row", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(initial, agentId, runWithTasks([{ externalId: "1", title: "Write it" }]));
    state = ingest(state, agentId, fileObservation("src/parser.ts", "1"));
    const afterFirst = state;

    state = ingest(state, agentId, fileObservation("src/parser.ts", "1"));

    expect(evidenceFor(state, runId(state, agentId), "1")).toHaveLength(1);
    expect(state.workItemEvidence).toHaveLength(1);
    // Unchanged by identity: a repeat poll must not churn a React key.
    expect(state.workItemEvidence).toBe(afterFirst.workItemEvidence);
  });

  // F. Two tasks must not bleed into each other.
  it("keeps two tasks' evidence disjoint", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(
      initial,
      agentId,
      runWithTasks([
        { externalId: "1", title: "First" },
        { externalId: "2", title: "Second" },
      ])
    );
    state = ingest(state, agentId, fileObservation("src/one.ts", "1"));
    state = ingest(state, agentId, fileObservation("src/two.ts", "2"));

    const run = runId(state, agentId);
    const one = state.artifacts.find((a) => a.relativePath === "src/one.ts");
    const two = state.artifacts.find((a) => a.relativePath === "src/two.ts");

    expect(evidenceFor(state, run, "1").map((row) => row.targetId)).toEqual([one?.id]);
    expect(evidenceFor(state, run, "2").map((row) => row.targetId)).toEqual([two?.id]);
  });

  it("records one file for two tasks only when both were attributed", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(
      initial,
      agentId,
      runWithTasks([
        { externalId: "1", title: "First" },
        { externalId: "2", title: "Second" },
      ])
    );
    state = ingest(state, agentId, fileObservation("src/shared.ts", "1"));
    state = ingest(state, agentId, fileObservation("src/shared.ts", "2"));

    const run = runId(state, agentId);
    const shared = state.artifacts.find((a) => a.relativePath === "src/shared.ts");

    expect(evidenceFor(state, run, "1").map((row) => row.targetId)).toEqual([shared?.id]);
    expect(evidenceFor(state, run, "2").map((row) => row.targetId)).toEqual([shared?.id]);
    // One artifact, two rows — not two artifacts.
    expect(state.artifacts.filter((a) => a.relativePath === "src/shared.ts")).toHaveLength(1);
  });

  it("creates the task and evidences it when one observation carries both", () => {
    const { state: initial, agentId } = seeded();

    // Work items are folded before artifacts precisely so this resolves.
    const state = ingest(initial, agentId, {
      provider: "mock",
      externalId: "sess-1",
      workspaceId: WORKSPACE,
      workItems: [{ externalId: "1", title: "Write it", status: "active" }],
      artifacts: [
        {
          projectPath: PROJECT,
          relativePath: "src/parser.ts",
          role: "edited",
          workItemExternalId: "1",
        },
      ],
    });

    expect(evidenceFor(state, runId(state, agentId), "1")).toHaveLength(1);
  });

  it("attributes only artifacts — never tabs or events", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(initial, agentId, runWithTasks([{ externalId: "1", title: "Write it" }]));
    state = ingest(state, agentId, {
      ...fileObservation("src/parser.ts", "1"),
      activity: "Edited parser.ts",
      sourceId: "toolu_activity",
      url: "https://example.com/docs",
    });

    // The run has events, and the observation carried a url, but Claude Code's
    // transcript offers no structural basis for tying either to a task.
    expect([...new Set(state.workItemEvidence.map((row) => row.kind))]).toEqual(["artifact"]);
    expect(state.events.length).toBeGreaterThan(0);
  });

  it("records nothing when the file itself was refused", () => {
    const { state: initial, agentId } = seeded();
    let state = ingest(initial, agentId, runWithTasks([{ externalId: "1", title: "Write it" }]));

    // A path escaping its project yields no artifact, so an attribution has
    // nothing to point at and the inner containment gate is never reached.
    state = ingest(state, agentId, {
      provider: "mock",
      externalId: "sess-1",
      workspaceId: WORKSPACE,
      artifacts: [
        {
          projectPath: PROJECT,
          relativePath: "../../../etc/passwd",
          role: "edited",
          workItemExternalId: "1",
        },
      ],
    });

    expect(state.artifacts).toEqual([]);
    expect(state.workItemEvidence).toEqual([]);
  });
});
