import { describe, expect, it } from "vitest";
import { buildAgentDomainIndex } from "./domain-index";
import { getAgentRunImpact } from "./impact";
import { getAgentRunSummary } from "./run-summary";
import { getWorkItemsForWorkspace } from "./selectors";
import {
  getWorkspaceActivityCards,
  getWorkspaceAgentActivity,
} from "./workspace-activity";
import {
  T0,
  withAgent,
  withArtifact,
  withRun,
  withTabLink,
  withWorkItem,
} from "./__fixtures__/domain";
import type { AgentState, AgentWorkItemStatus } from "@/lib/agents/types";

/**
 * Derivation at a realistic size.
 *
 * The shape §32 asks for: 1 agent, 10 runs, 100 work items, 100 artifacts,
 * 500 tabs. Built deterministically, with no randomness and no clock, so the
 * same run happens on every machine.
 *
 * What this asserts is **correctness at scale first** and cost second. A
 * timing assertion alone would pass for an implementation that returned the
 * wrong answer quickly, so the totals are checked against the fixture's known
 * composition, and only then is the work bounded.
 *
 * The timing bound is deliberately loose. It exists to catch an accidental
 * quadratic — the O(runs x items x artifacts) shape the brief warns about —
 * not to police milliseconds on a loaded CI box.
 */

const RUNS = 10;
const WORK_ITEMS_PER_RUN = 10;
const ARTIFACTS_PER_RUN = 10;
const TABS_PER_RUN = 50;

const STATUS_CYCLE: AgentWorkItemStatus[] = [
  "pending",
  "active",
  "blocked",
  "completed",
  "cancelled",
];

/** 10 runs x (10 items + 10 files + 50 tabs) in one workspace. */
function largeWorkspace(): { state: AgentState; runIds: string[] } {
  const base = withAgent();
  let state: AgentState = base.state;
  const runIds: string[] = [];

  for (let r = 0; r < RUNS; r += 1) {
    const run = withRun(
      state,
      {
        agentId: base.agentId,
        workspaceId: "w1",
        status: r % 2 === 0 ? "working" : "completed",
        title: `Run ${r}`,
      },
      T0 + r * 10_000
    );
    state = run.state;
    runIds.push(run.runId);

    for (let i = 0; i < WORK_ITEMS_PER_RUN; i += 1) {
      state = withWorkItem(
        state,
        {
          runId: run.runId,
          title: `Run ${r} task ${i}`,
          status: STATUS_CYCLE[i % STATUS_CYCLE.length],
        },
        T0 + r * 10_000 + i * 10
      ).state;
    }

    for (let a = 0; a < ARTIFACTS_PER_RUN; a += 1) {
      state = withArtifact(
        state,
        { runId: run.runId, path: `src/run-${r}/file-${a}.ts`, role: "edited" },
        T0 + r * 10_000 + a * 10
      ).state;
    }

    for (let t = 0; t < TABS_PER_RUN; t += 1) {
      state = withTabLink(
        state,
        {
          runId: run.runId,
          tabId: `tab-${r}-${t}`,
          role: t % 2 === 0 ? "context" : "produced",
        },
        T0 + r * 10_000 + t
      );
    }
  }

  return { state, runIds };
}

describe("a large workspace", () => {
  it("builds the fixture the assertions assume", () => {
    const { state } = largeWorkspace();

    expect(state.runs).toHaveLength(RUNS);
    expect(state.workItems).toHaveLength(RUNS * WORK_ITEMS_PER_RUN);
    expect(state.artifacts).toHaveLength(RUNS * ARTIFACTS_PER_RUN);
    expect(state.links).toHaveLength(RUNS * TABS_PER_RUN);
  });

  it("derives correct totals across every run", () => {
    const { state, runIds } = largeWorkspace();
    const index = buildAgentDomainIndex(state);

    expect(getWorkItemsForWorkspace(index, "w1")).toHaveLength(RUNS * WORK_ITEMS_PER_RUN);

    for (const runId of runIds) {
      const summary = getAgentRunSummary(index, runId)!;
      expect(summary.workItems.total).toBe(WORK_ITEMS_PER_RUN);
      expect(summary.artifactCount).toBe(ARTIFACTS_PER_RUN);
      expect(summary.contextTabCount).toBe(TABS_PER_RUN / 2);
      expect(summary.producedTabCount).toBe(TABS_PER_RUN / 2);

      // Two of every five items are completed or cancelled; cancelled is
      // excluded from both sides of the ratio.
      expect(summary.progress).toEqual({ completed: 2, total: 8 });
    }
  });

  it("scopes the workspace view correctly at size", () => {
    const { state } = largeWorkspace();
    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");

    expect(activity.byStatus.working).toHaveLength(RUNS / 2);
    expect(activity.byStatus.completed).toHaveLength(RUNS / 2);
    expect(activity.activeRuns).toHaveLength(RUNS / 2);
    expect(activity.activeWorkItems).toHaveLength(RUNS * 2);
    expect(activity.blockedWorkItems).toHaveLength(RUNS * 2);
  });

  it("returns every impact edge without duplication", () => {
    const { state, runIds } = largeWorkspace();
    const index = buildAgentDomainIndex(state);
    const impact = getAgentRunImpact(index, runIds[0])!;

    expect(impact.workItems).toHaveLength(WORK_ITEMS_PER_RUN);
    expect(impact.artifacts).toHaveLength(ARTIFACTS_PER_RUN);
    expect(impact.affectedTabIds).toHaveLength(TABS_PER_RUN);
    expect(new Set(impact.affectedTabIds).size).toBe(TABS_PER_RUN);
  });

  /**
   * The anti-quadratic guard.
   *
   * Summarising every run plus building the workspace view touches each
   * relationship a constant number of times. If a selector regressed to
   * rescanning the full state per run, this fixture's ~1,600 rows across 10
   * runs would blow well past the bound.
   */
  it("derives everything in one index build plus linear work", () => {
    const { state, runIds } = largeWorkspace();

    const started = performance.now();
    const index = buildAgentDomainIndex(state);
    for (const runId of runIds) {
      getAgentRunSummary(index, runId);
      getAgentRunImpact(index, runId);
    }
    getWorkspaceAgentActivity(index, "w1");
    getWorkspaceActivityCards(index, "w1");
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(500);
  });

  it("reuses one index across many questions", () => {
    const { state, runIds } = largeWorkspace();
    const index = buildAgentDomainIndex(state);

    // Repeated derivation from a prebuilt index must stay cheap — this is the
    // React-render path, hit on every keystroke in the search box.
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      getWorkspaceActivityCards(index, "w1");
      getAgentRunSummary(index, runIds[i % runIds.length]);
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(500);
  });
});
