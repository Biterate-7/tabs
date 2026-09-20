import { describe, expect, it } from "vitest";
import {
  PROJECT,
  T0,
  withAgent,
  withArtifact,
  withEventId,
  withRun,
  withTabLink,
  withWorkItem,
} from "./intelligence/__fixtures__/domain";
import { deleteRun } from "./runs";
import { pruneRunLinks } from "./links";
import {
  agentWorkItemEvidenceId,
  getWorkItemEvidenceRows,
  pruneWorkItemEvidence,
  recordWorkItemEvidence,
  removeWorkItemEvidenceForWorkItem,
} from "./work-item-evidence";
import { deleteWorkItem } from "./work-items";
import { MAX_EVIDENCE_PER_WORK_ITEM } from "./types";
import type { AgentState } from "./types";

/**
 * Task-level evidence, at the domain boundary.
 *
 * The suite is organised around the one thing this entity exists to
 * guarantee: an association exists because it was observed, and for no other
 * reason. Most of these tests are therefore about what the domain *refuses*
 * to store.
 */

/** A run with one tab, one file and one event, plus two work items. */
function scenario() {
  const base = withAgent();
  const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });

  const a = withWorkItem(run.state, { runId: run.runId, title: "Task A" });
  const b = withWorkItem(a.state, { runId: run.runId, title: "Task B" });

  const tabbed = withTabLink(b.state, { runId: run.runId, tabId: "tab-1", role: "context" });
  const filed = withArtifact(tabbed, { runId: run.runId, path: "src/a.ts", role: "edited" });
  const evented = withEventId(filed.state, { runId: run.runId, summary: "Edited a.ts" });

  return {
    state: evented.state,
    runId: run.runId,
    agentId: base.agentId,
    itemA: a.workItemId,
    itemB: b.workItemId,
    artifactId: filed.artifactId,
    eventId: evented.eventId,
  };
}

describe("recordWorkItemEvidence", () => {
  it("records an association the run actually holds", () => {
    const s = scenario();
    const result = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.evidence.runId).toBe(s.runId);
    expect(result.evidence.workspaceId).toBe("w1");
  });

  it("is idempotent — the same observation twice is one row", () => {
    const s = scenario();
    const first = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = recordWorkItemEvidence(
      first.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0 + 5000
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.created).toBe(false);
    // The state object itself is returned unchanged, so a consumer
    // memoising on it does no work for a re-observation.
    expect(second.state).toBe(first.state);
    expect(second.state.workItemEvidence).toHaveLength(1);
  });

  it("derives its id, so re-observation cannot mint a second row", () => {
    const s = scenario();
    expect(agentWorkItemEvidenceId(s.itemA, "tab", "tab-1")).toBe(`${s.itemA}:tab:tab-1`);
  });

  /*
    The containment rule. Each of these targets is a real thing somewhere —
    it just is not something this run touched — and the point is that being
    real is not sufficient.
  */
  it("refuses a tab the run never linked", () => {
    const s = scenario();
    const result = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-not-linked" },
      T0
    );
    expect(result).toEqual({ ok: false, reason: "evidence-target-not-found" });
  });

  it("refuses an event belonging to a different run", () => {
    const s = scenario();
    const other = withRun(s.state, { agentId: s.agentId, workspaceId: "w1" }, T0 + 1);
    const otherEvent = withEventId(other.state, { runId: other.runId, summary: "Elsewhere" });

    const result = recordWorkItemEvidence(
      otherEvent.state,
      { workItemId: s.itemA, kind: "event", targetId: otherEvent.eventId },
      T0
    );
    expect(result).toEqual({ ok: false, reason: "evidence-target-not-found" });
  });

  it("refuses a file another run touched in another workspace", () => {
    const s = scenario();
    const other = withRun(s.state, { agentId: s.agentId, workspaceId: "w2" }, T0 + 1);
    const otherFile = withArtifact(other.state, {
      runId: other.runId,
      path: "src/secret.ts",
      role: "edited",
      projectPath: PROJECT,
    });

    const result = recordWorkItemEvidence(
      otherFile.state,
      { workItemId: s.itemA, kind: "artifact", targetId: otherFile.artifactId },
      T0
    );
    expect(result).toEqual({ ok: false, reason: "evidence-target-not-found" });
  });

  it("refuses an unknown work item", () => {
    const s = scenario();
    const result = recordWorkItemEvidence(
      s.state,
      { workItemId: "nope", kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(result).toEqual({ ok: false, reason: "work-item-not-found" });
  });

  it("refuses an unknown kind", () => {
    const s = scenario();
    const result = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "workspace" as never, targetId: "w1" },
      T0
    );
    expect(result).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("stops at the per-item cap rather than growing without bound", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const item = withWorkItem(run.state, { runId: run.runId, title: "Busy" });

    let state: AgentState = item.state;
    for (let i = 0; i < MAX_EVIDENCE_PER_WORK_ITEM + 5; i += 1) {
      state = withTabLink(state, { runId: run.runId, tabId: `tab-${i}`, role: "context" });
      const result = recordWorkItemEvidence(
        state,
        { workItemId: item.workItemId, kind: "tab", targetId: `tab-${i}` },
        T0 + i
      );
      if (result.ok) state = result.state;
    }

    expect(state.workItemEvidence).toHaveLength(MAX_EVIDENCE_PER_WORK_ITEM);
    // Oldest wins: the first thing evidenced for a task is what explains it.
    expect(state.workItemEvidence[0]?.targetId).toBe("tab-0");
  });
});

