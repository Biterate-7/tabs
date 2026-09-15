import { describe, expect, it } from "vitest";
import { AGENT_RUN_STATUSES, LIVE_AGENT_RUN_STATUSES } from "@/lib/agents/types";
import { buildAgentDomainIndex } from "./domain-index";
import { RECENT_ARTIFACT_LIMIT, RECENT_COMPLETED_WORK_ITEM_LIMIT } from "./types";
import {
  getAgentActivityCard,
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
import type { AgentRunStatus, AgentState } from "@/lib/agents/types";

/** One run per status, all in `w1`. */
function everyStatus() {
  const base = withAgent();
  let state: AgentState = base.state;
  const runIds: Record<AgentRunStatus, string> = {} as Record<AgentRunStatus, string>;

  let offset = 0;
  for (const status of AGENT_RUN_STATUSES) {
    const run = withRun(
      state,
      { agentId: base.agentId, workspaceId: "w1", status, title: `${status} run` },
      T0 + offset
    );
    state = run.state;
    runIds[status] = run.runId;
    offset += 1_000;
  }

  return { state, runIds, agentId: base.agentId };
}

describe("status grouping", () => {
  it("partitions every run into exactly one status bucket", () => {
    const { state, runIds } = everyStatus();
    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");

    for (const status of AGENT_RUN_STATUSES) {
      expect(activity.byStatus[status].map((r) => r.runId)).toEqual([runIds[status]]);
    }

    const all = Object.values(activity.byStatus).flat();
    expect(all).toHaveLength(AGENT_RUN_STATUSES.length);
    expect(new Set(all.map((r) => r.runId)).size).toBe(AGENT_RUN_STATUSES.length);
  });

  it("presents every bucket, empty rather than absent", () => {
    const base = withAgent();
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
    });
    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(run.state), "w1");

    for (const status of AGENT_RUN_STATUSES) {
      expect(Array.isArray(activity.byStatus[status])).toBe(true);
    }
    expect(activity.byStatus.failed).toEqual([]);
  });

  it("counts working and waiting as active, matching Phase 11", () => {
    const { state, runIds } = everyStatus();
    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");

    expect(new Set(activity.activeRuns.map((r) => r.runId))).toEqual(
      new Set([runIds.working, runIds.waiting])
    );
    // Pinned against the domain constant, so a change there is caught here.
    expect([...LIVE_AGENT_RUN_STATUSES].sort()).toEqual(["waiting", "working"]);
  });

  it("does not treat blocked as active, nor as completed", () => {
    const { state, runIds } = everyStatus();
    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");

    expect(activity.activeRuns.map((r) => r.runId)).not.toContain(runIds.blocked);
    expect(activity.byStatus.completed.map((r) => r.runId)).not.toContain(runIds.blocked);
    expect(activity.byStatus.blocked.map((r) => r.runId)).toEqual([runIds.blocked]);
  });

  it("keeps waiting distinct from blocked", () => {
    const { state, runIds } = everyStatus();
    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");

    expect(activity.byStatus.waiting.map((r) => r.runId)).toEqual([runIds.waiting]);
    expect(activity.byStatus.waiting.map((r) => r.runId)).not.toContain(runIds.blocked);
  });
});

describe("work item views", () => {
  it("separates active from blocked work", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    let state = withWorkItem(run.state, {
      runId: run.runId,
      title: "Doing this",
      status: "active",
    }).state;
    state = withWorkItem(state, { runId: run.runId, title: "Stuck", status: "blocked" }).state;
    state = withWorkItem(state, { runId: run.runId, title: "Later", status: "pending" }).state;

    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");
    expect(activity.activeWorkItems.map((i) => i.title)).toEqual(["Doing this"]);
    expect(activity.blockedWorkItems.map((i) => i.title)).toEqual(["Stuck"]);
  });

  it("orders completed work most recently finished first, and bounds it", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });

    let state: AgentState = run.state;
    const count = RECENT_COMPLETED_WORK_ITEM_LIMIT + 5;
    for (let i = 0; i < count; i += 1) {
      state = withWorkItem(
        state,
        { runId: run.runId, title: `Task ${i}`, status: "completed" },
        T0 + i * 1_000
      ).state;
    }

    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");
    expect(activity.recentlyCompletedWorkItems).toHaveLength(RECENT_COMPLETED_WORK_ITEM_LIMIT);
    // The newest is the highest-numbered task.
    expect(activity.recentlyCompletedWorkItems[0].title).toBe(`Task ${count - 1}`);

    const times = activity.recentlyCompletedWorkItems.map((i) => i.completedAt ?? i.updatedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("bounds recently touched files", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });

    let state: AgentState = run.state;
    for (let i = 0; i < RECENT_ARTIFACT_LIMIT + 6; i += 1) {
      state = withArtifact(
        state,
        { runId: run.runId, path: `src/file-${i}.ts`, role: "edited" },
        T0 + i * 1_000
      ).state;
    }

    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");
    expect(activity.recentlyTouchedArtifacts).toHaveLength(RECENT_ARTIFACT_LIMIT);
  });
});