describe("evidence stays disjoint between tasks", () => {
  it("does not leak one task's tab into another task in the same run", () => {
    const s = scenario();

    // Two tabs, both on the run. Each attributed to exactly one task.
    let state = withTabLink(s.state, { runId: s.runId, tabId: "tab-2", role: "context" });
    const first = recordWorkItemEvidence(
      state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = recordWorkItemEvidence(
      first.state,
      { workItemId: s.itemB, kind: "tab", targetId: "tab-2" },
      T0
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    state = second.state;

    expect(getWorkItemEvidenceRows(state, s.itemA).map((row) => row.targetId)).toEqual(["tab-1"]);
    expect(getWorkItemEvidenceRows(state, s.itemB).map((row) => row.targetId)).toEqual(["tab-2"]);
  });

  it("shares a target between tasks only when a second row says so", () => {
    const s = scenario();
    const first = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Before the explicit second attribution, B has nothing.
    expect(getWorkItemEvidenceRows(first.state, s.itemB)).toEqual([]);

    const second = recordWorkItemEvidence(
      first.state,
      { workItemId: s.itemB, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(getWorkItemEvidenceRows(second.state, s.itemB).map((row) => row.targetId)).toEqual([
      "tab-1",
    ]);
  });
});

describe("evidence lifecycle", () => {
  it("goes with its work item", () => {
    const s = scenario();
    const recorded = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const deleted = deleteWorkItem(recorded.state, s.itemA);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.state.workItemEvidence).toEqual([]);
  });

  it("goes with its run", () => {
    const s = scenario();
    const recorded = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "event", targetId: s.eventId },
      T0
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const deleted = deleteRun(recorded.state, s.runId);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.state.workItemEvidence).toEqual([]);
  });

  it("goes with a deleted tab, rather than pointing at one the run no longer holds", () => {
    const s = scenario();
    const recorded = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const pruned = pruneRunLinks(recorded.state, new Set<string>());
    expect(pruned.links).toEqual([]);
    expect(pruned.workItemEvidence).toEqual([]);
  });

  it("removeWorkItemEvidenceForWorkItem drops exactly one task's rows", () => {
    const s = scenario();
    let state = s.state;
    for (const workItemId of [s.itemA, s.itemB]) {
      const result = recordWorkItemEvidence(
        state,
        { workItemId, kind: "artifact", targetId: s.artifactId },
        T0
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      state = result.state;
    }

    const next = removeWorkItemEvidenceForWorkItem(state, s.itemA);
    expect(getWorkItemEvidenceRows(next, s.itemA)).toEqual([]);
    expect(getWorkItemEvidenceRows(next, s.itemB)).toHaveLength(1);
  });

  it("pruneWorkItemEvidence drops a row whose target the run no longer holds", () => {
    const s = scenario();
    const recorded = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    // Hand-constructed impossible state: the link is gone but the evidence
    // remains. This is exactly what prune exists to clean up.
    const orphaned = { ...recorded.state, links: [] };
    expect(pruneWorkItemEvidence(orphaned).workItemEvidence).toEqual([]);
  });

  it("leaves a healthy state untouched, by identity", () => {
    const s = scenario();
    const recorded = recordWorkItemEvidence(
      s.state,
      { workItemId: s.itemA, kind: "tab", targetId: "tab-1" },
      T0
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(pruneWorkItemEvidence(recorded.state)).toBe(recorded.state);
  });
});

describe("nothing derives evidence", () => {
  it("a run with tabs, files and events gives its work items none of them", () => {
    const s = scenario();
    // The run holds a tab, a file and an event, and both work items belong
    // to it. If any join through the shared run existed, this would be
    // non-empty — which is precisely the assertion the domain refuses.
    expect(getWorkItemEvidenceRows(s.state, s.itemA)).toEqual([]);
    expect(getWorkItemEvidenceRows(s.state, s.itemB)).toEqual([]);
    expect(s.state.workItemEvidence).toEqual([]);
  });
});