describe("last activity", () => {
  it("is the newest evidence anywhere in the workspace", () => {
    const base = withAgent();
    const early = withRun(
      base.state,
      { agentId: base.agentId, workspaceId: "w1", status: "completed" },
      T0
    );
    const late = withRun(
      early.state,
      { agentId: base.agentId, workspaceId: "w1", status: "working" },
      T0 + 500_000
    );

    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(late.state), "w1");
    expect(activity.lastActivityAt).toBe(T0 + 500_000);
  });

  it("is absent for a workspace with no agent work", () => {
    const activity = getWorkspaceAgentActivity(buildAgentDomainIndex(withAgent().state), "w1");
    expect(activity.lastActivityAt).toBeUndefined();
  });
});

describe("activity cards", () => {
  it("composes the summary with the resolved agent identity", () => {
    const base = withAgent("Claude Code", "claude-code");
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
      title: "Auth work",
    });
    let state = withWorkItem(run.state, {
      runId: run.runId,
      title: "Implement authentication",
      status: "active",
    }).state;
    state = withWorkItem(state, { runId: run.runId, title: "Add tests", status: "completed" })
      .state;
    state = withArtifact(state, { runId: run.runId, path: "src/auth.ts", role: "edited" }).state;
    state = withTabLink(state, { runId: run.runId, tabId: "t1", role: "context" });

    const card = getAgentActivityCard(buildAgentDomainIndex(state), "w1", run.runId)!;

    expect(card.label).toBe("Auth work");
    expect(card.agentName).toBe("Claude Code");
    expect(card.provider).toBe("claude-code");
    expect(card.status).toBe("working");
    expect(card.primaryWorkItem?.title).toBe("Implement authentication");
    expect(card.progress).toEqual({ completed: 1, total: 2 });
    expect(card.artifactCount).toBe(1);
    expect(card.contextTabCount).toBe(1);
    expect(card.producedTabCount).toBe(0);
  });

  it("falls back to the agent name for an untitled run, never a session id", () => {
    const base = withAgent("Claude Code");
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const card = getAgentActivityCard(buildAgentDomainIndex(run.state), "w1", run.runId)!;

    expect(card.label).toBe("Claude Code");
    expect(card).not.toHaveProperty("externalId");
  });

  it("degrades honestly when the agent is gone", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    // An agent deleted out from under its run — a race, not a crash.
    const orphaned: AgentState = { ...run.state, agents: [] };

    const card = getAgentActivityCard(buildAgentDomainIndex(orphaned), "w1", run.runId)!;
    expect(card.agentName).toBe("Agent");
    expect(card.provider).toBe("");
    expect(card.label).toBe("Agent run");
  });

  it("omits progress and primary item for a run with no observed plan", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const card = getAgentActivityCard(buildAgentDomainIndex(run.state), "w1", run.runId)!;

    expect(card.progress).toBeUndefined();
    expect(card.primaryWorkItem).toBeUndefined();
    expect(card.workItems.total).toBe(0);
  });

  it("returns one card per run, newest run first", () => {
    const { state, runIds } = everyStatus();
    const cards = getWorkspaceActivityCards(buildAgentDomainIndex(state), "w1");

    expect(cards).toHaveLength(AGENT_RUN_STATUSES.length);
    // `cancelled` was created last, so it sorts first.
    expect(cards[0].runId).toBe(runIds[AGENT_RUN_STATUSES[AGENT_RUN_STATUSES.length - 1]]);
  });
});

describe("empty states are distinguishable", () => {
  it("tells a workspace with no agents from one with agents but no work", () => {
    const noAgents = getWorkspaceAgentActivity(buildAgentDomainIndex(withAgent().state), "w1");
    expect(noAgents.byStatus.working).toEqual([]);
    expect(noAgents.activeRuns).toEqual([]);
    expect(noAgents.lastActivityAt).toBeUndefined();

    const base = withAgent();
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
    });
    const withRunNoWork = getWorkspaceAgentActivity(buildAgentDomainIndex(run.state), "w1");

    // A run exists, so the workspace is not empty...
    expect(withRunNoWork.activeRuns).toHaveLength(1);
    expect(withRunNoWork.lastActivityAt).toBeDefined();
    // ...but no work items were observed, which is a different absence.
    expect(withRunNoWork.activeWorkItems).toEqual([]);
    expect(withRunNoWork.recentlyCompletedWorkItems).toEqual([]);
  });

  it("tells work with no files from files with no work", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });

    const workOnly = withWorkItem(run.state, {
      runId: run.runId,
      title: "Planning",
      status: "active",
    });
    const a = getWorkspaceAgentActivity(buildAgentDomainIndex(workOnly.state), "w1");
    expect(a.activeWorkItems).toHaveLength(1);
    expect(a.recentlyTouchedArtifacts).toEqual([]);

    const filesOnly = withArtifact(run.state, {
      runId: run.runId,
      path: "src/x.ts",
      role: "edited",
    });
    const b = getWorkspaceAgentActivity(buildAgentDomainIndex(filesOnly.state), "w1");
    expect(b.activeWorkItems).toEqual([]);
    expect(b.recentlyTouchedArtifacts).toHaveLength(1);
  });
});
